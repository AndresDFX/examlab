"""
AWS Lambda handler — compila y ejecuta código del estudiante (Java o Python).

Invocado vía API Gateway HTTP API. Los edge functions de Supabase
(`execute-code`, `execute-java-gui-screenshot`, `execute-python-gui-screenshot`)
llaman el endpoint con shared secret en `X-API-Key`.

Modos (en el body, campo `mode`):
 - `run` (default): ejecuta código por consola. El `language` del body
   determina el toolchain:
     - `language='java'` (default): javac + java.
     - `language='python'`: python3 (AL2023 system python, /usr/bin/python3).
   Retorna stdout/stderr/exitCode. Es lo que usa una pregunta tipo
   `codigo` cuando el admin elige AWS Lambda como provider.
 - `gui_screenshot`: arranca Xvfb en :99, compila + ejecuta Java con
   DISPLAY=:99 en background, duerme `delayMs` para que Swing pinte,
   captura el framebuffer raw a PNG y lo retorna en base64. Es lo
   que usa una pregunta tipo `java_gui` cuando el admin configuró
   `java_gui_provider = aws_screenshot`. NO es interactivo — el alumno
   solo ve la captura, no puede clickear.
 - `tkinter_screenshot`: análogo al `gui_screenshot` de Java pero para
   tkinter. Arranca Xvfb, corre el código del estudiante a través de
   `TkinterBootstrap.py` (wrapper que monkey-patchea `Tk.__init__` para
   auto-destruir la ventana tras `sleepMs`), captura el framebuffer y
   retorna PNG base64. Usado en preguntas tipo `python_gui`.

Seguridad:
 - Lambda corre en Firecracker microVM (sandbox real por invocación).
 - IAM role del Lambda NO tiene permisos AWS — el código del alumno
   no puede llamar S3, DynamoDB, etc.
 - Sin VPC attachment — sin acceso a tu infra.
 - Timeout duro (Lambda timeout + subprocess timeout en Python).
 - Memoria límite (Lambda OOM-kill si pasa el cap).
 - Tamaño máx del código limitado para evitar bombs.
 - En modo gui_screenshot el proceso Java se mata explícitamente con
   SIGKILL después del screenshot, antes de salir del handler.
"""

import base64
import json
import logging
import os
import re
import subprocess
import tempfile
import time

# Logger estructurado para CloudWatch. Cada invocación deja huella del
# request (source code truncado, length, stdin) y del response (exit
# code, time, primeros chars de stdout/stderr). Útil para diagnosticar
# casos puntuales del alumno sin tener que reproducir local.
#
# Para ver los logs:
#   aws logs tail /aws/lambda/examlab-code-runner --follow --region us-east-1
#
# o desde la consola AWS → CloudWatch → Log groups →
# /aws/lambda/examlab-code-runner → cualquier log stream.
logger = logging.getLogger()
logger.setLevel(logging.INFO)


def _log_preview(label: str, value: str, max_chars: int = 500) -> None:
    """Imprime un campo largo truncado de forma estructurada. CloudWatch
    indexa cada línea por separado, así que separar reduce ruido al filtrar."""
    if not value:
        logger.info("[%s] (vacío)", label)
        return
    if len(value) <= max_chars:
        logger.info("[%s] %s", label, value)
    else:
        logger.info(
            "[%s] (truncado a %d chars de %d) %s",
            label,
            max_chars,
            len(value),
            value[:max_chars],
        )

# Shared secret — el cliente debe mandarlo en X-API-Key. Si la env var
# está vacía rechazamos TODAS las llamadas para evitar despliegues
# accidentales sin auth.
API_KEY = os.environ.get("API_KEY", "")

# Timeouts en segundos. En warm (container ya inicializado) javac
# compila <2s. En cold start con 1 vCPU (1769 MB) la primera invocación
# del día puede tardar 8-12s solo en cargar el container + JVM init.
# Combinados deben caber en el timeout de Lambda (50s por CF default).
COMPILE_TIMEOUT_S = 25
EXECUTE_TIMEOUT_S = 20
MAX_SOURCE_BYTES = 100_000  # 100 KB
MAX_STDIN_BYTES = 10_000

# ── GUI screenshot mode ──
# Display virtual donde corre Xvfb. :99 es la convención típica (no
# colisiona con :0/:1 que algunos hosts/CI usan).
GUI_DISPLAY = ":99"
# Tamaño del framebuffer virtual. 800x600 da buena proporción para
# JFrames típicos de estudiantes (300x200 a 500x400) — ocupan ~25-50%
# del frame, suficiente para leer el contenido. Antes era 1024x768
# pero los JFrames pequeños se veían perdidos en una esquina del card
# de captura. Si la JFrame es más grande, X la corta — el alumno verá
# parte de la UI cortada (mismo que pasa en un monitor pequeño).
GUI_SCREEN = "800x600x24"
# Dimensiones desempacadas — se usan al convertir el framebuffer raw
# a PNG (necesita -size WxH para interpretar los bytes).
GUI_WIDTH = 800
GUI_HEIGHT = 600
# Ventana de tiempo (ms) entre que arrancamos la JVM y hacemos la
# captura. Swing tarda en pintar la primera frame: ~500ms warm,
# ~2000-3000ms cold (JVM init + Toolkit init + EDT pump). 3500ms le
# da margen para que Swing termine antes de la captura. El cliente
# puede pedir más con `delayMs` (cap a 8s para no agotar el Lambda
# timeout de 50s).
GUI_DEFAULT_DELAY_MS = 3500
GUI_MAX_DELAY_MS = 8000
# Tope de tamaño del PNG retornado. 1024x768x24 limpio comprime a
# ~50-200KB; le damos margen.
GUI_MAX_PNG_BYTES = 2_000_000

# Captura del nombre de la clase pública para invocar `java <Name>`.
# Si no encuentra, asume `Main` (convención del editor del alumno).
CLASS_RE = re.compile(r"public\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)")

# ── Python runner ─────────────────────────────────────────────────────
# Python del estudiante corre con el `python3` que ofrece AL2023 (instalado
# vía dnf en el Dockerfile junto con `python3-tkinter`). NO usamos el Python
# bundled del Lambda runtime (/var/lang/bin/python3.13) porque ese no tiene
# `tkinter` — Amazon Lambda compila su Python sin Tk/Tcl. La JVM y el
# binario `python3` AL2023 conviven sin choque (rutas distintas).
PYTHON_BIN = "/usr/bin/python3"
# Timeout de ejecución para Python (consola). Mismo orden que Java; los
# scripts del alumno no deberían tardar más que esto.
PYTHON_EXECUTE_TIMEOUT_S = 20


def _resp(status: int, body: dict) -> dict:
    """Formato de respuesta de Lambda Function URL."""
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def _truncate(s: str, limit: int = 50_000) -> str:
    """Trunca strings largos para no inflar respuestas (ej. loops que imprimen MB)."""
    if len(s) <= limit:
        return s
    return s[:limit] + f"\n... [truncado, +{len(s) - limit} caracteres]"


def _start_xvfb() -> "subprocess.Popen[bytes]":
    """Arranca Xvfb en GUI_DISPLAY y espera a que esté listo.

    Lambda /tmp es escribible y los sockets de X (/tmp/.X11-unix/X99) caben
    ahí — pero Xvfb necesita que el directorio /tmp/.X11-unix EXISTA antes
    de arrancar (no lo crea él). En containers limpios típicamente está,
    pero Lambda /tmp arranca vacío por invocación si no es warm — lo
    creamos defensivamente con 1777 (sticky) como en /tmp.
    """
    # Xvfb falla con "Could not create server socket" si /tmp/.X11-unix
    # no existe. mkdir(exist_ok=True) es idempotente entre invocaciones
    # warm (donde el dir ya quedó del run anterior).
    try:
        os.makedirs("/tmp/.X11-unix", mode=0o1777, exist_ok=True)
        # makedirs respeta umask — forzamos chmod para garantizar sticky+w.
        os.chmod("/tmp/.X11-unix", 0o1777)
    except OSError as e:
        raise RuntimeError(f"No se pudo crear /tmp/.X11-unix: {e}") from e

    # Stderr de Xvfb se redirige a un archivo en /tmp para poder leerlo
    # si arranca mal. Antes íbamos a DEVNULL y al fallar Xvfb el error
    # quedaba invisible ("Xvfb murió en arranque (exit 1)" sin contexto).
    xvfb_log = "/tmp/xvfb.log"
    log_fd = open(xvfb_log, "wb")
    # +extension RANDR y -nolisten tcp evitan que Java intente abrir un
    # socket TCP (Lambda no permite listening sockets externos pero Xvfb
    # los abre por default y puede colgarse). -ac desactiva access control
    # para no necesitar xauth (corre todo en el mismo container).
    p = subprocess.Popen(
        [
            "Xvfb",
            GUI_DISPLAY,
            "-screen",
            "0",
            GUI_SCREEN,
            "-ac",
            "-nolisten",
            "tcp",
            "+extension",
            "RANDR",
            "-fbdir",
            "/tmp",
        ],
        stdout=log_fd,
        stderr=subprocess.STDOUT,
    )
    # Espera activa por el socket de X. xdpyinfo/xwininfo no están
    # instalados — usamos el archivo socket directamente.
    socket_path = f"/tmp/.X11-unix/X{GUI_DISPLAY.lstrip(':')}"
    deadline = time.time() + 5.0
    while time.time() < deadline:
        if os.path.exists(socket_path):
            return p
        if p.poll() is not None:
            log_fd.close()
            stderr_msg = ""
            try:
                with open(xvfb_log, "r", encoding="utf-8", errors="replace") as fh:
                    stderr_msg = fh.read().strip()
            except OSError:
                pass
            raise RuntimeError(
                f"Xvfb murió en arranque (exit {p.returncode})"
                + (f" — log:\n{stderr_msg}" if stderr_msg else "")
            )
        time.sleep(0.05)
    # Timeout — capturamos lo que haya escrito en stderr para diagnóstico.
    log_fd.close()
    stderr_msg = ""
    try:
        with open(xvfb_log, "r", encoding="utf-8", errors="replace") as fh:
            stderr_msg = fh.read().strip()
    except OSError:
        pass
    _kill_quiet(p)
    raise RuntimeError(
        "Xvfb no abrió socket en 5s"
        + (f" — log:\n{stderr_msg}" if stderr_msg else "")
    )


def _kill_quiet(p: "subprocess.Popen[bytes]") -> None:
    """Termina un Popen ignorando errores (ya muerto, race, etc.)."""
    try:
        p.kill()
    except Exception:
        pass
    try:
        p.wait(timeout=2)
    except Exception:
        pass


def _handle_gui_screenshot(
    source: str,
    main_class: str,
    delay_ms: int,
    request_id: str,
    start: float,
    framework: str = "swing",
) -> dict:
    """Compila + ejecuta Java con DISPLAY=Xvfb y retorna captura PNG base64.

    Soporta dos frameworks GUI:
      - "swing" (default): JDK base, wrapper GuiBootstrap. No requiere
        flags adicionales — AWT/Swing pintan directo contra Xvfb.
      - "javafx": OpenJFX 21 (instalado en /opt/javafx-sdk-21). Requiere
        `--module-path` + `--add-modules` + flags Prism para forzar
        rendering por software (Lambda no tiene GPU). Wrapper
        `JavaFxBootstrap` detecta si la clase del estudiante extiende
        `Application` y usa `Application.launch()` en vez de `main()`.

    Flow:
      1. Arrancar Xvfb en :99.
      2. javac con classpath/module-path según framework.
      3. java -cp tmp <Bootstrap> en BACKGROUND con DISPLAY=:99.
      4. Sleep delay_ms (para que Swing/FX pinten).
      5. Leer framebuffer raw de Xvfb → PNG via Pillow.
      6. Kill JVM + Xvfb.
      7. Base64-encode PNG y retornar.
    """
    # Cap defensivo del delay para no agotar el timeout de Lambda.
    delay_ms = max(200, min(GUI_MAX_DELAY_MS, delay_ms))

    # Normalizar framework (defensivo — los callers deberían pasar uno
    # válido pero no asumimos). "swing" es el default histórico.
    framework = (framework or "swing").lower().strip()
    if framework not in ("swing", "javafx"):
        framework = "swing"
    is_javafx = framework == "javafx"

    # Path al SDK de OpenJFX (instalado en /opt/javafx-sdk-21 por el
    # Dockerfile). Módulos cargados:
    #   javafx.controls — Button, Label, TableView, etc.
    #   javafx.fxml — para FXMLLoader (UI declarativa).
    #   javafx.graphics — Scene, Stage, Application; transitivamente
    #     pulled por controls, pero lo listamos explícito por claridad.
    JAVAFX_HOME = "/opt/javafx-sdk-21"
    JAVAFX_MODULES = "javafx.controls,javafx.fxml,javafx.graphics"

    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        source_path = os.path.join(tmp, f"{main_class}.java")
        with open(source_path, "w", encoding="utf-8") as f:
            f.write(source)

        # ── Compilar ──
        # Swing: javac base sin flags extra.
        # JavaFX: agregar --module-path + --add-modules para que el
        # student code pueda hacer `import javafx.application.Application`.
        compile_cmd = ["javac", "-encoding", "UTF-8", "-d", tmp]
        if is_javafx:
            compile_cmd += [
                "--module-path", f"{JAVAFX_HOME}/lib",
                "--add-modules", JAVAFX_MODULES,
            ]
        compile_cmd.append(source_path)
        try:
            compile_proc = subprocess.run(
                compile_cmd,
                capture_output=True,
                text=True,
                timeout=COMPILE_TIMEOUT_S,
                cwd=tmp,
            )
        except subprocess.TimeoutExpired:
            return {
                "mode": "gui_screenshot",
                "stdout": "",
                "stderr": f"Compilación excedió el tiempo límite ({COMPILE_TIMEOUT_S}s).",
                "exitCode": 124,
                "screenshotBase64": None,
                "executionTimeMs": int((time.time() - start) * 1000),
            }

        if compile_proc.returncode != 0:
            stderr_text = _truncate(compile_proc.stderr or "Error de compilación")
            logger.info(
                "◀ RESPONSE id=%s phase=gui_compile_error exit=%d time_ms=%d",
                request_id,
                compile_proc.returncode,
                int((time.time() - start) * 1000),
            )
            _log_preview("RESPONSE.compile_stderr", stderr_text, max_chars=1000)
            return {
                "mode": "gui_screenshot",
                "stdout": "",
                "stderr": stderr_text,
                "exitCode": compile_proc.returncode,
                "screenshotBase64": None,
                "executionTimeMs": int((time.time() - start) * 1000),
            }

        # ── Arrancar Xvfb ──
        try:
            xvfb_proc = _start_xvfb()
        except Exception as e:
            return {
                "mode": "gui_screenshot",
                "stdout": "",
                "stderr": f"No se pudo iniciar Xvfb: {e}",
                "exitCode": 1,
                "screenshotBase64": None,
                "executionTimeMs": int((time.time() - start) * 1000),
            }

        # ── Ejecutar Java en background con DISPLAY ──
        # -Djava.awt.headless=false: por si la JVM detecta automáticamente
        # ausencia de DISPLAY y se pone headless. Con Xvfb arriba sí hay
        # DISPLAY, pero el flag explícito previene sorpresas.
        # -Xmx512m: techo de heap para evitar OOM-kill de Lambda.
        #
        # IMPORTANTE — auto-sleep para que el alumno no escriba Thread.sleep:
        # Invocamos `GuiBootstrap` (pre-compilado en /opt/ durante el build)
        # en vez de `<main_class>` directamente. GuiBootstrap usa reflection
        # para llamar al `main` del estudiante y luego duerme `sleepMs` ms
        # antes de salir. Eso mantiene la JVM viva el tiempo necesario para
        # que Swing termine de pintar — sin pedirle al estudiante que ponga
        # un `Thread.sleep` final que no tiene nada que ver con la pregunta.
        # Si el `main` del estudiante lanza, GuiBootstrap imprime el stack
        # a stderr y sale con code 2 — lo capturamos en stderr_str después.
        #
        # `sleepMs` se ata a delay_ms para que JVM y captura terminen casi
        # al mismo tiempo. Le restamos 200ms para que la JVM tenga margen
        # para hacer System.exit(0) antes de que matemos el proceso.
        env = os.environ.copy()
        env["DISPLAY"] = GUI_DISPLAY
        bootstrap_sleep_ms = max(500, delay_ms - 200)
        # Construir el comando java según el framework.
        # Comunes:
        #   -Djava.awt.headless=false (Swing) / -Dprism.* (JavaFX)
        #   -Dexamlab.gui.mainClass=<student class>
        #   -Dexamlab.gui.sleepMs=<delay - 200ms margen>
        #   -Xmx512m (cap heap para no OOM Lambda)
        #
        # Wrapper:
        #   Swing → GuiBootstrap (invoca main() por reflection)
        #   JavaFX → JavaFxBootstrap (detecta Application subclass y
        #            usa Application.launch en hilo daemon)
        if is_javafx:
            # Prism flags CRÍTICOS para que JavaFX corra en Lambda:
            #   prism.order=sw — force software renderer. SIN esto FX
            #     intenta OpenGL/D3D y crashea en Lambda (sin GPU).
            #   prism.lcdtext=false — LCD subpixel text rendering
            #     requiere acceso al display HW; en SW mode forzamos
            #     greyscale.
            #   prism.text=t2k — T2K text renderer es más estable bajo
            #     headless que el default (que intenta usar libraries
            #     nativas que no están en Lambda).
            #   glass.platform=gtk — fuerza GTK glass (el default en
            #     Linux); evita que intente "monocle" sin que esté.
            java_proc = subprocess.Popen(
                [
                    "java",
                    "--module-path", f"{JAVAFX_HOME}/lib",
                    "--add-modules", JAVAFX_MODULES,
                    "-Dprism.order=sw",
                    "-Dprism.lcdtext=false",
                    "-Dprism.text=t2k",
                    "-Dglass.platform=gtk",
                    "-Djava.awt.headless=false",
                    f"-Dexamlab.gui.mainClass={main_class}",
                    f"-Dexamlab.gui.sleepMs={bootstrap_sleep_ms}",
                    "-Xmx512m",
                    "-cp",
                    f"{tmp}:/opt",
                    "JavaFxBootstrap",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
        else:
            # Swing/AWT — JRE base, sin module-path. GuiBootstrap invoca
            # main(String[]) del estudiante por reflection.
            java_proc = subprocess.Popen(
                [
                    "java",
                    "-Djava.awt.headless=false",
                    f"-Dexamlab.gui.mainClass={main_class}",
                    f"-Dexamlab.gui.sleepMs={bootstrap_sleep_ms}",
                    "-Xmx512m",
                    "-cp",
                    f"{tmp}:/opt",
                    "GuiBootstrap",
                ],
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )

        # Espera SIEMPRE el delay completo. Antes rompíamos el loop
        # apenas la JVM terminaba (early_exit) y capturábamos
        # inmediatamente — eso causaba el bug "captura vacía" cuando
        # el código del estudiante hace:
        #
        #   SwingUtilities.invokeLater(() -> { JFrame ... });
        #   // main termina aquí → JVM sale antes de que el EDT pinte
        #
        # `invokeLater` es ASÍNCRONO: encola el Runnable en el Event
        # Dispatch Thread y retorna. Si `main` no espera (Thread.sleep,
        # invokeAndWait, JOptionPane.showMessageDialog, etc.), la JVM
        # se cierra antes de que el EDT procese el Runnable, y Xvfb
        # queda con su framebuffer vacío (frame negro de ~3-4KB).
        #
        # Fix: ya no rompemos el wait. Esperamos delayMs completos:
        #  - Si Java sigue corriendo: Swing pinta y Xvfb actualiza
        #    el framebuffer.
        #  - Si Java murió pero alcanzó a pintar antes: el framebuffer
        #    mantiene la última frame pintada (Xvfb no la borra al
        #    desconectar el cliente). Capturamos eso.
        #  - Si Java murió sin pintar nada: el framebuffer queda
        #    vacío. La condición `pngBytes < 4000` del cliente lo
        #    detecta y muestra mensaje "agrega Thread.sleep al final
        #    de main".
        #
        # Loggeamos si la JVM terminó temprano para diagnóstico
        # (early_exit != None) sin afectar el flujo.
        deadline = time.time() + (delay_ms / 1000.0)
        early_exit = None
        while time.time() < deadline:
            rc = java_proc.poll()
            if rc is not None and early_exit is None:
                early_exit = rc
                # NO break — seguimos esperando que se cumpla el
                # deadline para que Swing termine de pintar (si
                # alcanzó a empezar) o para que el framebuffer
                # quede estable antes de capturar.
            time.sleep(0.05)

        # ── Capturar screenshot (framebuffer raw → PNG con Pillow) ──
        # Historia de iteraciones que no funcionaron antes de Pillow:
        #   1. `import -window root` (ImageMagick): se colgaba > 10s
        #      inicializando MIT-SHM (Lambda no expone /dev/shm completo).
        #   2. `xwd | convert`: xwd vive en `xorg-x11-apps`, paquete que
        #      NO existe en el repo de Amazon Linux 2023.
        #   3. `convert -size WxH -depth 8 BGRA:- out.png` leyendo el
        #      framebuffer raw: convert se colgaba codificando PNG —
        #      probablemente la policy.xml de ImageMagick (AL2023
        #      restringe coders raw por CVE-2016-3714) o el pipe stdin
        #      con 3MB atascándose en el sandbox.
        #
        # Solución actual: leer `/tmp/Xvfb_screen0` (framebuffer mmap de
        # Xvfb arrancado con `-fbdir /tmp`) y codificar a PNG con Pillow
        # IN-PROCESS. Sin subprocess, sin ImageMagick, sin policy.xml,
        # sin shell, sin pipes. PIL convierte BGRA → RGBA y codifica
        # PNG en una sola llamada.
        screenshot_path = os.path.join(tmp, "screenshot.png")
        fb_path = "/tmp/Xvfb_screen0"
        capture_ok = False
        capture_err = ""
        expected_bytes = GUI_WIDTH * GUI_HEIGHT * 4
        try:
            if not os.path.exists(fb_path):
                capture_err = (
                    f"Xvfb no creó el framebuffer en {fb_path} — "
                    "verifica que arrancó con '-fbdir /tmp'."
                )
            else:
                fb_size = os.path.getsize(fb_path)
                if fb_size < expected_bytes:
                    capture_err = (
                        f"Framebuffer truncado: {fb_size} bytes, "
                        f"esperaba >= {expected_bytes} ({GUI_WIDTH}x{GUI_HEIGHT}x4 BGRA)."
                    )
                else:
                    with open(fb_path, "rb") as fh:
                        fb_data = fh.read(expected_bytes)
                    # Lectura como RGB con padding "BGRX" — Xvfb depth-24
                    # usa 4 bytes por pixel (B, G, R, X) donde X es el
                    # byte de padding del slot alpha pero NO un valor
                    # alpha válido. Antes leíamos como RGBA con "BGRA" y
                    # Pillow interpretaba ese padding como canal alpha:
                    # los píxeles del Xvfb con X=0 quedaban transparentes
                    # → el visor del cliente mostraba el checkerboard a
                    # través de la ventana Swing (PNG con canal alfa
                    # preservado en background blanco).
                    # Forzando "BGRX" descartamos el byte de padding y
                    # el PNG resultante es RGB sólido — todo opaco.
                    # Import diferido para que el modo `run` (que no
                    # toca GUI) no pague el costo de cargar PIL.
                    from PIL import Image  # noqa: PLC0415
                    img = Image.frombytes(
                        "RGB",
                        (GUI_WIDTH, GUI_HEIGHT),
                        fb_data,
                        "raw",
                        "BGRX",
                    )
                    img.save(screenshot_path, "PNG", optimize=True)
                    capture_ok = os.path.exists(screenshot_path)
                    if not capture_ok:
                        capture_err = "Pillow no creó el archivo PNG de salida"
        except OSError as e:
            capture_err = f"Error de I/O leyendo framebuffer: {e}"
        except Exception as e:  # noqa: BLE001
            # PIL puede tirar excepciones varias (ValueError por size
            # mismatch, etc.). Capturamos todo para que un bug en la
            # captura no tumbe la respuesta del Lambda.
            capture_err = f"Pillow PNG encode failed: {type(e).__name__}: {e}"

        # ── Cleanup: matar JVM y Xvfb ──
        # IMPORTANTE: si no matamos la JVM, sigue corriendo en background
        # del container y la próxima invocación warm la encuentra. El
        # framebuffer de Xvfb queda dirty.
        _kill_quiet(java_proc)
        _kill_quiet(xvfb_proc)

        # ── Recoger stdout/stderr de la JVM ──
        try:
            stdout_text, stderr_text = java_proc.communicate(timeout=2)
        except Exception:
            stdout_text, stderr_text = (b"", b"")
        stdout_str = _truncate(
            (stdout_text or b"").decode("utf-8", "replace"), limit=10_000
        )
        stderr_str = _truncate(
            (stderr_text or b"").decode("utf-8", "replace"), limit=10_000
        )

        time_ms = int((time.time() - start) * 1000)

        # ── Construir respuesta ──
        if not capture_ok:
            logger.warning(
                "◀ RESPONSE id=%s phase=gui_capture_failed time_ms=%d err=%s",
                request_id,
                time_ms,
                capture_err[:200],
            )
            return {
                "mode": "gui_screenshot",
                "stdout": stdout_str,
                "stderr": (
                    stderr_str
                    + "\n[runner] No se pudo capturar la pantalla: "
                    + (capture_err or "razón desconocida")
                ).strip(),
                "exitCode": early_exit if early_exit is not None else 1,
                "screenshotBase64": None,
                "executionTimeMs": time_ms,
            }

        with open(screenshot_path, "rb") as f:
            png_bytes = f.read()

        if len(png_bytes) > GUI_MAX_PNG_BYTES:
            return {
                "mode": "gui_screenshot",
                "stdout": stdout_str,
                "stderr": stderr_str
                + f"\n[runner] PNG demasiado grande ({len(png_bytes)} bytes)",
                "exitCode": 1,
                "screenshotBase64": None,
                "executionTimeMs": time_ms,
            }

        b64 = base64.b64encode(png_bytes).decode("ascii")
        logger.info(
            "◀ RESPONSE id=%s phase=gui_ok time_ms=%d png_bytes=%d early_exit=%s",
            request_id,
            time_ms,
            len(png_bytes),
            str(early_exit),
        )
        return {
            "mode": "gui_screenshot",
            "stdout": stdout_str,
            "stderr": stderr_str,
            # Si la JVM terminó sola antes del delay con exit != 0,
            # propagamos ese exit para que el cliente sepa que algo
            # falló (NPE, etc.) aunque tengamos screenshot del Xvfb vacío.
            "exitCode": early_exit if early_exit is not None else 0,
            "screenshotBase64": b64,
            "pngBytes": len(png_bytes),
            "executionTimeMs": time_ms,
        }


def _handle_python_run(
    source: str,
    stdin: str,
    request_id: str,
    start: float,
) -> dict:
    """Ejecuta código Python del estudiante con subprocess + timeout.

    Análogo a la rama `run` con `language='java'` pero sin compilación —
    Python se interpreta directamente. Usamos el `python3` del sistema
    AL2023 (instalado en el Dockerfile junto con `python3-tkinter`) en
    lugar del bundled Lambda Python 3.13 porque ese no incluye tkinter
    (Amazon Lambda lo compila sin Tk/Tcl). Para el modo `run` no
    necesitamos tkinter pero usamos el mismo binario para que el
    comportamiento sea idéntico entre `run` y `tkinter_screenshot` (misma
    versión de Python, mismo PATH, mismas dependencias instaladas).

    -u (unbuffered): garantiza que stdout/stderr lleguen antes del kill
    por timeout. Sin esto un script con bucle largo + prints podía
    aparecer vacío en la respuesta aunque hubiera generado output.
    """
    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        source_path = os.path.join(tmp, "main.py")
        with open(source_path, "w", encoding="utf-8") as f:
            f.write(source)
        try:
            proc = subprocess.run(
                [PYTHON_BIN, "-u", source_path],
                input=stdin,
                capture_output=True,
                text=True,
                timeout=PYTHON_EXECUTE_TIMEOUT_S,
                cwd=tmp,
            )
            stdout_text = _truncate(proc.stdout or "")
            stderr_text = _truncate(proc.stderr or "")
            time_ms = int((time.time() - start) * 1000)
            logger.info(
                "◀ RESPONSE id=%s phase=python_executed exit=%d time_ms=%d stdout_len=%d stderr_len=%d",
                request_id,
                proc.returncode,
                time_ms,
                len(stdout_text),
                len(stderr_text),
            )
            _log_preview("RESPONSE.stdout", stdout_text, max_chars=2000)
            if stderr_text:
                _log_preview("RESPONSE.stderr", stderr_text, max_chars=1000)
            return {
                "stdout": stdout_text,
                "stderr": stderr_text,
                "exitCode": proc.returncode,
                "executionTimeMs": time_ms,
            }
        except subprocess.TimeoutExpired:
            logger.warning(
                "◀ RESPONSE id=%s phase=python_execute_timeout time_ms=%d",
                request_id,
                PYTHON_EXECUTE_TIMEOUT_S * 1000,
            )
            return {
                "stdout": "",
                "stderr": (
                    f"Ejecución excedió el tiempo límite ({PYTHON_EXECUTE_TIMEOUT_S}s). "
                    "¿Bucle infinito o input que nunca recibe stdin?"
                ),
                "exitCode": 124,
                "executionTimeMs": PYTHON_EXECUTE_TIMEOUT_S * 1000,
            }


def _handle_tkinter_screenshot(
    source: str,
    delay_ms: int,
    request_id: str,
    start: float,
) -> dict:
    """Ejecuta código tkinter del estudiante con Xvfb y retorna captura PNG.

    Mismo flujo que `_handle_gui_screenshot` para Java pero con un wrapper
    Python (`TkinterBootstrap.py`) en lugar de `GuiBootstrap.java`. El
    wrapper monkey-patchea `tkinter.Tk.__init__` para programar un
    `after(sleepMs, destroy)` automáticamente — el alumno NO necesita
    poner el `mainloop()` ni cerrar la ventana manualmente.

    Tkinter requiere que `mainloop()` corra para que las ventanas se
    pinten. El bootstrap se encarga: si el script del estudiante lo
    llama, perfecto; si no, el wrapper lo invoca después de ejecutar el
    código del estudiante.

    Diferencias vs Java GUI:
      - No hay compile step (Python es interpretado).
      - Solo tkinter por ahora — no extendemos a otros frameworks GUI
        de Python (PyQt, wx, kivy) por footprint del container (~+200MB
        cada uno). Si en el futuro se requieren, se añadirían como
        modes adicionales con sus propios paquetes.
    """
    delay_ms = max(200, min(GUI_MAX_DELAY_MS, delay_ms))

    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        student_path = os.path.join(tmp, "student.py")
        with open(student_path, "w", encoding="utf-8") as f:
            f.write(source)

        # ── Arrancar Xvfb ──
        try:
            xvfb_proc = _start_xvfb()
        except Exception as e:
            return {
                "mode": "tkinter_screenshot",
                "stdout": "",
                "stderr": f"No se pudo iniciar Xvfb: {e}",
                "exitCode": 1,
                "screenshotBase64": None,
                "executionTimeMs": int((time.time() - start) * 1000),
            }

        # ── Ejecutar TkinterBootstrap.py en background con DISPLAY ──
        # El bootstrap lee EXAMLAB_STUDENT_PATH del env y EXAMLAB_GUI_SLEEP_MS
        # para decidir cuándo destruir la ventana automáticamente. Estamos
        # 200ms por debajo del delay total para que el wrapper alcance a
        # llamar destroy() + retornar antes de que matemos el proceso.
        env = os.environ.copy()
        env["DISPLAY"] = GUI_DISPLAY
        env["EXAMLAB_STUDENT_PATH"] = student_path
        env["EXAMLAB_GUI_SLEEP_MS"] = str(max(500, delay_ms - 200))

        py_proc = subprocess.Popen(
            [PYTHON_BIN, "-u", "/opt/TkinterBootstrap.py"],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=tmp,
        )

        # Espera SIEMPRE el delay completo — mismo razonamiento que en
        # _handle_gui_screenshot: si el alumno no llama `mainloop()` el
        # wrapper lo hace por él, pero el framebuffer puede tardar en
        # estabilizarse. Loggeamos early_exit pero no rompemos el wait.
        deadline = time.time() + (delay_ms / 1000.0)
        early_exit = None
        while time.time() < deadline:
            rc = py_proc.poll()
            if rc is not None and early_exit is None:
                early_exit = rc
            time.sleep(0.05)

        # ── Capturar framebuffer raw → PNG con Pillow ──
        # Lógica idéntica al handler Java: leemos /tmp/Xvfb_screen0
        # (mmap del framebuffer de Xvfb con -fbdir /tmp) como BGRX y
        # codificamos a PNG in-process. Mantener la duplicación a propósito
        # — extraer a helper acoplaría dos flujos que pueden divergir en
        # el futuro (ej. resolución distinta para Python).
        screenshot_path = os.path.join(tmp, "screenshot.png")
        fb_path = "/tmp/Xvfb_screen0"
        capture_ok = False
        capture_err = ""
        expected_bytes = GUI_WIDTH * GUI_HEIGHT * 4
        try:
            if not os.path.exists(fb_path):
                capture_err = (
                    f"Xvfb no creó el framebuffer en {fb_path} — "
                    "verifica que arrancó con '-fbdir /tmp'."
                )
            else:
                fb_size = os.path.getsize(fb_path)
                if fb_size < expected_bytes:
                    capture_err = (
                        f"Framebuffer truncado: {fb_size} bytes, "
                        f"esperaba >= {expected_bytes}."
                    )
                else:
                    with open(fb_path, "rb") as fh:
                        fb_data = fh.read(expected_bytes)
                    from PIL import Image  # noqa: PLC0415
                    img = Image.frombytes(
                        "RGB",
                        (GUI_WIDTH, GUI_HEIGHT),
                        fb_data,
                        "raw",
                        "BGRX",
                    )
                    img.save(screenshot_path, "PNG", optimize=True)
                    capture_ok = os.path.exists(screenshot_path)
                    if not capture_ok:
                        capture_err = "Pillow no creó el archivo PNG de salida"
        except OSError as e:
            capture_err = f"Error de I/O leyendo framebuffer: {e}"
        except Exception as e:  # noqa: BLE001
            capture_err = f"Pillow PNG encode failed: {type(e).__name__}: {e}"

        # ── Cleanup: matar Python y Xvfb ──
        _kill_quiet(py_proc)
        _kill_quiet(xvfb_proc)

        # ── Recoger stdout/stderr del proceso Python ──
        try:
            stdout_text, stderr_text = py_proc.communicate(timeout=2)
        except Exception:
            stdout_text, stderr_text = (b"", b"")
        stdout_str = _truncate(
            (stdout_text or b"").decode("utf-8", "replace"), limit=10_000
        )
        stderr_str = _truncate(
            (stderr_text or b"").decode("utf-8", "replace"), limit=10_000
        )

        time_ms = int((time.time() - start) * 1000)

        if not capture_ok:
            logger.warning(
                "◀ RESPONSE id=%s phase=tkinter_capture_failed time_ms=%d err=%s",
                request_id,
                time_ms,
                capture_err[:200],
            )
            return {
                "mode": "tkinter_screenshot",
                "stdout": stdout_str,
                "stderr": (
                    stderr_str
                    + "\n[runner] No se pudo capturar la pantalla: "
                    + (capture_err or "razón desconocida")
                ).strip(),
                "exitCode": early_exit if early_exit is not None else 1,
                "screenshotBase64": None,
                "executionTimeMs": time_ms,
            }

        with open(screenshot_path, "rb") as f:
            png_bytes = f.read()

        if len(png_bytes) > GUI_MAX_PNG_BYTES:
            return {
                "mode": "tkinter_screenshot",
                "stdout": stdout_str,
                "stderr": stderr_str
                + f"\n[runner] PNG demasiado grande ({len(png_bytes)} bytes)",
                "exitCode": 1,
                "screenshotBase64": None,
                "executionTimeMs": time_ms,
            }

        b64 = base64.b64encode(png_bytes).decode("ascii")
        logger.info(
            "◀ RESPONSE id=%s phase=tkinter_ok time_ms=%d png_bytes=%d early_exit=%s",
            request_id,
            time_ms,
            len(png_bytes),
            str(early_exit),
        )
        return {
            "mode": "tkinter_screenshot",
            "stdout": stdout_str,
            "stderr": stderr_str,
            "exitCode": early_exit if early_exit is not None else 0,
            "screenshotBase64": b64,
            "pngBytes": len(png_bytes),
            "executionTimeMs": time_ms,
        }


def _handle_diagnose() -> dict:
    """Devuelve un snapshot del runtime para debugar issues de carga de
    .so como `UnsatisfiedLinkError: libawt_xawt.so`. Lo invoca
    `./deploy.sh` después del GUI self-test cuando éste falla.

    Información que recoge:
      - `java -version`
      - `ls /usr/lib/jvm/*/lib/libawt*.so` para confirmar que las libs
        de AWT están instaladas.
      - `ldd libawt_xawt.so` en RUNTIME (no en build) para detectar deps
        faltantes que sí existían en el momento del docker build.
      - Variables de entorno relevantes: LD_LIBRARY_PATH, DISPLAY,
        JAVA_HOME.
      - `ls /usr/lib64/libX*.so*` para verificar que los paquetes X11
        instalados via dnf están presentes en runtime.
    """
    import glob

    def run(cmd: list) -> str:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
            return (
                (r.stdout or "")
                + ("\n[stderr]\n" + r.stderr if r.stderr else "")
                + f"\n[exit] {r.returncode}"
            )
        except Exception as e:  # noqa: BLE001
            return f"[error] {type(e).__name__}: {e}"

    libawt_xawt_path = None
    for candidate in glob.glob("/usr/lib/jvm/java-21-amazon-corretto*/lib/libawt_xawt.so"):
        libawt_xawt_path = candidate
        break

    return {
        "mode": "diagnose",
        "java_version": run(["java", "-version"]),
        "javac_version": run(["javac", "-version"]),
        "libawt_xawt_path": libawt_xawt_path,
        "libawt_xawt_ldd": run(["ldd", libawt_xawt_path]) if libawt_xawt_path else "(no encontrado)",
        "libawt_xawt_listing": run(
            ["ls", "-la", os.path.dirname(libawt_xawt_path)] if libawt_xawt_path else ["true"]
        ),
        "x11_libs_present": run(["bash", "-c", "ls /usr/lib64/libX*.so* 2>&1 | head -40"]),
        "ld_library_path": os.environ.get("LD_LIBRARY_PATH", "(unset)"),
        "java_home_env": os.environ.get("JAVA_HOME", "(unset)"),
        "display_env": os.environ.get("DISPLAY", "(unset)"),
        "xvfb_path": run(["bash", "-c", "command -v Xvfb"]),
        "pillow_version": run(
            ["python3", "-c", "from PIL import Image; print(Image.__version__)"]
        ),
        # Python AL2023 (usado para preguntas tipo `codigo` con
        # language='python' y `python_gui` con tkinter). Distinto del
        # bundled Lambda Python 3.13 (que ejecuta este handler).
        "system_python_version": run([PYTHON_BIN, "--version"]),
        "system_python_path": PYTHON_BIN,
        "tkinter_version": run(
            [PYTHON_BIN, "-c", "import tkinter; print('tkinter OK:', tkinter.TkVersion)"]
        ),
        "tkinter_bootstrap_exists": run(
            ["bash", "-c", "ls -la /opt/TkinterBootstrap.py 2>&1 || echo '(no existe)'"]
        ),
        # /tmp/Xvfb_screen0 solo existe si Xvfb arrancó alguna vez en
        # este container warm. En frío puede no existir todavía — la
        # ausencia no es bug, solo el caso "no se ha hecho captura aún".
        "xvfb_screen0_stat": run(
            ["bash", "-c", "ls -la /tmp/Xvfb_screen0 2>&1 || echo '(no existe — Xvfb no ha corrido)'"]
        ),
        "uname": run(["uname", "-a"]),
    }


def handler(event, _context):
    # ── Auth: X-API-Key ──
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    provided = headers.get("x-api-key", "")
    if not API_KEY:
        return _resp(503, {"error": "Runner sin API_KEY configurada"})
    if provided != API_KEY:
        return _resp(401, {"error": "Unauthorized"})

    # ── Method check ──
    method = (
        event.get("requestContext", {}).get("http", {}).get("method", "POST")
    )
    if method.upper() != "POST":
        return _resp(405, {"error": "Method not allowed"})

    # ── Parse body ──
    body_raw = event.get("body") or "{}"
    if event.get("isBase64Encoded"):
        import base64
        body_raw = base64.b64decode(body_raw).decode("utf-8", "replace")
    try:
        body = json.loads(body_raw)
    except json.JSONDecodeError:
        return _resp(400, {"error": "Body no es JSON válido"})

    source = body.get("sourceCode", "")
    stdin = body.get("stdin", "") or ""
    mode = str(body.get("mode") or "run").lower()
    # `language` (default 'java') determina el toolchain para `mode='run'`.
    # Los modos GUI infieren el lenguaje del modo mismo (gui_screenshot→java,
    # tkinter_screenshot→python), así que el campo se ignora ahí.
    # Default 'java' para retro-compatibilidad con callers viejos del edge
    # que no mandaban este campo (solo Java existía).
    language = str(body.get("language") or "java").lower()
    # `diagnose` no requiere sourceCode — inspecciona el entorno del
    # runtime de Lambda y devuelve datos útiles para debuggear el caso
    # "el build pasó el ldd check pero en runtime el .so no carga".
    # Lo dispara `./deploy.sh` después del GUI self-test cuando éste falla.
    if mode == "diagnose":
        return _resp(200, _handle_diagnose())
    if mode not in ("run", "gui_screenshot", "tkinter_screenshot"):
        return _resp(
            400,
            {"error": f"mode inválido: {mode}. Opciones: run, gui_screenshot, tkinter_screenshot, diagnose."},
        )
    if mode == "run" and language not in ("java", "python"):
        return _resp(
            400,
            {"error": f"language inválido para mode=run: {language}. Opciones: java, python."},
        )
    if not isinstance(source, str) or not source.strip():
        return _resp(400, {"error": "sourceCode requerido"})
    if not isinstance(stdin, str):
        return _resp(400, {"error": "stdin debe ser string"})
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return _resp(400, {"error": f"Código demasiado largo (máx {MAX_SOURCE_BYTES} bytes)"})
    if len(stdin.encode("utf-8")) > MAX_STDIN_BYTES:
        return _resp(400, {"error": f"stdin demasiado largo (máx {MAX_STDIN_BYTES} bytes)"})

    # ── Derivar nombre de la clase pública (solo aplica a Java) ──
    # En Python no hay concepto de "clase pública" — el bootstrap importa
    # el archivo entero. Solo lo extraemos para los flujos Java.
    main_class = "Main"
    if mode == "gui_screenshot" or (mode == "run" and language == "java"):
        m = CLASS_RE.search(source)
        if m:
            main_class = m.group(1)

    # ── Log del request (CloudWatch) ──
    # Útil para auditar qué código está corriendo el alumno cuando algo
    # falla. El source se loguea completo (truncado a 2000 chars para
    # que no infle storage de logs); el stdin a 500.
    request_id = (_context.aws_request_id if _context and hasattr(_context, "aws_request_id") else "n/a")
    logger.info(
        "▶ REQUEST id=%s mode=%s language=%s class=%s source_length=%d stdin_length=%d",
        request_id,
        mode,
        language if mode == "run" else "(n/a)",
        main_class if main_class != "Main" or language == "java" else "(n/a)",
        len(source),
        len(stdin),
    )
    _log_preview("REQUEST.source", source, max_chars=2000)
    if stdin:
        _log_preview("REQUEST.stdin", stdin, max_chars=500)

    start = time.time()

    # ── Dispatch tkinter_screenshot (Python GUI) ──
    if mode == "tkinter_screenshot":
        try:
            delay_ms = int(body.get("delayMs", GUI_DEFAULT_DELAY_MS))
        except (TypeError, ValueError):
            delay_ms = GUI_DEFAULT_DELAY_MS
        result = _handle_tkinter_screenshot(source, delay_ms, request_id, start)
        return _resp(200, result)

    # ── Dispatch GUI screenshot (Java) ──
    if mode == "gui_screenshot":
        try:
            delay_ms = int(body.get("delayMs", GUI_DEFAULT_DELAY_MS))
        except (TypeError, ValueError):
            delay_ms = GUI_DEFAULT_DELAY_MS
        # `framework`: "swing" (default) o "javafx". El caller lo pasa
        # según el tipo de pregunta. Default a "swing" para retro-compat
        # con edges/clientes que no manden el campo.
        framework = str(body.get("framework") or "swing").lower()
        result = _handle_gui_screenshot(
            source, main_class, delay_ms, request_id, start, framework=framework,
        )
        return _resp(200, result)

    # ── Dispatch run mode (Python) ──
    if language == "python":
        result = _handle_python_run(source, stdin, request_id, start)
        return _resp(200, result)

    # ── Dispatch run mode (Java) — flujo legacy ──
    # /tmp es escribible en Lambda (512MB-10GB ephemeral); TemporaryDirectory
    # se borra al salir del with.
    with tempfile.TemporaryDirectory(dir="/tmp") as tmp:
        source_path = os.path.join(tmp, f"{main_class}.java")
        with open(source_path, "w", encoding="utf-8") as f:
            f.write(source)

        # ── Compilar ──
        try:
            compile_proc = subprocess.run(
                ["javac", "-encoding", "UTF-8", "-d", tmp, source_path],
                capture_output=True,
                text=True,
                timeout=COMPILE_TIMEOUT_S,
                cwd=tmp,
            )
        except subprocess.TimeoutExpired:
            payload = {
                "stdout": "",
                "stderr": f"Compilación excedió el tiempo límite ({COMPILE_TIMEOUT_S}s).",
                "exitCode": 124,
                "executionTimeMs": int((time.time() - start) * 1000),
            }
            logger.warning(
                "◀ RESPONSE id=%s phase=compile_timeout time_ms=%d",
                request_id,
                payload["executionTimeMs"],
            )
            return _resp(200, payload)

        if compile_proc.returncode != 0:
            # Compile error: stderr de javac trae línea + columna + mensaje.
            # Lo devolvemos tal cual (es exactamente lo que el alumno necesita ver).
            stderr_text = _truncate(compile_proc.stderr or "Error de compilación")
            logger.info(
                "◀ RESPONSE id=%s phase=compile_error exit=%d time_ms=%d",
                request_id,
                compile_proc.returncode,
                int((time.time() - start) * 1000),
            )
            _log_preview("RESPONSE.compile_stderr", stderr_text, max_chars=1000)
            return _resp(200, {
                "stdout": "",
                "stderr": stderr_text,
                "exitCode": compile_proc.returncode,
                "executionTimeMs": int((time.time() - start) * 1000),
            })

        # ── Ejecutar ──
        # -Xmx512m limita el heap; Lambda matará si pasa el memoryLimit
        # general, pero esto da error JVM-friendly en lugar de OOM-kill.
        try:
            run_proc = subprocess.run(
                ["java", "-Xmx512m", "-cp", tmp, main_class],
                input=stdin,
                capture_output=True,
                text=True,
                timeout=EXECUTE_TIMEOUT_S,
            )
            stdout_text = _truncate(run_proc.stdout)
            stderr_text = _truncate(run_proc.stderr)
            time_ms = int((time.time() - start) * 1000)
            logger.info(
                "◀ RESPONSE id=%s phase=executed exit=%d time_ms=%d stdout_len=%d stderr_len=%d",
                request_id,
                run_proc.returncode,
                time_ms,
                len(stdout_text),
                len(stderr_text),
            )
            _log_preview("RESPONSE.stdout", stdout_text, max_chars=2000)
            if stderr_text:
                _log_preview("RESPONSE.stderr", stderr_text, max_chars=1000)
            return _resp(200, {
                "stdout": stdout_text,
                "stderr": stderr_text,
                "exitCode": run_proc.returncode,
                "executionTimeMs": time_ms,
            })
        except subprocess.TimeoutExpired:
            logger.warning(
                "◀ RESPONSE id=%s phase=execute_timeout time_ms=%d",
                request_id,
                EXECUTE_TIMEOUT_S * 1000,
            )
            return _resp(200, {
                "stdout": "",
                "stderr": f"Ejecución excedió el tiempo límite ({EXECUTE_TIMEOUT_S}s). ¿Bucle infinito?",
                "exitCode": 124,
                "executionTimeMs": EXECUTE_TIMEOUT_S * 1000,
            })

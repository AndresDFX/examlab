"""
AWS Lambda handler — compila y ejecuta código Java del estudiante.

Invocado vía API Gateway HTTP API. El edge function `execute-code` (modo
consola) o `execute-java-gui-screenshot` (modo GUI) de Supabase llama el
endpoint con shared secret en `X-API-Key`.

Modos (en el body, campo `mode`):
 - `run` (default): compila con javac + ejecuta con java; retorna
   stdout/stderr/exitCode. Es lo que usa una pregunta tipo `codigo` en
   lenguaje Java.
 - `gui_screenshot`: arranca Xvfb en :99, compila + ejecuta Java con
   DISPLAY=:99 en background, duerme `delayMs` para que Swing pinte,
   captura `import -window root` a PNG y lo retorna en base64. Es lo
   que usa una pregunta tipo `java_gui` cuando el admin configuró
   `java_gui_provider = aws_screenshot`. NO es interactivo — el alumno
   solo ve la captura, no puede clickear.

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
# Tamaño del framebuffer virtual. Suficiente para una ventana Swing
# promedio. Si la JFrame es más grande, X la corta — el alumno verá
# parte de la UI cortada (mismo que pasa en un monitor pequeño).
GUI_SCREEN = "1024x768x24"
# Ventana de tiempo (ms) entre que arrancamos la JVM y hacemos la
# captura. Swing tarda en pintar la primera frame: ~500ms warm,
# ~1500-2000ms cold. Le damos 2000ms por default. El cliente puede
# pedir más con `delayMs` (cap a 8s para no agotar el Lambda timeout).
GUI_DEFAULT_DELAY_MS = 2000
GUI_MAX_DELAY_MS = 8000
# Tope de tamaño del PNG retornado. 1024x768x24 limpio comprime a
# ~50-200KB; le damos margen.
GUI_MAX_PNG_BYTES = 2_000_000

# Captura del nombre de la clase pública para invocar `java <Name>`.
# Si no encuentra, asume `Main` (convención del editor del alumno).
CLASS_RE = re.compile(r"public\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)")


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
) -> dict:
    """Compila + ejecuta Java con DISPLAY=Xvfb y retorna captura PNG base64.

    Flow:
      1. Arrancar Xvfb en :99.
      2. javac (mismo que modo run, con timeout).
      3. java -cp tmp <Class> en BACKGROUND con DISPLAY=:99.
      4. Sleep delay_ms (para que Swing pinte).
      5. `import -window root -display :99 /tmp/x.png` → captura.
      6. Kill JVM + Xvfb.
      7. Base64-encode PNG y retornar.
    """
    # Cap defensivo del delay para no agotar el timeout de Lambda.
    delay_ms = max(200, min(GUI_MAX_DELAY_MS, delay_ms))

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
        env = os.environ.copy()
        env["DISPLAY"] = GUI_DISPLAY
        java_proc = subprocess.Popen(
            [
                "java",
                "-Djava.awt.headless=false",
                "-Xmx512m",
                "-cp",
                tmp,
                main_class,
            ],
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        # Espera a que Swing pinte. Si el proceso muere antes (NPE en
        # main, ClassNotFoundException, etc.) lo detectamos sin esperar
        # los 2s completos.
        deadline = time.time() + (delay_ms / 1000.0)
        early_exit = None
        while time.time() < deadline:
            rc = java_proc.poll()
            if rc is not None:
                early_exit = rc
                break
            time.sleep(0.05)

        # ── Capturar screenshot ──
        screenshot_path = os.path.join(tmp, "screenshot.png")
        try:
            cap_proc = subprocess.run(
                [
                    "import",
                    "-display",
                    GUI_DISPLAY,
                    "-window",
                    "root",
                    screenshot_path,
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            capture_ok = cap_proc.returncode == 0 and os.path.exists(screenshot_path)
            capture_err = cap_proc.stderr if cap_proc.returncode != 0 else ""
        except subprocess.TimeoutExpired:
            capture_ok = False
            capture_err = "ImageMagick `import` excedió 10s"

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
        "import_path": run(["bash", "-c", "command -v import"]),
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
    # `diagnose` no requiere sourceCode — inspecciona el entorno del
    # runtime de Lambda y devuelve datos útiles para debuggear el caso
    # "el build pasó el ldd check pero en runtime el .so no carga".
    # Lo dispara `./deploy.sh` después del GUI self-test cuando éste falla.
    if mode == "diagnose":
        return _resp(200, _handle_diagnose())
    if mode not in ("run", "gui_screenshot"):
        return _resp(400, {"error": f"mode inválido: {mode}. Opciones: run, gui_screenshot, diagnose."})
    if not isinstance(source, str) or not source.strip():
        return _resp(400, {"error": "sourceCode requerido"})
    if not isinstance(stdin, str):
        return _resp(400, {"error": "stdin debe ser string"})
    if len(source.encode("utf-8")) > MAX_SOURCE_BYTES:
        return _resp(400, {"error": f"Código demasiado largo (máx {MAX_SOURCE_BYTES} bytes)"})
    if len(stdin.encode("utf-8")) > MAX_STDIN_BYTES:
        return _resp(400, {"error": f"stdin demasiado largo (máx {MAX_STDIN_BYTES} bytes)"})

    # ── Derivar nombre de la clase pública ──
    m = CLASS_RE.search(source)
    main_class = m.group(1) if m else "Main"

    # ── Log del request (CloudWatch) ──
    # Útil para auditar qué código está corriendo el alumno cuando algo
    # falla. El source se loguea completo (truncado a 2000 chars para
    # que no infle storage de logs); el stdin a 500.
    request_id = (_context.aws_request_id if _context and hasattr(_context, "aws_request_id") else "n/a")
    logger.info(
        "▶ REQUEST id=%s mode=%s class=%s source_length=%d stdin_length=%d",
        request_id,
        mode,
        main_class,
        len(source),
        len(stdin),
    )
    _log_preview("REQUEST.source", source, max_chars=2000)
    if stdin:
        _log_preview("REQUEST.stdin", stdin, max_chars=500)

    start = time.time()

    # ── Dispatch GUI screenshot ──
    if mode == "gui_screenshot":
        try:
            delay_ms = int(body.get("delayMs", GUI_DEFAULT_DELAY_MS))
        except (TypeError, ValueError):
            delay_ms = GUI_DEFAULT_DELAY_MS
        result = _handle_gui_screenshot(source, main_class, delay_ms, request_id, start)
        return _resp(200, result)
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

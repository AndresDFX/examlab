"""
TkinterBootstrap — wrapper Python que ejecuta el código tkinter del
estudiante y se encarga de que la ventana se cierre automáticamente
después de `EXAMLAB_GUI_SLEEP_MS` ms, para que `app.py` capture el
framebuffer de Xvfb antes de matar el proceso.

Por qué existe:
  El estudiante escribe algo como:

      import tkinter as tk
      root = tk.Tk()
      tk.Label(root, text="Hola").pack()
      root.mainloop()

  Para que `tk.Label.pack()` se vea en el framebuffer, `mainloop()` debe
  correr al menos un par de iteraciones. Pero `mainloop()` bloquea
  indefinidamente — sin algo que destruya la ventana, el proceso queda
  vivo hasta que Lambda lo mata por timeout. Mismo problema que con
  Java/Swing y la razón de `GuiBootstrap.java`.

  Pedirle al alumno que ponga `root.after(4000, root.destroy)` antes
  de `mainloop()` es ruido pedagógico (no es lo que evalúa la pregunta).
  Este wrapper lo hace por él monkey-patching `tkinter.Tk.__init__`:
  cuando el alumno haga `tk.Tk()`, nosotros registramos el `after` de
  destrucción automáticamente.

Cómo se usa desde `app.py`:
  EXAMLAB_STUDENT_PATH=/tmp/<tmp>/student.py \
  EXAMLAB_GUI_SLEEP_MS=3500 \
  DISPLAY=:99 \
  python3 /opt/TkinterBootstrap.py

Patrones del estudiante que soportamos:

  1. Script "lineal" sin función:
       import tkinter as tk
       root = tk.Tk()
       tk.Label(root, text="Hola").pack()
       root.mainloop()
     → Nuestro patch de Tk.__init__ programa destroy; root.mainloop()
       corre `SLEEP_MS` ms y retorna; el wrapper sale.

  2. Script con función `main`:
       def main():
           root = tk.Tk()
           ...
           root.mainloop()
       if __name__ == "__main__":
           main()
     → runpy lo ejecuta como __main__; mismo comportamiento que (1).

  3. Script que olvida `mainloop()`:
       root = tk.Tk()
       tk.Label(root, text="Hola").pack()
     → runpy retorna sin que la ventana se pinte. Nosotros detectamos
       que `tkinter._default_root` existe y lo metemos a mainloop por
       el alumno; nuestro patch ya programó destroy.

Comportamiento ante errores:
  Si el código del estudiante lanza una excepción, imprimimos el
  traceback a stderr y salimos con exit code 2 — mismo contrato que
  GuiBootstrap.java. Eso permite que `app.py` capture el stderr y se
  lo muestre al alumno aunque el screenshot quede vacío.
"""

import os
import runpy
import sys
import traceback

# Importamos tkinter ANTES de monkey-patchear. Si tkinter no está
# disponible (Python sin _tkinter compilado), el ImportError sale al
# stderr ya — el alumno verá un mensaje útil. No falla silencioso.
try:
    import tkinter
except ImportError as e:
    print(f"[bootstrap] tkinter no está disponible: {e}", file=sys.stderr)
    print(
        "[bootstrap] Esto suele indicar que el container no instaló "
        "python3-tkinter. Revisa el Dockerfile.",
        file=sys.stderr,
    )
    sys.exit(3)


# Lee config del entorno. app.py los inyecta con cada invocación.
SLEEP_MS = int(os.environ.get("EXAMLAB_GUI_SLEEP_MS", "4000"))
STUDENT_PATH = os.environ.get("EXAMLAB_STUDENT_PATH", "")

if not STUDENT_PATH or not os.path.isfile(STUDENT_PATH):
    print(
        f"[bootstrap] EXAMLAB_STUDENT_PATH inválido: {STUDENT_PATH!r}. "
        "El wrapper espera la ruta al script del estudiante.",
        file=sys.stderr,
    )
    sys.exit(4)


# ── Monkey-patch de Tk.__init__ ────────────────────────────────────
# Cuando el alumno haga `tk.Tk()`, además del init normal registramos
# un `after(SLEEP_MS, destroy)` para que la ventana se cierre sola. El
# patch aplica a TODOS los Tk creados (incluyendo subclases tipo
# ttkbootstrap.Window que internamente llaman Tk.__init__).
#
# Toplevel es DISTINTO de Tk — un alumno puede crear `tk.Toplevel(root)`
# y el root sigue siendo el `Tk()` principal. No patcheamos Toplevel
# porque destruir el root automáticamente destruye sus Toplevels.
_original_tk_init = tkinter.Tk.__init__


def _patched_tk_init(self, *args, **kwargs):
    _original_tk_init(self, *args, **kwargs)
    # Defensa: si `after` falla por alguna razón (root ya muerto), no
    # rompemos el flujo del estudiante. El wrapper main pumping en el
    # final como red de seguridad.
    try:
        self.after(SLEEP_MS, self.destroy)
    except Exception:  # noqa: BLE001
        pass


tkinter.Tk.__init__ = _patched_tk_init  # type: ignore[method-assign]


# ── Ejecutar el código del estudiante ──────────────────────────────
# runpy.run_path corre el archivo como si fuera ejecutado con
# `python student.py`. Setea `__name__ == "__main__"` para que los
# guards `if __name__ == "__main__":` se activen. NO contamina nuestro
# espacio de nombres con las variables del estudiante (devuelve un dict).
try:
    runpy.run_path(STUDENT_PATH, run_name="__main__")
except SystemExit as e:
    # Si el estudiante llamó sys.exit() explícitamente, respetar su
    # exit code. Si fue exit(0), seguimos al cleanup; si fue exit(N),
    # propagamos antes de hacer mainloop adicional (no sabemos si su
    # ventana está limpia).
    code = e.code if isinstance(e.code, int) else 0
    if code != 0:
        sys.exit(code)
except Exception:  # noqa: BLE001
    # Desempaquetar como hace GuiBootstrap.java: el alumno necesita ver
    # el traceback REAL (NameError en línea X, TypeError, etc.), no un
    # wrapper del bootstrap. traceback.print_exc imprime exactamente la
    # cadena de excepciones que el intérprete habría mostrado.
    traceback.print_exc(file=sys.stderr)
    sys.exit(2)


# ── Red de seguridad: pumping de mainloop si el alumno lo omitió ──
# Si el código del estudiante creó un Tk pero nunca llamó `mainloop()`,
# la ventana nunca se pintará en Xvfb (tkinter solo despacha eventos
# durante el loop). Detectamos ese caso y arrancamos un mainloop nosotros.
# El `after(SLEEP_MS, destroy)` que registramos arriba se encarga de
# salirnos del loop a tiempo.
root = tkinter._default_root  # type: ignore[attr-defined]
if root is not None:
    try:
        if root.winfo_exists():
            root.mainloop()
    except tkinter.TclError:
        # root.destroy() ya corrió desde el `after` callback — la
        # mainloop salió por sí sola. Caso esperado, no es error.
        pass

# Salida limpia. Si llegamos hasta acá, el alumno renderizó algo (o
# debería) y el framebuffer de Xvfb tiene el estado final. app.py se
# encarga de leerlo y codificar a PNG.
sys.exit(0)

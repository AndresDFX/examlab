/**
 * PythonGuiRunner — editor Monaco + ejecución de Python tkinter con
 * captura de pantalla server-side.
 *
 * Paralelo a `JavaGuiRunner` pero más simple: solo hay UN modo de
 * ejecución posible. No existe Pyodide+tkinter en WebAssembly, así que
 * no podemos correr tkinter client-side. La pregunta `python_gui`
 * siempre va por AWS Lambda + Xvfb (edge function
 * `execute-python-gui-screenshot` → `mode=tkinter_screenshot` en el
 * runner).
 *
 * Flujo:
 *   1. El alumno escribe código Python que crea una ventana tkinter.
 *   2. Click en "Generar captura" → edge → Lambda → Xvfb arranca,
 *      ejecuta el código vía `TkinterBootstrap.py` (que monkey-patchea
 *      Tk.__init__ para programar destroy automático).
 *   3. Lambda lee el framebuffer crudo de Xvfb, codifica a PNG y devuelve
 *      base64.
 *   4. El alumno ve la captura. NO es interactivo — no puede clickear
 *      botones de la ventana.
 *
 * El código fuente se reporta vía onChange y se guarda como respuesta de
 * texto para que la IA lo califique igual que las preguntas `codigo`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, Camera, Info, RotateCcw, Terminal, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { formatFileSize } from "@/shared/lib/format";

/**
 * Snippet inicial. Crea una ventana sencilla con un Label y un Button —
 * suficiente para validar que el flujo de captura funciona. El alumno
 * NO necesita escribir `root.after(..., root.destroy)`: el bootstrap
 * server-side lo agrega automáticamente.
 */
export const PYTHON_GUI_STARTER = `import tkinter as tk

root = tk.Tk()
root.title("Hola tkinter")
root.geometry("420x240")

label = tk.Label(
    root,
    text="¡Hola, mundo desde tkinter!",
    font=("Helvetica", 16, "bold"),
)
label.pack(pady=24)

btn = tk.Button(root, text="Saludar", command=lambda: label.config(text="¡Hola!"))
btn.pack()

root.mainloop()
`;

interface Props {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  /** Bloquea silenciosamente copiar/pegar/cortar dentro del editor. */
  blockClipboard?: boolean;
}

export function PythonGuiRunner({
  value,
  onChange,
  height = "320px",
  readOnly = false,
  blockClipboard = false,
}: Readonly<Props>) {
  const { t } = useTranslation();
  const editorRef = useRef<unknown>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // AbortController para cancelar el run en curso. El edge function
  // sigue corriendo server-side hasta terminar, pero la UI se libera.
  const abortRef = useRef<AbortController | null>(null);

  const [screenshotData, setScreenshotData] = useState<{
    png: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    pngBytes: number;
    executionTimeMs: number;
  } | null>(null);

  // Capturamos el último value en ref para que `run` siempre lea la
  // versión actualizada sin depender del state como dep.
  const valueRef = useRef(value);
  valueRef.current = value;

  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains("dark"));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      if (blockClipboard) {
        const noop = () => {};
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, noop);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, noop);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, noop);
        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Insert, noop);
        editor.onDidPaste(() => {
          editor.trigger("anti-paste", "undo", null);
        });
      }
    },
    [blockClipboard],
  );

  const runScreenshot = async () => {
    setError(null);
    setHasRun(false);
    setScreenshotData(null);
    setRunning(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      if (signal.aborted) return;
      const source = valueRef.current || PYTHON_GUI_STARTER;
      const invokePromise = supabase.functions.invoke("execute-python-gui-screenshot", {
        body: {
          sourceCode: source,
          questionId: "python_gui_runner_preview",
        },
      });
      const cancelPromise = new Promise<never>((_, reject) => {
        if (signal.aborted) {
          reject(new Error("__cancelled__"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("__cancelled__")), {
          once: true,
        });
      });
      const { data, error: invokeErr } = await (Promise.race([
        invokePromise,
        cancelPromise,
      ]) as Promise<Awaited<typeof invokePromise>>);
      if (signal.aborted) return;
      if (invokeErr || data?.error) {
        const detail = await extractEdgeError(invokeErr, data);
        throw new Error(detail || "Error generando captura");
      }
      if (!data?.screenshotBase64) {
        throw new Error(
          (data?.stderr as string)?.trim() ||
            "El runner no devolvió captura. Revisa que tu código ejecute sin errores y abra al menos una ventana visible.",
        );
      }
      setScreenshotData({
        png: data.screenshotBase64 as string,
        stdout: (data.stdout as string) ?? "",
        stderr: (data.stderr as string) ?? "",
        exitCode: typeof data.exitCode === "number" ? data.exitCode : 0,
        pngBytes: typeof data.pngBytes === "number" ? data.pngBytes : 0,
        executionTimeMs: typeof data.executionTimeMs === "number" ? data.executionTimeMs : 0,
      });
      setHasRun(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "__cancelled__") return;
      console.error("[PythonGuiRunner:screenshot]", e);
      setError(e instanceof Error ? e.message : "Error ejecutando Python");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const cancelRun = () => {
    const controller = abortRef.current;
    if (!controller) return;
    controller.abort();
    abortRef.current = null;
    setRunning(false);
  };

  useEffect(() => {
    if (!dialogOpen) return;
    void runScreenshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Badge variant="outline" className="text-xs flex items-center gap-1">
          <Camera className="h-3 w-3" /> {t("pythonGuiRunner.badge")}
        </Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={readOnly}
          className="h-8 text-xs"
          type="button"
        >
          <Camera className="h-3 w-3 mr-1" />
          {t("pythonGuiRunner.btnGenerate")}
        </Button>
      </div>

      {(error || hasRun) && !dialogOpen && (
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          {t("pythonGuiRunner.btnReopen")}
        </button>
      )}

      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground bg-muted/30 border rounded-md px-2.5 py-1.5">
        <Info className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
        <span>{t("pythonGuiRunner.hint")}</span>
      </div>

      <div className="rounded-md border overflow-hidden">
        <Editor
          height={height}
          language="python"
          value={value}
          onChange={(v) => onChange(v ?? "")}
          onMount={handleMount}
          theme={isDark ? "vs-dark" : "vs"}
          options={{
            minimap: { enabled: false },
            fontSize: 13,
            lineNumbers: "on",
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 4,
            readOnly,
            wordWrap: "on",
            padding: { top: 8 },
          }}
        />
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-[95vw] w-[95vw] sm:max-w-[95vw] h-[92dvh] flex flex-col p-4 gap-3">
          <DialogHeader className="space-y-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Camera className="h-4 w-4" />
              {t("pythonGuiRunner.dialogTitle")}
              {running && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                  <Spinner size="xs" />
                  {t("pythonGuiRunner.statusRunning")}
                </span>
              )}
            </DialogTitle>
          </DialogHeader>

          {error && (
            <div className="flex items-start gap-2 text-xs text-destructive">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3 flex-1 min-h-0">
            <Card className="bg-muted/40 flex flex-col min-h-0">
              <CardHeader className="py-2 px-3 shrink-0">
                <CardTitle className="text-xs flex items-center gap-1.5">
                  <Terminal className="h-3 w-3" /> {t("pythonGuiRunner.consoleTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 flex-1 min-h-0 overflow-hidden">
                <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-auto h-full">
                  {screenshotData
                    ? [
                        screenshotData.stdout,
                        screenshotData.stderr,
                        `\n[runner] exit=${screenshotData.exitCode} • ${formatFileSize(screenshotData.pngBytes)} • ${screenshotData.executionTimeMs} ms`,
                        screenshotData.exitCode === 0 &&
                        screenshotData.pngBytes > 0 &&
                        screenshotData.pngBytes < 4000
                          ? "\n[hint] La captura quedó vacía. Probablemente tu script terminó antes\n" +
                            "       de que tkinter pintara. Asegúrate de llamar `root.mainloop()`\n" +
                            "       al final del código — el runner lo deja correr unos segundos\n" +
                            "       y luego cierra la ventana automáticamente."
                          : "",
                      ]
                        .filter(Boolean)
                        .join("\n")
                    : running
                      ? ""
                      : t("pythonGuiRunner.consolePending")}
                </pre>
              </CardContent>
            </Card>
            <Card className="bg-muted/40 flex flex-col min-h-0">
              <CardHeader className="py-2 px-3 shrink-0">
                <CardTitle className="text-xs flex items-center gap-1.5">
                  <Camera className="h-3 w-3" /> {t("pythonGuiRunner.cardCaptureTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 flex-1 min-h-0 overflow-hidden">
                {/* `bg-checkerboard` utility (src/styles.css) — antes
                    inline style con linear-gradient hex literal. */}
                <div className="w-full h-full rounded border overflow-auto flex items-start justify-start p-2 relative bg-checkerboard">
                  {screenshotData?.png ? (
                    <>
                      <img
                        src={`data:image/png;base64,${screenshotData.png}`}
                        alt="Captura de la ventana tkinter renderizada en el servidor"
                        className="max-w-full max-h-full object-contain"
                      />
                      {/* Banner cuando el PNG es prácticamente vacío. Mismo
                          threshold (2KB) que el runner de Java porque el
                          framebuffer es del mismo tamaño y la lógica de
                          captura es idéntica. */}
                      {screenshotData.exitCode === 0 &&
                        screenshotData.pngBytes > 0 &&
                        screenshotData.pngBytes < 2000 && (
                          <div className="absolute inset-x-2 bottom-2 bg-amber-50/95 dark:bg-amber-950/95 border border-amber-300 dark:border-amber-700 rounded-md p-2 text-[10px] leading-snug shadow-md">
                            <p className="font-semibold text-amber-700 dark:text-amber-300">
                              {t("pythonGuiRunner.emptyPngTitle")}
                            </p>
                            <p className="text-amber-900 dark:text-amber-200 mt-0.5">
                              Tu script terminó antes de que tkinter rendereara. Llama{" "}
                              <code className="font-mono">root.mainloop()</code> al final — el
                              runner cierra la ventana automáticamente unos segundos después, así
                              que no necesitas un <code className="font-mono">destroy()</code>{" "}
                              manual.
                            </p>
                          </div>
                        )}
                    </>
                  ) : running ? (
                    <span className="text-xs text-muted-foreground">{t("pythonGuiRunner.captureWaiting")}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t("pythonGuiRunner.captureNone")}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <div className="flex items-center justify-end gap-2 shrink-0">
            {running && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={cancelRun}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                title={t("pythonGuiRunner.cancelTitle")}
              >
                <X className="h-3 w-3 mr-1" />
                {t("pythonGuiRunner.cancelButton")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => void runScreenshot()}
              disabled={running}
            >
              {running ? (
                <Spinner size="xs" className="mr-1" />
              ) : (
                <RotateCcw className="h-3 w-3 mr-1" />
              )}
              {t("pythonGuiRunner.btnRegenerate")}
            </Button>
            <Button size="sm" variant="default" type="button" onClick={() => setDialogOpen(false)}>
              {t("pythonGuiRunner.btnClose")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * JavaGuiRunner — editor Monaco + ejecución de Java Swing/AWT.
 *
 * Soporta DOS modos seleccionados globalmente desde Admin → Compilador
 * (`code_execution_settings.java_gui_provider`):
 *
 *   - `cheerp` (default): CheerpJ 4.3 client-side. Ventana Swing real,
 *     clicks/eventos en el browser. WebAssembly JVM. Requiere licencia
 *     comercial para producción multi-usuario.
 *
 *   - `aws_screenshot`: AWS Lambda con Xvfb + ImageMagick. El runner
 *     compila + ejecuta + captura UN PNG de la ventana y lo retorna en
 *     base64. NO interactivo — el alumno solo VE la captura, no puede
 *     clickear. Sin licencia comercial. Ver docs/JAVA-GUI-OPTIONS.md.
 *
 * Herencia automática: si el admin eligió `provider = aws_lambda` (el
 * "judge" AWS) como compilador general Y no fijó `java_gui_provider`
 * explícitamente, el runner asume `aws_screenshot` — el mismo Lambda
 * sabe correr ambos endpoints (text execution + screenshot). Evita que
 * el admin tenga que setear DOS campos para usar el judge AWS.
 *
 * En ambos modos el código fuente se reporta vía onChange y se guarda
 * como respuesta de texto para ser calificada por la IA igual que las
 * preguntas de tipo "código".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Coffee,
  AlertTriangle,
  Terminal,
  Maximize2,
  RotateCcw,
  Info,
  Camera,
  X,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { formatFileSize } from "@/shared/lib/format";

type JavaGuiMode = "cheerp" | "aws_screenshot";

declare global {
  interface Window {
    cheerpjInit?: (opts?: any) => Promise<void>;
    cheerpjCreateDisplay?: (width: number, height: number, container?: HTMLElement) => void;
    cheerpjRunMain?: (cls: string, cp: string, ...args: string[]) => Promise<number>;
    cheerpOSAddStringFile?: (path: string, contents: Uint8Array) => void;
    cheerpjAddStringFile?: (path: string, contents: Uint8Array) => void;
    __cheerpjLoading?: Promise<void>;
    __cheerpjReady?: boolean;
    __toolsJarLoading?: Promise<Uint8Array>;
    __toolsJarBytes?: Uint8Array;
  }
}

const TOOLS_JAR_URL = "/tools.jar";

/**
 * Lovable/Cloudflare sirve /tools.jar con 200 pero SIN soporte de byte-range
 * (no manda Accept-Ranges y devuelve 200 a peticiones con Range:). CheerpJ
 * lee los JAR con range requests para acceder al ZIP central directory; sin
 * eso falla con "Could not find or load main class".
 *
 * Workaround: bajamos tools.jar entero una vez y lo montamos en el filesystem
 * virtual de CheerpJ vía cheerpOSAddStringFile. Después accedemos con la ruta
 * /str/tools.jar en el classpath.
 */
function loadToolsJar(): Promise<Uint8Array> {
  if (window.__toolsJarBytes) return Promise.resolve(window.__toolsJarBytes);
  if (window.__toolsJarLoading) return window.__toolsJarLoading;
  const p = (async () => {
    const r = await fetch(TOOLS_JAR_URL);
    if (!r.ok) throw new Error(`No se pudo descargar tools.jar (${r.status})`);
    const buf = await r.arrayBuffer();
    const bytes = new Uint8Array(buf);
    window.__toolsJarBytes = bytes;
    return bytes;
  })();
  // Si falla, no envenenar el cache: el próximo click reintenta.
  p.catch(() => {
    if (window.__toolsJarLoading === p) window.__toolsJarLoading = undefined;
  });
  window.__toolsJarLoading = p;
  return p;
}

const CHEERPJ_SRC = "https://cjrtnc.leaningtech.com/4.3/loader.js";

export const JAVA_GUI_STARTER = `import javax.swing.*;
import java.awt.*;

public class Main {
    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> {
            JFrame frame = new JFrame("Hola Swing");
            frame.setDefaultCloseOperation(JFrame.DISPOSE_ON_CLOSE);
            frame.setSize(420, 240);

            JPanel panel = new JPanel(new BorderLayout());
            JLabel label = new JLabel("¡Hola, mundo desde Swing!", SwingConstants.CENTER);
            label.setFont(new Font("SansSerif", Font.BOLD, 18));
            panel.add(label, BorderLayout.CENTER);

            JButton btn = new JButton("Saludar");
            btn.addActionListener(e -> label.setText("¡Hola, " + System.currentTimeMillis() + "!"));
            panel.add(btn, BorderLayout.SOUTH);

            frame.setContentPane(panel);
            frame.setVisible(true);
        });
    }
}
`;

function loadCheerpJ(): Promise<void> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  if (window.__cheerpjReady) return Promise.resolve();
  if (window.__cheerpjLoading) return window.__cheerpjLoading;

  const p = new Promise<void>((resolve, reject) => {
    const ready = async () => {
      try {
        if (typeof window.cheerpjInit !== "function") {
          throw new Error("CheerpJ no expuso cheerpjInit");
        }
        await window.cheerpjInit({ status: "none" });
        window.__cheerpjReady = true;
        resolve();
      } catch (e) {
        reject(e);
      }
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CHEERPJ_SRC}"]`);
    if (existing) {
      if (window.cheerpjInit) void ready();
      else existing.addEventListener("load", ready, { once: true });
      existing.addEventListener("error", () => reject(new Error("No se pudo cargar CheerpJ")), {
        once: true,
      });
      return;
    }
    const s = document.createElement("script");
    s.src = CHEERPJ_SRC;
    s.async = true;
    s.onload = ready;
    s.onerror = () => reject(new Error("No se pudo cargar CheerpJ"));
    document.head.appendChild(s);
  });
  // No envenenar el cache si la primera carga falla: el siguiente
  // click reintenta sin necesidad de recargar la página.
  p.catch(() => {
    if (window.__cheerpjLoading === p) window.__cheerpjLoading = undefined;
  });
  window.__cheerpjLoading = p;
  return p;
}

/** Extrae el nombre de la clase pública del fuente; por defecto Main. */
function deriveMainClass(source: string): string {
  const m = source.match(/public\s+class\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  return m ? m[1] : "Main";
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  /** Bloquea silenciosamente copiar/pegar/cortar dentro del editor. */
  blockClipboard?: boolean;
}

export function JavaGuiRunner({
  value,
  onChange,
  height = "320px",
  readOnly = false,
  blockClipboard = false,
}: Props) {
  const editorRef = useRef<any>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLPreElement>(null);
  // Tracking de "ya cree el display CheerpJ para este contenedor". Antes
  // recreábamos el display en cada run lo que iba dejando estado interno
  // acumulado en CheerpJ y agregando ~500ms-1s a cada re-ejecución (el
  // 4to run era visiblemente más lento que el 1ro). El display vive
  // mientras el modal exista — si el usuario cierra y reabre, re-crear
  // está bien porque el contenedor se recicla.
  const displayCreatedRef = useRef(false);
  const [loadingCJ, setLoadingCJ] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // AbortController para el run en curso. `cancelRun()` aborta y libera
  // la UI inmediatamente — el worker (CheerpJ / edge Lambda) sigue
  // corriendo en background hasta terminar, pero el estudiante puede
  // cambiar de modo o cerrar el dialog sin esperar.
  const abortRef = useRef<AbortController | null>(null);

  // Modo activo (global, desde code_execution_settings). Default 'cheerp'
  // mientras carga para no bloquear el render del editor.
  const [mode, setMode] = useState<JavaGuiMode>("cheerp");
  const [modeLoaded, setModeLoaded] = useState(false);

  // Estado del modo screenshot (PNG + stdout/stderr del runner).
  const [screenshotData, setScreenshotData] = useState<{
    png: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    pngBytes: number;
    executionTimeMs: number;
  } | null>(null);

  // Resolución del modo Java GUI con dos campos en `code_execution_settings`:
  //
  //   1) `java_gui_provider` — explícito (cheerp | aws_screenshot). Si el
  //      admin lo setea a `aws_screenshot`, gana SIEMPRE.
  //   2) `provider` (el compilador general) — cuando el admin elige
  //      `aws_lambda` ("judge"), heredamos automáticamente la lógica de
  //      imagen para Swing: el runner se ejecuta server-side y la
  //      respuesta es UN PNG (no embed CheerpJ). Esto evita que el admin
  //      tenga que setear DOS campos para usar el judge AWS.
  //
  // Default `cheerp` si ningún criterio aplica (modo previo).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sb = supabase as any;
      const { data } = await sb
        .from("code_execution_settings")
        .select("provider, java_gui_provider")
        .eq("is_active", true)
        .maybeSingle();
      if (cancelled) return;
      const row = data as { provider?: string; java_gui_provider?: string } | null;
      const explicit = row?.java_gui_provider;
      if (explicit === "aws_screenshot") {
        setMode("aws_screenshot");
      } else if (explicit === "cheerp") {
        setMode("cheerp");
      } else if (row?.provider === "aws_lambda") {
        // Admin eligió el "judge" AWS como compilador general — heredamos
        // la lógica de imagen para Swing automáticamente.
        setMode("aws_screenshot");
      }
      setModeLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Capturamos el último value en una ref para que `run` siempre lea la
  // versión actualizada del editor sin depender de él como dependencia
  // (eso provocaría re-runs en cada tecla mientras el modal está abierto).
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
        // Red de seguridad: clic derecho → Pegar / drag-drop / menú Edit
        // del browser. Si algo se cuela, undo inmediato.
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
    // Aborter para este run. Si ya había uno previo (defensive — no
    // debería pasar porque el botón está disabled mientras `running`),
    // lo abortamos primero para no dejar huérfanos.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      // Si el usuario cancela ANTES de invocar el edge, salimos limpio.
      if (signal.aborted) return;
      const source = valueRef.current || JAVA_GUI_STARTER;
      // questionId no lo conocemos acá (el Runner es agnóstico). Pasamos
      // un marcador para que el edge function lo loguee — el audit
      // queda con entityId="java_gui_runner_preview" lo cual es OK
      // porque la pregunta real se identifica vía submissionId si el
      // padre la propaga (futuro).
      const invokePromise = supabase.functions.invoke("execute-java-gui-screenshot", {
        body: {
          sourceCode: source,
          questionId: "java_gui_runner_preview",
        },
      });
      // Race contra cancel — si el alumno pulsa Cancelar mientras el
      // Lambda corre, abandonamos la promesa (el Lambda termina solo
      // server-side). Liberamos UI inmediatamente.
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
            "El runner no devolvió captura. Revisa que tu código compile y abra al menos una ventana visible.",
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
      // Cancelación silenciosa — no mostramos error ni loggeamos.
      const msg = e instanceof Error ? e.message : "";
      if (msg === "__cancelled__") return;
      console.error("[JavaGuiRunner:screenshot]", e);
      setError(e instanceof Error ? e.message : "Error ejecutando Java");
    } finally {
      // Solo desreferenciamos si el controller sigue siendo el nuestro
      // — si cancelRun ya lo borró o un nuevo run lo sobrescribió, no
      // tocar lo que pertenece a otra ejecución.
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  };

  const runCheerp = async () => {
    setError(null);
    setHasRun(false);
    setRunning(true);
    setLoadingCJ(true);
    // Mismo patrón que runScreenshot: aborter dedicado al run.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    try {
      if (signal.aborted) return;
      await loadCheerpJ();
      setLoadingCJ(false);
      if (!displayRef.current || !consoleRef.current) {
        throw new Error("Contenedor de visualización no disponible");
      }

      consoleRef.current.id = "console";
      consoleRef.current.innerHTML = "";

      // Solo creamos el display la primera vez en este mount. Recrear
      // en cada click duplicaba canvases internos de CheerpJ y volvía
      // cada re-ejecución más lenta. Si ya existe, los frames Swing
      // viejos se limpian solos cuando el nuevo Main hace setVisible.
      if (!displayCreatedRef.current) {
        const rect = displayRef.current.getBoundingClientRect();
        const w = Math.max(360, Math.floor(rect.width) || 720);
        const h = Math.max(280, Math.floor(rect.height) || 480);
        window.cheerpjCreateDisplay?.(w, h, displayRef.current);
        displayCreatedRef.current = true;
      }

      const source = valueRef.current || JAVA_GUI_STARTER;
      const className = deriveMainClass(source);
      const sourcePath = `/str/${className}.java`;
      const enc = new TextEncoder();
      // Si CheerpJ no expone ninguna de estas APIs, antes seguíamos
      // adelante en silencio y la compilación fallaba con un error
      // críptico tipo "class not found" — el alumno no entendía por
      // qué nada funcionaba. Mejor un mensaje claro arriba.
      const addFile = window.cheerpOSAddStringFile ?? window.cheerpjAddStringFile;
      if (typeof addFile !== "function") {
        throw new Error("CheerpJ no expone AddStringFile (carga incompleta)");
      }
      if (typeof window.cheerpjRunMain !== "function") {
        throw new Error("CheerpJ no expone runMain (carga incompleta)");
      }
      addFile(sourcePath, enc.encode(source));

      const toolsBytes = await loadToolsJar();
      addFile("/str/tools.jar", toolsBytes);

      const classPath = "/str/tools.jar:/files/";
      const compileExit = await window.cheerpjRunMain(
        "com.sun.tools.javac.Main",
        classPath,
        sourcePath,
        "-d",
        "/files/",
      );
      if (compileExit !== 0) {
        throw new Error(
          `Errores de compilación (revisa la consola). Asegúrate que la clase pública se llame ${className} y el código compile.`,
        );
      }
      // Antes ignorábamos el exit code del run: si la JVM lanzaba una
      // excepción no capturada en main (NullPointerException, etc.),
      // el modal se mostraba sin Swing visible y sin mensaje de error,
      // dejando al alumno pensando que "no ejecuta". Capturamos y
      // surface en pantalla.
      const runExit = await window.cheerpjRunMain(className, classPath);
      if (runExit !== 0) {
        const runtimeLog = consoleRef.current?.textContent ?? "";
        throw new Error(
          runtimeLog.trim()
            ? `Excepción en ejecución (exit ${runExit}). Revisa la consola.`
            : `La JVM terminó con exit ${runExit} sin mensaje. ¿Tu main se ejecuta hasta el final?`,
        );
      }
      setHasRun(true);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "__cancelled__") return;
      console.error("[JavaGuiRunner]", e);
      setError(e instanceof Error ? e.message : "Error ejecutando Java");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
      setLoadingCJ(false);
    }
  };

  /** Cancela el run en curso (si lo hay). No mata el worker remoto —
   *  CheerpJ no tiene API de kill y el edge Lambda termina solo —
   *  pero libera la UI para que el estudiante pueda cambiar de modo
   *  o cerrar el dialog sin esperar. */
  const cancelRun = () => {
    const controller = abortRef.current;
    if (!controller) return;
    controller.abort();
    abortRef.current = null;
    setRunning(false);
    setLoadingCJ(false);
  };

  const run = () => (mode === "aws_screenshot" ? runScreenshot() : runCheerp());

  useEffect(() => {
    if (!dialogOpen) {
      // Al cerrar el modal, shadcn desmonta el DialogContent, por lo
      // que el displayRef.current actual deja de existir. La próxima
      // apertura tendrá un contenedor nuevo y necesita un createDisplay
      // fresco — sin este reset, intentaríamos reusar un canvas huérfano.
      displayCreatedRef.current = false;
      return;
    }
    if (mode === "aws_screenshot") void runScreenshot();
    else void runCheerp();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="outline" className="text-xs flex items-center gap-1">
            {mode === "aws_screenshot" ? (
              <>
                <Camera className="h-3 w-3" /> Java GUI — captura PNG
              </>
            ) : (
              <>
                <Coffee className="h-3 w-3" /> Java GUI (Swing / AWT)
              </>
            )}
          </Badge>
          {/* Override manual del modo. El admin configura el default; si
              ese modo falla durante el examen (CheerpJ no descarga, Lambda
              caído, etc.) el estudiante puede alternar sin perder la
              pregunta. Se deshabilita mientras hay una ejecución en curso
              para evitar carreras entre setMode y los handlers. */}
          {modeLoaded && (
            <Select
              value={mode}
              disabled={readOnly || running || loadingCJ}
              onValueChange={(v) => setMode(v as JavaGuiMode)}
            >
              <SelectTrigger className="h-7 w-48 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cheerp">CheerpJ (navegador)</SelectItem>
                <SelectItem value="aws_screenshot">AWS Lambda — captura</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={readOnly || !modeLoaded}
          className="h-8 text-xs"
          type="button"
        >
          {mode === "aws_screenshot" ? (
            <>
              <Camera className="h-3 w-3 mr-1" />
              Generar captura
            </>
          ) : (
            <>
              <Maximize2 className="h-3 w-3 mr-1" />
              Ejecutar y abrir vista Swing
            </>
          )}
        </Button>
      </div>

      {(error || hasRun) && !dialogOpen && (
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          {mode === "aws_screenshot" ? "Volver a ver la captura" : "Volver a abrir la vista Swing"}
        </button>
      )}

      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground bg-muted/30 border rounded-md px-2.5 py-1.5">
        <Info className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
        <span>
          {mode === "aws_screenshot"
            ? "Tu código corre en el servidor y solo recibes una captura de pantalla — no podrás interactuar (clicks, teclas) con la ventana. Diseña la UI con valores iniciales visibles."
            : "La primera ejecución tarda más porque el navegador descarga la máquina virtual de Java una sola vez. Las siguientes son inmediatas."}
        </span>
      </div>

      <div className="rounded-md border overflow-hidden">
        <Editor
          height={height}
          language="java"
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
        <DialogContent className="max-w-[95vw] w-[95vw] sm:max-w-[95vw] h-[92vh] flex flex-col p-4 gap-3">
          <DialogHeader className="space-y-1">
            <DialogTitle className="flex items-center gap-2 text-base">
              {mode === "aws_screenshot" ? (
                <Camera className="h-4 w-4" />
              ) : (
                <Coffee className="h-4 w-4" />
              )}
              {mode === "aws_screenshot"
                ? "Java GUI — captura del servidor"
                : "Java GUI — vista en vivo"}
              {(loadingCJ || running) && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                  <Spinner size="xs" />
                  {mode === "aws_screenshot"
                    ? "Compilando y capturando…"
                    : loadingCJ
                      ? "Cargando entorno Java…"
                      : "Ejecutando…"}
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
                  <Terminal className="h-3 w-3" /> Consola
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 flex-1 min-h-0 overflow-hidden">
                {mode === "aws_screenshot" ? (
                  <pre className="text-[11px] font-mono whitespace-pre-wrap overflow-auto h-full">
                    {screenshotData
                      ? [
                          screenshotData.stdout,
                          screenshotData.stderr,
                          `\n[runner] exit=${screenshotData.exitCode} • ${formatFileSize(screenshotData.pngBytes)} • ${screenshotData.executionTimeMs} ms`,
                          // Hint cuando la captura sale prácticamente
                          // vacía (~3-4KB es Xvfb sin contenido). El
                          // patrón típico es: SwingUtilities.invokeLater
                          // es ASÍNCRONO, y si main termina antes de
                          // que el EDT pinte, la JVM se cierra con el
                          // framebuffer en negro. Sugerimos el fix.
                          screenshotData.exitCode === 0 &&
                          screenshotData.pngBytes > 0 &&
                          screenshotData.pngBytes < 4000
                            ? "\n[hint] La captura quedó vacía. Probablemente tu main terminó antes\n" +
                              "       de que Swing pintara la ventana. Agrega al final de main:\n" +
                              "         Thread.sleep(5000);  // o más, hasta que veas la ventana\n" +
                              "       O usa SwingUtilities.invokeAndWait(...) en lugar de invokeLater."
                            : "",
                        ]
                          .filter(Boolean)
                          .join("\n")
                      : running
                        ? ""
                        : "(sin ejecución todavía)"}
                  </pre>
                ) : (
                  <pre
                    ref={consoleRef}
                    className="text-[11px] font-mono whitespace-pre-wrap overflow-auto h-full"
                  />
                )}
              </CardContent>
            </Card>
            <Card className="bg-muted/40 flex flex-col min-h-0">
              <CardHeader className="py-2 px-3 shrink-0">
                <CardTitle className="text-xs flex items-center gap-1.5">
                  {mode === "aws_screenshot" ? (
                    <>
                      <Camera className="h-3 w-3" /> Captura
                    </>
                  ) : (
                    <>
                      <Coffee className="h-3 w-3" /> Ventana Swing
                    </>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 flex-1 min-h-0 overflow-hidden">
                {mode === "aws_screenshot" ? (
                  // Fondo checkerboard sutil (patrón gris claro sobre
                  // blanco). Antes era `bg-white` sólido pero los JFrames
                  // Swing tienen background propio (gris claro / blanco)
                  // y se fundían — el alumno no veía dónde empieza la
                  // ventana. El checkerboard es el patrón estándar de
                  // visores de imágenes (Figma, Photoshop, Preview) para
                  // distinguir contenido del "vacío"; aquí cumple lo
                  // mismo: el JFrame queda visualmente recortado contra
                  // el patrón. Implementado con un linear-gradient inline
                  // para no agregar config Tailwind nueva.
                  <div
                    className="w-full h-full rounded border overflow-auto flex items-start justify-start p-2 relative"
                    style={{
                      backgroundColor: "#f4f4f5",
                      backgroundImage:
                        "linear-gradient(45deg, #e4e4e7 25%, transparent 25%, transparent 75%, #e4e4e7 75%), linear-gradient(45deg, #e4e4e7 25%, transparent 25%, transparent 75%, #e4e4e7 75%)",
                      backgroundSize: "16px 16px",
                      backgroundPosition: "0 0, 8px 8px",
                    }}
                  >
                    {screenshotData?.png ? (
                      <>
                        <img
                          src={`data:image/png;base64,${screenshotData.png}`}
                          alt="Captura de la ventana Swing renderizada en el servidor"
                          className="max-w-full max-h-full object-contain"
                        />
                        {/* Banner inferior cuando el PNG es prácticamente
                            un framebuffer vacío. Threshold 2KB porque a
                            800x600 incluso un JFrame pequeño con texto
                            ya comprime a 3-4KB; subir el threshold daba
                            falsos positivos con capturas legítimas
                            (e.g. "Hola Mundo" centrado salía como 3.5KB
                            y el banner aparecía incorrectamente). 2KB
                            es prácticamente solo el background sólido
                            de Xvfb sin ningún render Swing. */}
                        {screenshotData.exitCode === 0 &&
                          screenshotData.pngBytes > 0 &&
                          screenshotData.pngBytes < 2000 && (
                            <div className="absolute inset-x-2 bottom-2 bg-amber-50/95 dark:bg-amber-950/95 border border-amber-300 dark:border-amber-700 rounded-md p-2 text-[10px] leading-snug shadow-md">
                              <p className="font-semibold text-amber-700 dark:text-amber-300">
                                La ventana no alcanzó a pintarse — el PNG quedó casi vacío.
                              </p>
                              <p className="text-amber-900 dark:text-amber-200 mt-0.5">
                                Tu <code className="font-mono">main</code> terminó antes de que
                                Swing pintara. Agrega <code className="font-mono">Thread.sleep(5000);</code>{" "}
                                al final de <code className="font-mono">main</code> (con{" "}
                                <code className="font-mono">throws Exception</code> en la firma), o
                                envuelve la creación del JFrame en{" "}
                                <code className="font-mono">SwingUtilities.invokeAndWait(...)</code>.
                              </p>
                            </div>
                          )}
                      </>
                    ) : running ? (
                      <span className="text-xs text-muted-foreground">Esperando captura…</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Sin captura disponible.</span>
                    )}
                  </div>
                ) : (
                  <div
                    ref={displayRef}
                    className="w-full h-full bg-background rounded border overflow-auto"
                  />
                )}
              </CardContent>
            </Card>
          </div>

          <div className="flex items-center justify-end gap-2 shrink-0">
            {/* Cancelar visible solo si hay run en curso. Liberar UI
                permite cambiar de modo (cheerp ↔ aws_screenshot) sin
                tener que esperar a que CheerpJ termine de descargar
                tools.jar o a que el Lambda haga el screenshot. */}
            {(running || loadingCJ) && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={cancelRun}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                title="Cancelar la ejecución actual (libera la UI sin esperar a que termine)"
              >
                <X className="h-3 w-3 mr-1" />
                Cancelar
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => void run()}
              disabled={running || loadingCJ}
            >
              {running || loadingCJ ? (
                <Spinner size="xs" className="mr-1" />
              ) : (
                <RotateCcw className="h-3 w-3 mr-1" />
              )}
              {mode === "aws_screenshot" ? "Re-generar captura" : "Re-ejecutar"}
            </Button>
            <Button size="sm" variant="default" type="button" onClick={() => setDialogOpen(false)}>
              Cerrar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

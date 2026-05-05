/**
 * JavaGuiRunner — editor Monaco + ejecución client-side de Java Swing/AWT
 * mediante CheerpJ 3 (cargado lazy desde su CDN, sin dependencias npm).
 *
 * Patrón basado en https://github.com/leaningtech/javafiddle:
 *   1. cheerpjInit({status:'none'})
 *   2. cheerpjCreateDisplay(-1,-1, container)  → ventana Swing
 *   3. cheerpjAddStringFile('/str/Main.java', encoder.encode(code))
 *   4. cheerpjRunMain('com.sun.tools.javac.Main','/app/tools.jar:/files/','/str/Main.java','-d','/files/')
 *   5. cheerpjRunMain('Main','/app/tools.jar:/files/')
 *
 * El código fuente se reporta vía onChange y se guarda como respuesta de
 * texto para ser calificada por la IA igual que las preguntas de "código".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Loader2, Play, Coffee, AlertTriangle, Terminal, Maximize2, RotateCcw, Info } from "lucide-react";

declare global {
  interface Window {
    cheerpjInit?: (opts?: any) => Promise<void>;
    cheerpjCreateDisplay?: (
      width: number,
      height: number,
      container?: HTMLElement,
    ) => void;
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
            JFrame frame = new JFrame("Hola CheerpJ");
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
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHEERPJ_SRC}"]`,
    );
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

  const run = async () => {
    setError(null);
    setHasRun(false);
    setRunning(true);
    setLoadingCJ(true);
    try {
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
      console.error("[JavaGuiRunner]", e);
      setError(e instanceof Error ? e.message : "Error ejecutando Java");
    } finally {
      setRunning(false);
      setLoadingCJ(false);
    }
  };

  useEffect(() => {
    if (dialogOpen) {
      void run();
    } else {
      // Al cerrar el modal, shadcn desmonta el DialogContent, por lo
      // que el displayRef.current actual deja de existir. La próxima
      // apertura tendrá un contenedor nuevo y necesita un createDisplay
      // fresco — sin este reset, intentaríamos reusar un canvas huérfano.
      displayCreatedRef.current = false;
    }
  }, [dialogOpen]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="text-xs flex items-center gap-1">
          <Coffee className="h-3 w-3" /> Java GUI (Swing / AWT) — CheerpJ
        </Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={readOnly}
          className="h-8 text-xs"
          type="button"
        >
          <Maximize2 className="h-3 w-3 mr-1" />
          Ejecutar y abrir vista Swing
        </Button>
      </div>

      {(error || hasRun) && !dialogOpen && (
        <button
          type="button"
          onClick={() => setDialogOpen(true)}
          className="text-xs text-primary underline-offset-2 hover:underline"
        >
          Volver a abrir la vista Swing
        </button>
      )}

      <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground bg-muted/30 border rounded-md px-2.5 py-1.5">
        <Info className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
        <span>
          La primera ejecución tarda más porque el navegador descarga la
          máquina virtual de Java una sola vez. Las siguientes son inmediatas.
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
              <Coffee className="h-4 w-4" />
              Java GUI — vista en vivo
              {(loadingCJ || running) && (
                <span className="ml-2 inline-flex items-center gap-1 text-xs font-normal text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  {loadingCJ ? "Cargando CheerpJ…" : "Ejecutando…"}
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
                <pre
                  ref={consoleRef}
                  className="text-[11px] font-mono whitespace-pre-wrap overflow-auto h-full"
                />
              </CardContent>
            </Card>
            <Card className="bg-muted/40 flex flex-col min-h-0">
              <CardHeader className="py-2 px-3 shrink-0">
                <CardTitle className="text-xs flex items-center gap-1.5">
                  <Coffee className="h-3 w-3" /> Ventana Swing
                </CardTitle>
              </CardHeader>
              <CardContent className="px-3 pb-3 pt-0 flex-1 min-h-0 overflow-hidden">
                <div
                  ref={displayRef}
                  className="w-full h-full bg-background rounded border overflow-auto"
                />
              </CardContent>
            </Card>
          </div>

          <div className="flex items-center justify-end gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              type="button"
              onClick={() => void run()}
              disabled={running || loadingCJ}
            >
              {running || loadingCJ ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <RotateCcw className="h-3 w-3 mr-1" />
              )}
              Re-ejecutar
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

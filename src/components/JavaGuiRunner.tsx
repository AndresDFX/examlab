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
import { Loader2, Play, Coffee, AlertTriangle, Terminal } from "lucide-react";

declare global {
  interface Window {
    cheerpjInit?: (opts?: any) => Promise<void>;
    cheerpjCreateDisplay?: (
      width: number,
      height: number,
      container?: HTMLElement,
    ) => void;
    cheerpjRunMain?: (cls: string, cp: string, ...args: string[]) => Promise<number>;
    cheerpjAddStringFile?: (path: string, contents: Uint8Array) => void;
    __cheerpjLoading?: Promise<void>;
    __cheerpjReady?: boolean;
  }
}

const CHEERPJ_SRC = "https://cjrtnc.leaningtech.com/3.0/cj3loader.js";

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

  window.__cheerpjLoading = new Promise<void>((resolve, reject) => {
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
  return window.__cheerpjLoading;
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
}

export function JavaGuiRunner({
  value,
  onChange,
  height = "320px",
  readOnly = false,
}: Props) {
  const editorRef = useRef<any>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLPreElement>(null);
  const [loadingCJ, setLoadingCJ] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasRun, setHasRun] = useState(false);

  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains("dark"));
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const run = async () => {
    setError(null);
    setRunning(true);
    setLoadingCJ(true);
    try {
      await loadCheerpJ();
      setLoadingCJ(false);
      if (!displayRef.current || !consoleRef.current) {
        throw new Error("Contenedor de visualización no disponible");
      }

      // CheerpJ busca implícitamente #console para escribir stdout/stderr.
      // Como puede haber varios runners en la misma página, mientras corre
      // este lo asignamos al elemento global.
      consoleRef.current.id = "console";
      consoleRef.current.innerHTML = "";

      // Crea el display Swing dentro de nuestro contenedor (limpia previo).
      displayRef.current.innerHTML = "";
      window.cheerpjCreateDisplay?.(-1, -1, displayRef.current);

      const className = deriveMainClass(value || JAVA_GUI_STARTER);
      const sourcePath = `/str/${className}.java`;
      const enc = new TextEncoder();
      window.cheerpjAddStringFile?.(sourcePath, enc.encode(value || JAVA_GUI_STARTER));

      const classPath = "/app/tools.jar:/files/";
      const compileExit = await window.cheerpjRunMain?.(
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
      await window.cheerpjRunMain?.(className, classPath);
      setHasRun(true);
    } catch (e: any) {
      console.error("[JavaGuiRunner]", e);
      setError(e?.message ?? "Error ejecutando Java");
    } finally {
      setRunning(false);
      setLoadingCJ(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="text-xs flex items-center gap-1">
          <Coffee className="h-3 w-3" /> Java GUI (Swing / AWT) — CheerpJ
        </Badge>
        <Button
          size="sm"
          variant="outline"
          onClick={run}
          disabled={running || readOnly}
          className="h-8 text-xs"
        >
          {running ? (
            <Loader2 className="h-3 w-3 mr-1 animate-spin" />
          ) : (
            <Play className="h-3 w-3 mr-1" />
          )}
          {loadingCJ ? "Cargando CheerpJ…" : running ? "Ejecutando…" : "Ejecutar"}
        </Button>
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

      <div className="grid md:grid-cols-2 gap-2">
        <Card className="bg-muted/40">
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Terminal className="h-3 w-3" /> Consola
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            <pre
              ref={consoleRef}
              className="text-[11px] font-mono whitespace-pre-wrap max-h-48 overflow-auto min-h-[60px]"
            />
          </CardContent>
        </Card>
        <Card className="bg-muted/40">
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Coffee className="h-3 w-3" /> Ventana Swing
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            {error && (
              <div className="flex items-start gap-2 text-xs text-destructive mb-2">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            {!hasRun && !error && (
              <p className="text-[11px] text-muted-foreground">
                Pulsa <strong>Ejecutar</strong> para compilar y abrir la ventana Swing.
              </p>
            )}
            <div
              ref={displayRef}
              className="w-full min-h-[200px] bg-background rounded border"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

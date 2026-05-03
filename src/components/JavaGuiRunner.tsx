/**
 * JavaGuiRunner — editor Monaco + ejecución client-side de Java Swing/AWT
 * mediante CheerpJ 3 (cargado lazy desde su CDN, sin dependencias npm).
 *
 * Renderiza la ventana Swing/AWT dentro de un <div> en el navegador.
 * El código fuente se reporta vía onChange y se guarda como respuesta de
 * texto para ser calificada por la IA igual que las preguntas de "código".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, Play, Coffee, AlertTriangle } from "lucide-react";

declare global {
  interface Window {
    cheerpjInit?: (opts?: any) => Promise<void>;
    cheerpjRunJar?: (path: string, ...args: string[]) => Promise<number>;
    cheerpjCreateDisplay?: (
      width: number,
      height: number,
      container: HTMLElement,
    ) => void;
    cheerpOSAddStringFile?: (path: string, contents: string) => void;
    cjFileBlob?: (path: string) => Promise<Blob>;
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
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHEERPJ_SRC}"]`,
    );
    const onReady = async () => {
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
    if (existing) {
      if (window.cheerpjInit) void onReady();
      else existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener("error", () => reject(new Error("No se pudo cargar CheerpJ")), {
        once: true,
      });
      return;
    }
    const s = document.createElement("script");
    s.src = CHEERPJ_SRC;
    s.async = true;
    s.onload = onReady;
    s.onerror = () => reject(new Error("No se pudo cargar CheerpJ"));
    document.head.appendChild(s);
  });
  return window.__cheerpjLoading;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  uniqueId?: string;
}

export function JavaGuiRunner({
  value,
  onChange,
  height = "320px",
  readOnly = false,
  uniqueId,
}: Props) {
  const editorRef = useRef<any>(null);
  const displayRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
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
    setLoading(true);
    try {
      await loadCheerpJ();
      setLoading(false);
      if (!displayRef.current) throw new Error("Contenedor no disponible");
      // Limpia render previo
      displayRef.current.innerHTML = "";
      window.cheerpjCreateDisplay?.(
        Math.max(displayRef.current.clientWidth || 600, 320),
        420,
        displayRef.current,
      );

      // Escribir el .java al filesystem virtual (/str/)
      const id = (uniqueId ?? "anon").replace(/[^a-zA-Z0-9_-]/g, "_");
      const sourcePath = `/str/Main_${id}.java`;
      // CheerpJ requiere que el nombre del archivo coincida con la clase pública.
      // Para simplificar, exigimos que la clase pública se llame Main.
      window.cheerpOSAddStringFile?.("/str/Main.java", value || JAVA_GUI_STARTER);

      // Compilar usando el javac empaquetado por CheerpJ (jar incluido)
      const cjCompile = window.cheerpjRunJar;
      if (!cjCompile) throw new Error("CheerpJ no está listo");

      const compileExit = await cjCompile(
        "/app/tools.jar",
        "com.sun.tools.javac.Main",
        "/str/Main.java",
        "-d",
        "/files/",
      );
      if (compileExit !== 0) {
        throw new Error("Errores de compilación. Revisa la consola del navegador.");
      }

      // Ejecutar la clase compilada
      // Usamos cheerpjRunMain via -cp /files/
      const w = window as any;
      const runMain = w.cheerpjRunMain as
        | ((cls: string, cp: string, ...args: string[]) => Promise<number>)
        | undefined;
      if (!runMain) throw new Error("cheerpjRunMain no disponible");
      await runMain("Main", "/files/");
      setHasRun(true);
      // sourcePath unused but kept for future per-question isolation
      void sourcePath;
    } catch (e: any) {
      console.error("[JavaGuiRunner]", e);
      setError(e?.message ?? "Error ejecutando Java");
    } finally {
      setRunning(false);
      setLoading(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="text-xs flex items-center gap-1">
          <Coffee className="h-3 w-3" /> Java GUI (Swing / AWT)
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
          {loading ? "Cargando CheerpJ…" : running ? "Ejecutando…" : "Ejecutar"}
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
            <p className="text-xs text-muted-foreground">
              Pulsa <strong>Ejecutar</strong> para compilar y abrir la ventana Swing dentro del
              navegador. La clase pública debe llamarse <code>Main</code>.
            </p>
          )}
          <div
            ref={displayRef}
            className="w-full min-h-[200px] bg-background rounded border"
          />
        </CardContent>
      </Card>
    </div>
  );
}

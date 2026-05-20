import { useCallback, useRef, useState, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Play, Terminal, Info, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

export type CodeLanguage = "java" | "python" | "javascript";

/**
 * Plantilla por defecto para preguntas de tipo `codigo` con
 * `language='java'`. Usada como starter_code al crear preguntas
 * nuevas en el form del docente y como fallback en el taker del
 * estudiante cuando una pregunta vieja no tiene starter_code.
 *
 * Es deliberadamente mínima — clase Main + main + un println — para
 * que el estudiante arranque desde algo compilable y enfoque su
 * tiempo en el problema, no en escribir el boilerplate.
 */
export const JAVA_STARTER = `public class Main {
    public static void main(String[] args) {
        System.out.println("Holi");
    }
}`;

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeLanguage;
  onLanguageChange?: (lang: CodeLanguage) => void;
  onRun?: () => void;
  /** Si se provee + `isRunning=true`, aparece un botón "Cancelar" al
   *  lado del de Ejecutar. Útil cuando el estudiante quiere cambiar de
   *  compilador (ej. CheerpJ se quedó pegado descargando tools.jar) sin
   *  esperar a que termine el run actual. La cancelación no necesariamente
   *  mata el worker remoto (especialmente CheerpJ no expone API de kill),
   *  pero libera la UI inmediatamente para que el alumno pueda reintentar
   *  con otro provider. */
  onCancel?: () => void;
  output?: string;
  isRunning?: boolean;
  readOnly?: boolean;
  height?: string;
  showLanguageSelector?: boolean;
  showRunButton?: boolean;
  /**
   * Bloquea silenciosamente copiar/pegar/cortar dentro del editor.
   * Usado en el flujo de examen — Monaco intercepta los atajos antes
   * que el listener de documento, así que hay que deshabilitarlos
   * a nivel del editor o se cuela el paste.
   */
  blockClipboard?: boolean;
  /** Esconde tips informativos (ej. el banner de Java cold-start).
   *  Útil para vistas read-only de revisión donde el banner sobra. */
  hideHints?: boolean;
}

const LANGUAGE_CONFIG: Record<
  CodeLanguage,
  { label: string; monacoLang: string; defaultCode: string }
> = {
  java: {
    label: "Java",
    monacoLang: "java",
    defaultCode: `public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello, World!");\n    }\n}`,
  },
  python: {
    label: "Python",
    monacoLang: "python",
    defaultCode: `print("Hello, World!")`,
  },
  javascript: {
    label: "JavaScript",
    monacoLang: "javascript",
    defaultCode: `console.log("Hello, World!");`,
  },
};

export function CodeEditor({
  value,
  onChange,
  language = "java",
  onLanguageChange,
  onRun,
  onCancel,
  output,
  isRunning = false,
  readOnly = false,
  height = "300px",
  showLanguageSelector = true,
  showRunButton = true,
  blockClipboard = false,
  hideHints = false,
}: CodeEditorProps) {
  const editorRef = useRef<any>(null);

  const handleMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      if (blockClipboard) {
        // 1) Atajos de teclado: anula la acción a nivel de Monaco.
        const noop = () => {};
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, noop);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, noop);
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, noop);
        editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Insert, noop);
        // 2) Red de seguridad: si algo se cuela (clic derecho → Pegar,
        //    drag-drop, menú Edit del browser), undo inmediato. La
        //    inserción ocurre y se revierte en el mismo tick — el
        //    estudiante no logra dejarlo en el editor.
        editor.onDidPaste(() => {
          editor.trigger("anti-paste", "undo", null);
        });
      }
    },
    [blockClipboard],
  );

  // Fallback a Java si el q.language guardado no está en
  // LANGUAGE_CONFIG (p. ej. valor heredado de migraciones, "html",
  // null o un typo). Sin esto config queda undefined y el render
  // crashea con "Cannot read properties of undefined (reading 'label')".
  const config = LANGUAGE_CONFIG[language] ?? LANGUAGE_CONFIG.java;

  // Reactive dark mode detection
  const [isDark, setIsDark] = useState(false);
  useEffect(() => {
    const check = () => setIsDark(document.documentElement.classList.contains("dark"));
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        {showLanguageSelector && onLanguageChange && (
          <Select value={language} onValueChange={(v) => onLanguageChange(v as CodeLanguage)}>
            <SelectTrigger className="w-[140px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="java">Java</SelectItem>
              <SelectItem value="python">Python</SelectItem>
              <SelectItem value="javascript">JavaScript</SelectItem>
            </SelectContent>
          </Select>
        )}
        {!showLanguageSelector && (
          <Badge variant="outline" className="text-xs">
            {config.label}
          </Badge>
        )}
        {showRunButton && onRun && (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={onRun}
              disabled={isRunning}
              className="h-8 text-xs"
            >
              {isRunning ? (
                <Spinner size="xs" className="mr-1" />
              ) : (
                <Play className="h-3 w-3 mr-1" />
              )}
              Ejecutar
            </Button>
            {/* Cancelar visible solo mientras hay un run en curso. Si
                el caller no pasó onCancel, no lo mostramos — algunos
                callers (review read-only, etc.) no implementan cancel. */}
            {isRunning && onCancel && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onCancel}
                className="h-8 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                title="Cancelar la ejecución actual (libera la UI para cambiar de compilador o reintentar)"
              >
                <X className="h-3 w-3 mr-1" />
                Cancelar
              </Button>
            )}
          </div>
        )}
      </div>

      {language === "java" && !hideHints && (
        <div className="flex items-start gap-1.5 text-[11px] text-muted-foreground bg-muted/30 border rounded-md px-2.5 py-1.5">
          <Info className="h-3 w-3 mt-0.5 shrink-0 text-primary" />
          <span>
            La primera ejecución de Java tarda más porque el navegador descarga la máquina virtual
            una sola vez. Las siguientes son inmediatas.
          </span>
        </div>
      )}

      <div className="rounded-md border overflow-hidden">
        <Editor
          height={height}
          language={config.monacoLang}
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

      {output !== undefined && (
        <Card className="bg-muted/50">
          <CardHeader className="py-2 px-3">
            <CardTitle className="text-xs flex items-center gap-1.5">
              <Terminal className="h-3 w-3" /> Salida
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-3 pt-0">
            <pre className="text-xs font-mono whitespace-pre-wrap max-h-40 overflow-auto">
              {output || "(sin salida)"}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

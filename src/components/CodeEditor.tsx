import { useCallback, useRef, useState, useEffect } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Play, Loader2, Terminal } from "lucide-react";

export type CodeLanguage = "java" | "python" | "javascript";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language?: CodeLanguage;
  onLanguageChange?: (lang: CodeLanguage) => void;
  onRun?: () => void;
  output?: string;
  isRunning?: boolean;
  readOnly?: boolean;
  height?: string;
  showLanguageSelector?: boolean;
  showRunButton?: boolean;
}

const LANGUAGE_CONFIG: Record<CodeLanguage, { label: string; monacoLang: string; defaultCode: string }> = {
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
  output,
  isRunning = false,
  readOnly = false,
  height = "300px",
  showLanguageSelector = true,
  showRunButton = true,
}: CodeEditorProps) {
  const editorRef = useRef<any>(null);

  const handleMount: OnMount = useCallback((editor) => {
    editorRef.current = editor;
  }, []);

  const config = LANGUAGE_CONFIG[language];

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
          <Badge variant="outline" className="text-xs">{config.label}</Badge>
        )}
        {showRunButton && onRun && (
          <Button size="sm" variant="outline" onClick={onRun} disabled={isRunning} className="h-8 text-xs">
            {isRunning ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Play className="h-3 w-3 mr-1" />}
            Ejecutar
          </Button>
        )}
      </div>

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

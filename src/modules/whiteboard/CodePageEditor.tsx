/**
 * CodePageEditor — hoja de CÓDIGO de una pizarra (`whiteboard_pages.page_type='code'`).
 *
 * Contraparte de `TextPageEditor` (hoja markdown) y `WhiteboardEditor` (hoja
 * dibujo): permite al docente mostrar un COMPILADOR en vivo dentro de la
 * pizarra —sin tener que crear un taller— y que la SALIDA del último run quede
 * cacheada para que el alumno la vea al revisar la pizarra después.
 *
 * Reusa `CodeEditor` (Monaco) + el edge `execute-code`, mismo patrón que
 * `SessionCodeSnippets`. El padre (`MultiPageWhiteboard`) persiste vía
 * `onPersist(patch)` (escribe en `whiteboard_pages` + sincroniza su state), igual
 * que `persistTextPage`/`persistDrawingPage`.
 *
 * Modo readOnly (alumno): puede ejecutar para probar, pero su salida NO se
 * persiste (queda local hasta recargar) — solo el docente cachea `last_*`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { CodeEditor, type CodeLanguage, getStarterCode } from "@/modules/code/CodeEditor";
import { combineFilesForExec } from "@/modules/code/combine-files";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatTime } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";

interface Props {
  pageId: string;
  language: string | null;
  source: string | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  executedAt: string | null;
  readOnly?: boolean;
  /** El padre persiste el patch en `whiteboard_pages` + actualiza su state. */
  onPersist: (patch: Record<string, unknown>) => void;
  className?: string;
}

const LANG_FILENAME: Record<string, string> = {
  java: "Main.java",
  python: "main.py",
  javascript: "main.js",
};

export function CodePageEditor({
  pageId,
  language,
  source,
  stdout,
  stderr,
  exitCode,
  executedAt,
  readOnly,
  onPersist,
  className,
}: Props) {
  const { t } = useTranslation();
  const [lang, setLang] = useState<string>(language || "java");
  const [code, setCode] = useState<string>(source ?? getStarterCode(language || "java"));
  const [running, setRunning] = useState(false);
  // Salida local del alumno (readOnly) — no se persiste.
  const [localOut, setLocalOut] = useState<{ stdout: string; stderr: string; exitCode: number } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Último patch pendiente + ref al onPersist actual, para FLUSHear el guardado
  // debounced al desmontar (cambio de hoja / cierre de pizarra) sin perder el
  // último cambio. Mismo patrón que TextPageEditor/WhiteboardEditor.
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (pendingRef.current) onPersistRef.current(pendingRef.current);
      }
    };
  }, []);

  const scheduleSourceSave = useCallback(
    (nextCode: string) => {
      if (readOnly) return;
      pendingRef.current = { code_source: nextCode };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        if (pendingRef.current) onPersistRef.current(pendingRef.current);
        pendingRef.current = null;
        saveTimer.current = null;
      }, 1200);
    },
    [readOnly],
  );

  const onCodeChange = (v: string) => {
    setCode(v);
    scheduleSourceSave(v);
  };

  const onLangChange = (v: string) => {
    if (readOnly) return;
    setLang(v);
    // Cancelar cualquier guardado de fuente pendiente: el onPersist de abajo ya
    // persiste el estado nuevo (incl. code_source si reseteamos el starter).
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingRef.current = null;
    const patch: Record<string, unknown> = { code_language: v };
    // Si el editor está vacío o aún trae el starter del lenguaje anterior,
    // reemplazamos por el starter del nuevo lenguaje (mejor UX al cambiar).
    const prevStarter = getStarterCode(lang as CodeLanguage).trim();
    if (!code.trim() || code.trim() === prevStarter) {
      const nextStarter = getStarterCode(v as CodeLanguage);
      setCode(nextStarter);
      patch.code_source = nextStarter;
    }
    onPersist(patch);
  };

  const run = async () => {
    if (!code.trim()) {
      toast.error(
        t("hc_modulesWhiteboardCodePageEditor.emptyCode", { defaultValue: "La hoja de código está vacía" }),
      );
      return;
    }
    setRunning(true);
    try {
      const files = [{ filename: LANG_FILENAME[lang] ?? "main.txt", content: code }];
      const { data, error } = await supabase.functions.invoke("execute-code", {
        body: {
          files,
          sourceCode: combineFilesForExec(files, lang),
          language: lang,
          // pageId como metadata de audit (no es FK a questions).
          questionId: pageId,
        },
      });
      if (error || data?.error) {
        toast.error(
          friendlyError(
            error ?? data?.error,
            t("hc_modulesWhiteboardCodePageEditor.runFailed", { defaultValue: "No se pudo ejecutar el código" }),
          ),
        );
        return;
      }
      const out = {
        stdout: (data?.stdout as string) ?? "",
        stderr: (data?.stderr as string) ?? "",
        exitCode: typeof data?.exitCode === "number" ? data.exitCode : 0,
      };
      if (readOnly) {
        setLocalOut(out);
      } else {
        onPersist({
          last_stdout: out.stdout,
          last_stderr: out.stderr,
          last_exit_code: out.exitCode,
          last_executed_at: new Date().toISOString(),
        });
      }
    } finally {
      setRunning(false);
    }
  };

  const output = readOnly
    ? localOut
    : executedAt
      ? { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: exitCode ?? 0 }
      : null;

  return (
    <div className={cn("flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-2", className)}>
      {!readOnly && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {t("hc_modulesWhiteboardCodePageEditor.language", { defaultValue: "Lenguaje" })}
          </span>
          <Select value={lang} onValueChange={onLangChange}>
            <SelectTrigger className="h-8 w-[140px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="java">Java</SelectItem>
              <SelectItem value="python">Python</SelectItem>
              <SelectItem value="javascript">JavaScript</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}
      <CodeEditor
        value={code}
        onChange={onCodeChange}
        language={(lang as CodeLanguage) ?? "java"}
        showLanguageSelector={false}
        showRunButton
        onRun={() => void run()}
        isRunning={running}
        readOnly={readOnly}
        hideHints
        height="55vh"
        output={
          output
            ? [output.stdout, output.stderr ? `\n[stderr]\n${output.stderr}` : ""].filter(Boolean).join("")
            : undefined
        }
      />
      {output && (
        <div className="text-[10px] text-muted-foreground">
          exit {output.exitCode}
          {!readOnly && executedAt && (
            <span className="ml-2">
              • {t("hc_modulesWhiteboardCodePageEditor.lastRun", {
                defaultValue: "Última ejecución {{time}}",
                time: formatTime(executedAt),
              })}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

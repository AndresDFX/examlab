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
import {
  CodeRunnerPicker,
  type CodeRunnerProvider,
  providersForLanguage,
} from "@/modules/code/CodeRunnerPicker";
import { runJavaInBrowser, CANCELLED_SENTINEL } from "@/modules/code/run-java";
import { useConfirm } from "@/shared/components/ConfirmDialog";
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
  const confirm = useConfirm();
  const [lang, setLang] = useState<string>(language || "java");
  const [code, setCode] = useState<string>(source ?? getStarterCode(language || "java"));
  const [running, setRunning] = useState(false);
  // Salida local del alumno (readOnly) — no se persiste.
  const [localOut, setLocalOut] = useState<{ stdout: string; stderr: string; exitCode: number } | null>(null);
  // Selector de compilador (paridad con el examen): default global del admin
  // (code_execution_settings) + override local por hoja. cheerp corre en el
  // navegador (solo Java); el resto via edge execute-code.
  const [defaultProvider, setDefaultProvider] = useState<string>("onlinecompiler");
  const [runnerOverride, setRunnerOverride] = useState<CodeRunnerProvider | undefined>(undefined);
  const runAbortRef = useRef<AbortController | null>(null);
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
      // Abortar cualquier run en curso al desmontar (cambio de hoja / cierre).
      runAbortRef.current?.abort();
    };
  }, []);

  // Provider de ejecución por defecto (global del admin). SELECT abierto a
  // authenticated (el alumno también lo necesita para ejecutar). Guard cancelled.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("code_execution_settings")
        .select("provider")
        .limit(1)
        .maybeSingle();
      if (cancelled) return;
      const p = (data as { provider?: string } | null)?.provider;
      if (p) setDefaultProvider(p);
    })();
    return () => {
      cancelled = true;
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

  const onLangChange = async (v: string) => {
    if (readOnly || v === lang) return;
    const prevStarter = getStarterCode(lang as CodeLanguage).trim();
    const hasRealCode = code.trim() !== "" && code.trim() !== prevStarter;
    // Cambiar de lenguaje REEMPLAZA el código por el ejemplo (template) del
    // nuevo lenguaje — no se "traduce" el código. Si hay código propio,
    // confirmamos la pérdida antes de pisarlo.
    if (hasRealCode) {
      const ok = await confirm({
        title: t("hc_modulesWhiteboardCodePageEditor.langChangeTitle", {
          defaultValue: "¿Cambiar de lenguaje?",
        }),
        description: t("hc_modulesWhiteboardCodePageEditor.langChangeDesc", {
          defaultValue:
            "Al cambiar el lenguaje se reemplaza el código actual por el ejemplo del nuevo lenguaje. Se perderá lo que escribiste en esta hoja. Esta acción no se puede deshacer.",
        }),
        tone: "warning",
        confirmLabel: t("hc_modulesWhiteboardCodePageEditor.langChangeConfirm", {
          defaultValue: "Cambiar y reemplazar",
        }),
      });
      if (!ok) return; // mantener el lenguaje actual
    }
    // Cancelar guardado de fuente pendiente (vamos a pisar el código).
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    pendingRef.current = null;
    // Si el nuevo lenguaje no soporta el compilador elegido (ej. cheerp es
    // Java-only y cambio a python), volver al default para no ejecutar con un
    // provider inválido.
    setRunnerOverride((prev) =>
      prev && !providersForLanguage(v as CodeLanguage).includes(prev) ? undefined : prev,
    );
    setLang(v);
    // Cargar SIEMPRE el ejemplo (template) del nuevo lenguaje.
    const nextStarter = getStarterCode(v as CodeLanguage);
    setCode(nextStarter);
    onPersist({ code_language: v, code_source: nextStarter });
  };

  const run = async () => {
    if (!code.trim()) {
      toast.error(
        t("hc_modulesWhiteboardCodePageEditor.emptyCode", { defaultValue: "La hoja de código está vacía" }),
      );
      return;
    }
    // Provider efectivo: override de la hoja o el default global. cheerp corre
    // client-side (solo Java); el resto via edge execute-code. Mismo patrón que
    // el examen (app.student.take.$examId.tsx runCode).
    const provider = runnerOverride ?? defaultProvider;
    runAbortRef.current?.abort();
    const controller = new AbortController();
    runAbortRef.current = controller;
    const { signal } = controller;
    setRunning(true);
    try {
      let stdout = "";
      let stderr = "";
      let exitCode = 0;
      if (provider === "cheerp" && lang === "java") {
        // Java en el navegador (CheerpJ), sin API externa ni cuota.
        const result = await runJavaInBrowser(code, signal);
        stdout = result.stdout;
        stderr = result.stderr;
      } else {
        const files = [{ filename: LANG_FILENAME[lang] ?? "main.txt", content: code }];
        // Carrera contra el abort para liberar la UI si el usuario cancela;
        // el edge sigue server-side pero al usuario ya no le importa.
        const cancelPromise = new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error(CANCELLED_SENTINEL));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error(CANCELLED_SENTINEL)), { once: true });
        });
        const invokePromise = supabase.functions.invoke("execute-code", {
          body: {
            files,
            sourceCode: combineFilesForExec(files, lang),
            language: lang,
            // pageId como metadata de audit (no es FK a questions).
            questionId: pageId,
            // Solo mandamos provider si la hoja lo overrideó; sin override el
            // edge usa el default del admin (igual que el examen).
            ...(runnerOverride ? { provider: runnerOverride } : {}),
          },
        });
        const { data, error } = await (Promise.race([invokePromise, cancelPromise]) as Promise<
          Awaited<typeof invokePromise>
        >);
        if (error || data?.error) {
          toast.error(
            friendlyError(
              error ?? data?.error,
              t("hc_modulesWhiteboardCodePageEditor.runFailed", { defaultValue: "No se pudo ejecutar el código" }),
            ),
          );
          return;
        }
        stdout = (data?.stdout as string) ?? "";
        stderr = (data?.stderr as string) ?? "";
        exitCode = typeof data?.exitCode === "number" ? data.exitCode : 0;
      }
      const out = { stdout, stderr, exitCode };
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
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Cancelación del usuario: silenciar (la UI ya se liberó en cancelRun).
      if (msg === CANCELLED_SENTINEL) return;
      toast.error(
        friendlyError(
          e,
          t("hc_modulesWhiteboardCodePageEditor.runFailed", { defaultValue: "No se pudo ejecutar el código" }),
        ),
      );
    } finally {
      setRunning(false);
    }
  };

  /** Cancela el run en curso: libera la UI de inmediato. cheerp no expone kill
   *  del worker y el edge sigue server-side, pero el usuario puede cambiar de
   *  compilador y reintentar sin esperar (mismo trade-off que el examen). */
  const cancelRun = () => {
    runAbortRef.current?.abort();
    runAbortRef.current = null;
    setRunning(false);
  };

  const output = readOnly
    ? localOut
    : executedAt
      ? { stdout: stdout ?? "", stderr: stderr ?? "", exitCode: exitCode ?? 0 }
      : null;

  return (
    <div className={cn("flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-2", className)}>
      {/* Controles: lenguaje (solo docente) + selector de compilador (para
          docente Y alumno, porque ambos pueden ejecutar) — igual que el examen. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {!readOnly && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {t("hc_modulesWhiteboardCodePageEditor.language", { defaultValue: "Lenguaje" })}
            </span>
            <Select value={lang} onValueChange={(v) => void onLangChange(v)}>
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
        <CodeRunnerPicker
          language={(lang as CodeLanguage) ?? "java"}
          defaultProvider={defaultProvider}
          value={runnerOverride}
          onChange={setRunnerOverride}
          disabled={running}
        />
      </div>
      <CodeEditor
        value={code}
        onChange={onCodeChange}
        language={(lang as CodeLanguage) ?? "java"}
        showLanguageSelector={false}
        showRunButton
        onRun={() => void run()}
        onCancel={cancelRun}
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

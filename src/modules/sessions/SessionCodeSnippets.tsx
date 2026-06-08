/**
 * SessionCodeSnippets — lista de snippets de código asociados a una
 * sesión presencial (attendance_sessions). El docente los crea/edita
 * durante la clase; los alumnos los ven (y opcionalmente ejecutan)
 * desde su vista de asistencia.
 *
 * Cada snippet:
 *   - Título opcional (default "Snippet N" si vacío)
 *   - Lenguaje (java | python | javascript)
 *   - Source code en Monaco
 *   - Botón Run → llama `execute-code` edge y cachea stdout/stderr/exit
 *     en la fila (campos `last_*`)
 *
 * Diferencias con `CodeEditor` simple:
 *   - Persiste la fila en `session_code_snippets` (autosave debounced 1.5s).
 *   - Mantiene el output entre sesiones de navegación (lee `last_*` al cargar).
 *   - Permite eliminar/agregar snippets (en modo write).
 *
 * Modo:
 *   readOnly=true (alumno): no puede editar source/título/lenguaje ni
 *     agregar/eliminar. Sí puede Run para probar el código del docente —
 *     el resultado NO se persiste en `last_*` (eso solo lo hace el
 *     docente al ejecutar). El alumno ve la salida en el panel local
 *     hasta que recarga la página.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { CodeEditor, type CodeLanguage, getStarterCode } from "@/modules/code/CodeEditor";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import i18n from "@/i18n";
import { friendlyError } from "@/shared/lib/db-errors";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { Code2, Plus, Trash2, Copy, Check } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface SnippetRow {
  id: string;
  session_id: string;
  position: number;
  title: string;
  language: string;
  source_code: string;
  last_stdout: string | null;
  last_stderr: string | null;
  last_exit_code: number | null;
  last_executed_at: string | null;
}

interface Props {
  sessionId: string;
  /** Si true, el alumno NO puede editar/agregar/eliminar — solo ver y
   *  ejecutar para probar. */
  readOnly?: boolean;
}

const SELECT_COLS =
  "id, session_id, position, title, language, source_code, last_stdout, last_stderr, last_exit_code, last_executed_at";

/** Mapeo de lenguaje → label humano para los badges. */
const LANG_LABEL: Record<string, string> = {
  java: "Java",
  python: "Python",
  javascript: "JavaScript",
};

export function SessionCodeSnippets({ sessionId, readOnly }: Props) {
  const confirm = useConfirm();
  const [snippets, setSnippets] = useState<SnippetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Running state per snippet id. Cuando el alumno o docente clickea Run
  // ponemos true para deshabilitar el botón y bloquear concurrencia
  // múltiple del mismo snippet (no del componente entero).
  const [runningId, setRunningId] = useState<string | null>(null);
  // Output local del alumno (no se persiste). Solo aplica en readOnly.
  // Map snippet.id → {stdout, stderr, exitCode}.
  const [localOutputs, setLocalOutputs] = useState<
    Record<string, { stdout: string; stderr: string; exitCode: number }>
  >({});
  // Para mostrar "Copiado!" temporalmente tras click.
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debouncers por campo y por snippet — autosave de title/language/source.
  // Map<snippetId, timeout>. Evita pegarle a DB en cada keystroke.
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Cargar snippets ──
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const { data, error } = await db
        .from("session_code_snippets")
        .select(SELECT_COLS)
        .eq("session_id", sessionId)
        .order("position", { ascending: true });
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar los snippets."));
        setLoading(false);
        return;
      }
      setSnippets((data ?? []) as SnippetRow[]);
      setLoading(false);
    } catch (e) {
      setLoadError(friendlyError(e, "No pudimos cargar los snippets."));
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Cleanup de timers al unmount — flush no hace falta porque cada
  // save ya escribe a DB en background; perder los últimos 1.5s del
  // typing al cerrar la pestaña es aceptable (consistencia con el resto
  // de autosaves del repo, ej. WhiteboardEditor).
  useEffect(() => {
    return () => {
      const timers = saveTimersRef.current;
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, []);

  // ── Actualizar fila local + agendar save debounced ──
  const updateLocal = (id: string, patch: Partial<SnippetRow>) => {
    setSnippets((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const existingTimer = saveTimersRef.current.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(id);
      // Leemos del state actual (no del closure) para tomar el patch más reciente.
      setSnippets((current) => {
        const row = current.find((s) => s.id === id);
        if (!row) return current;
        void persistSnippet(row);
        return current;
      });
    }, 1500);
    saveTimersRef.current.set(id, timer);
  };

  const persistSnippet = async (row: SnippetRow) => {
    const { error } = await db
      .from("session_code_snippets")
      .update({
        title: row.title,
        language: row.language,
        source_code: row.source_code,
      })
      .eq("id", row.id);
    if (error) {
      toast.error(friendlyError(error, "No se pudo guardar el snippet"));
    }
  };

  // ── Crear snippet ──
  const addSnippet = async () => {
    if (readOnly) return;
    setBusy(true);
    try {
      const nextPosition = snippets.length;
      const { data, error } = await db
        .from("session_code_snippets")
        .insert({
          session_id: sessionId,
          position: nextPosition,
          title: "",
          language: "java",
          source_code: getStarterCode("java"),
        })
        .select(SELECT_COLS)
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, "No se pudo crear el snippet"));
        return;
      }
      setSnippets((prev) => [...prev, data as SnippetRow]);
    } finally {
      setBusy(false);
    }
  };

  // ── Eliminar snippet ──
  const deleteSnippet = async (id: string) => {
    if (readOnly) return;
    const ok = await confirm({
      title: "¿Eliminar este snippet?",
      description: "Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const { error } = await db.from("session_code_snippets").delete().eq("id", id);
      if (error) {
        toast.error(friendlyError(error, "No se pudo eliminar"));
        return;
      }
      setSnippets((prev) => prev.filter((s) => s.id !== id));
      setLocalOutputs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } finally {
      setBusy(false);
    }
  };

  // ── Ejecutar snippet via execute-code edge ──
  // Importante: pasamos snippet.id como `questionId` para el audit log.
  // No hay submission ni question reales, pero el edge solo lo usa como
  // entityId en audit/code_executions y no impone FK. El user_id se toma
  // del JWT del caller (auth.uid()).
  const runSnippet = async (snippet: SnippetRow) => {
    if (!snippet.source_code.trim()) {
      toast.error(
        i18n.t("toast.modules_sessions_SessionCodeSnippets.snippetEmpty", {
          defaultValue: "El snippet está vacío",
        }),
      );
      return;
    }
    setRunningId(snippet.id);
    try {
      const { data, error } = await supabase.functions.invoke("execute-code", {
        body: {
          sourceCode: snippet.source_code,
          language: snippet.language,
          questionId: snippet.id,
        },
      });
      if (error || data?.error) {
        toast.error(friendlyError(error ?? data?.error, "Error ejecutando el snippet"));
        return;
      }
      const stdout = (data?.stdout as string) ?? "";
      const stderr = (data?.stderr as string) ?? "";
      const exitCode = typeof data?.exitCode === "number" ? data.exitCode : 0;

      if (readOnly) {
        // Alumno: solo guardamos en state local. No tocamos `last_*` de
        // la fila (eso es la "última ejecución del docente" — referencia
        // pedagógica del resultado esperado).
        setLocalOutputs((prev) => ({
          ...prev,
          [snippet.id]: { stdout, stderr, exitCode },
        }));
      } else {
        // Docente: persistimos como last_* en la fila. UI optimista —
        // actualizamos state local sin esperar el roundtrip de DB.
        const nowIso = new Date().toISOString();
        setSnippets((prev) =>
          prev.map((s) =>
            s.id === snippet.id
              ? {
                  ...s,
                  last_stdout: stdout,
                  last_stderr: stderr,
                  last_exit_code: exitCode,
                  last_executed_at: nowIso,
                }
              : s,
          ),
        );
        const { error: updErr } = await db
          .from("session_code_snippets")
          .update({
            last_stdout: stdout,
            last_stderr: stderr,
            last_exit_code: exitCode,
            last_executed_at: nowIso,
          })
          .eq("id", snippet.id);
        if (updErr) {
          // Cache fallida no es bloqueante — el alumno verá el output
          // que el docente generó en la sesión activa del navegador.
          console.warn("[SessionCodeSnippets] No se pudo cachear el output", updErr);
        }
      }
    } finally {
      setRunningId(null);
    }
  };

  // ── Copiar al portapapeles ──
  const copyToClipboard = async (snippet: SnippetRow) => {
    try {
      await navigator.clipboard.writeText(snippet.source_code);
      setCopiedId(snippet.id);
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
      copyResetRef.current = setTimeout(() => setCopiedId(null), 1500);
    } catch {
      toast.error(
        i18n.t("toast.modules_sessions_SessionCodeSnippets.clipboardCopyFailed", {
          defaultValue: "No se pudo copiar al portapapeles",
        }),
      );
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
        <Spinner size="sm" /> Cargando snippets…
      </div>
    );
  }

  if (loadError) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-destructive">{loadError}</CardContent>
      </Card>
    );
  }

  if (snippets.length === 0 && readOnly) {
    // Alumno entra al dialog y el docente no creó snippets — mostramos
    // un mensaje friendly en lugar de un dialog vacío. Si la integración
    // está inline (no en dialog), el padre puede chequear primero un
    // count y no renderizarnos. En dialog mode preferimos comunicar el
    // estado vs un container vacío.
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Code2 className="h-8 w-8 opacity-40" />
        <p>El docente todavía no agregó código a esta sesión.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Code2 className="h-4 w-4 text-indigo-500" />
          Snippets de código
          {snippets.length > 0 && (
            <Badge variant="secondary" className="text-[10px] ml-1">
              {snippets.length}
            </Badge>
          )}
        </div>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={() => void addSnippet()} disabled={busy}>
            {busy ? <Spinner size="xs" className="mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
            Agregar snippet
          </Button>
        )}
      </div>

      {snippets.length === 0 && !readOnly && (
        <p className="text-xs text-muted-foreground italic">
          Sin snippets todavía. Click "Agregar snippet" para crear el primero.
        </p>
      )}

      {snippets.map((snippet, idx) => {
        const output = readOnly
          ? localOutputs[snippet.id]
          : snippet.last_executed_at
            ? {
                stdout: snippet.last_stdout ?? "",
                stderr: snippet.last_stderr ?? "",
                exitCode: snippet.last_exit_code ?? 0,
              }
            : undefined;
        const placeholderTitle = `Snippet ${idx + 1}`;
        return (
          <Card key={snippet.id} className="border-l-4 border-l-indigo-500/50">
            <CardHeader className="py-3 px-3">
              <div className="flex items-center gap-2 flex-wrap">
                <CardTitle className="text-xs flex-1 min-w-[160px]">
                  {readOnly ? (
                    <span className="text-sm font-medium">
                      {snippet.title.trim() || placeholderTitle}
                    </span>
                  ) : (
                    <Input
                      value={snippet.title}
                      onChange={(e) => updateLocal(snippet.id, { title: e.target.value })}
                      placeholder={placeholderTitle}
                      className="h-7 text-sm"
                    />
                  )}
                </CardTitle>
                {readOnly ? (
                  <Badge variant="outline" className="text-[10px]">
                    {LANG_LABEL[snippet.language] ?? snippet.language}
                  </Badge>
                ) : (
                  <Select
                    value={snippet.language}
                    onValueChange={(v) =>
                      updateLocal(snippet.id, {
                        language: v,
                        // Si el snippet estaba vacío y el docente cambia
                        // de lenguaje, refrescamos el starter — UX similar
                        // al editor de exam questions.
                        source_code:
                          !snippet.source_code.trim() ||
                          snippet.source_code === getStarterCode(snippet.language)
                            ? getStarterCode(v) || ""
                            : snippet.source_code,
                      })
                    }
                  >
                    <SelectTrigger className="h-7 w-[120px] text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="java">Java</SelectItem>
                      <SelectItem value="python">Python</SelectItem>
                      <SelectItem value="javascript">JavaScript</SelectItem>
                    </SelectContent>
                  </Select>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => void copyToClipboard(snippet)}
                  title="Copiar código al portapapeles"
                >
                  {copiedId === snippet.id ? (
                    <Check className="h-3 w-3" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </Button>
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => void deleteSnippet(snippet.id)}
                    title="Eliminar snippet"
                    disabled={busy}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-3 pb-3 pt-0">
              <CodeEditor
                value={snippet.source_code}
                onChange={(v) => {
                  if (readOnly) return;
                  updateLocal(snippet.id, { source_code: v });
                }}
                language={(snippet.language as CodeLanguage) ?? "java"}
                showLanguageSelector={false}
                showRunButton
                onRun={() => void runSnippet(snippet)}
                isRunning={runningId === snippet.id}
                readOnly={readOnly}
                hideHints
                height="200px"
                // Persistimos solo si el docente ya corrió antes — mostramos
                // el output cacheado. El componente CodeEditor renderiza
                // la sección "Salida" cuando output !== undefined.
                output={
                  output
                    ? [output.stdout, output.stderr ? `\n[stderr]\n${output.stderr}` : ""]
                        .filter(Boolean)
                        .join("")
                    : undefined
                }
              />
              {output && (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  exit {output.exitCode}
                  {!readOnly && snippet.last_executed_at && (
                    <span className="ml-2">
                      • Último run: {new Date(snippet.last_executed_at).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

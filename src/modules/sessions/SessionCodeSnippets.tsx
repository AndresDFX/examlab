/**
 * SessionCodeSnippets — lista de snippets de código asociados a una
 * sesión presencial (attendance_sessions). El docente los crea/edita
 * durante la clase; los alumnos los ven (y opcionalmente ejecutan)
 * desde su vista de asistencia.
 *
 * Cada snippet:
 *   - Título opcional (default "Snippet N" si vacío)
 *   - Lenguaje (java | python | javascript)
 *   - N ARCHIVOS de código (multi-archivo) en una tab bar — cada uno con
 *     filename + content. Para compilar se mandan TODOS juntos al edge
 *     `execute-code` (que los combina según el runner). Para Java la clase
 *     con `main` se deriva server-side.
 *   - Botón Run → llama `execute-code` edge y cachea stdout/stderr/exit
 *     en la fila (campos `last_*`)
 *
 * Backward-compat: un snippet legacy que solo tiene `source_code` (sin
 * filas en `session_snippet_files`) se muestra como un único archivo
 * derivado de ese `source_code`. Al crear archivos nuevos, esos pasan a
 * ser la fuente de verdad; `source_code` se mantiene sincronizado con el
 * primer archivo para no romper lecturas viejas.
 *
 * Modo:
 *   readOnly=true (alumno): no puede editar/agregar/eliminar — solo ver y
 *     ejecutar. El resultado NO se persiste en `last_*` (solo el docente
 *     persiste). El alumno ve la salida local hasta recargar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { CodeEditor, type CodeLanguage, getStarterCode } from "@/modules/code/CodeEditor";
import { combineFilesForExec } from "@/modules/code/combine-files";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatTime } from "@/shared/lib/format";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { Code2, Plus, Trash2, Copy, Check, X } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface SnippetFile {
  id: string;
  filename: string;
  content: string;
  position: number;
}

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
  /** Archivos del snippet (multi-archivo). Cargados desde
   *  session_snippet_files o derivados de source_code (legacy). */
  files: SnippetFile[];
  /** Índice del archivo activo en la tab bar. */
  activeFileIdx: number;
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

/** Extensión por lenguaje para sugerir filenames de archivos nuevos. */
const LANG_EXT: Record<string, string> = {
  java: "java",
  python: "py",
  javascript: "js",
};

/** Filename por defecto del primer archivo de un snippet de cierto lenguaje. */
function defaultFilename(language: string, idx: number): string {
  const ext = LANG_EXT[language] ?? "txt";
  if (language === "java") return idx === 0 ? "Main.java" : `Clase${idx + 1}.java`;
  return idx === 0 ? `main.${ext}` : `archivo${idx + 1}.${ext}`;
}

/**
 * Deriva los archivos de un snippet legacy que solo tiene source_code.
 * Siempre devuelve ≥1 archivo (un único archivo con todo el source_code).
 */
function filesFromLegacy(row: {
  id: string;
  language: string;
  source_code: string;
}): SnippetFile[] {
  return [
    {
      // id sintético prefijado para distinguir de filas reales de DB.
      id: `legacy:${row.id}`,
      filename: defaultFilename(row.language, 0),
      content: row.source_code ?? "",
      position: 0,
    },
  ];
}

export function SessionCodeSnippets({ sessionId, readOnly }: Props) {
  const { t } = useTranslation();
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

  // Debouncers por campo y por snippet — autosave de title/language.
  const saveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Debouncers por archivo — autosave de filename/content.
  const fileSaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ── Cargar snippets + sus archivos ──
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
        setLoadError(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.loadSnippetsFailed")));
        setLoading(false);
        return;
      }
      const rows = (data ?? []) as Omit<SnippetRow, "files" | "activeFileIdx">[];
      // Cargar archivos de todos los snippets de una sola query.
      const snippetIds = rows.map((r) => r.id);
      let filesBySnippet: Record<string, SnippetFile[]> = {};
      if (snippetIds.length > 0) {
        const { data: fileRows, error: fileErr } = await db
          .from("session_snippet_files")
          .select("id, snippet_id, filename, content, position")
          .in("snippet_id", snippetIds)
          .order("position", { ascending: true });
        if (fileErr) {
          setLoadError(friendlyError(fileErr, t("hc_modulesSessionsSessionCodeSnippets.loadFilesFailed")));
          setLoading(false);
          return;
        }
        filesBySnippet = (fileRows ?? []).reduce(
          (
            acc: Record<string, SnippetFile[]>,
            f: { id: string; snippet_id: string; filename: string; content: string; position: number },
          ) => {
            (acc[f.snippet_id] ??= []).push({
              id: f.id,
              filename: f.filename,
              content: f.content,
              position: f.position,
            });
            return acc;
          },
          {} as Record<string, SnippetFile[]>,
        );
      }
      const withFiles: SnippetRow[] = rows.map((r) => {
        const files = filesBySnippet[r.id]?.length
          ? filesBySnippet[r.id]
          : filesFromLegacy(r);
        return { ...r, files, activeFileIdx: 0 };
      });
      setSnippets(withFiles);
      setLoading(false);
    } catch (e) {
      setLoadError(friendlyError(e, t("hc_modulesSessionsSessionCodeSnippets.loadSnippetsFailed")));
      setLoading(false);
    }
  }, [sessionId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Cleanup de timers al unmount.
  useEffect(() => {
    return () => {
      saveTimersRef.current.forEach((t) => clearTimeout(t));
      saveTimersRef.current.clear();
      fileSaveTimersRef.current.forEach((t) => clearTimeout(t));
      fileSaveTimersRef.current.clear();
      if (copyResetRef.current) clearTimeout(copyResetRef.current);
    };
  }, []);

  // ── Actualizar metadata del snippet (title/language) + save debounced ──
  const updateSnippetMeta = (id: string, patch: Partial<SnippetRow>) => {
    setSnippets((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    const existingTimer = saveTimersRef.current.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    const timer = setTimeout(() => {
      saveTimersRef.current.delete(id);
      setSnippets((current) => {
        const row = current.find((s) => s.id === id);
        if (row) void persistSnippetMeta(row);
        return current;
      });
    }, 1500);
    saveTimersRef.current.set(id, timer);
  };

  const persistSnippetMeta = async (row: SnippetRow) => {
    // Mantenemos source_code sincronizado con el PRIMER archivo para que
    // lecturas legacy (sin session_snippet_files) sigan viendo algo
    // coherente. Es solo un fallback — los archivos son la verdad.
    const firstContent = row.files[0]?.content ?? "";
    const { error } = await db
      .from("session_code_snippets")
      .update({
        title: row.title,
        language: row.language,
        source_code: firstContent,
      })
      .eq("id", row.id);
    if (error) {
      toast.error(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.saveSnippetFailed")));
    }
  };

  // ── Migrar un archivo legacy a una fila real de session_snippet_files ──
  // Devuelve el archivo con su id real de DB (o el mismo si falló).
  const ensurePersistedFile = async (
    snippetId: string,
    file: SnippetFile,
  ): Promise<SnippetFile> => {
    if (!file.id.startsWith("legacy:")) return file;
    const { data, error } = await db
      .from("session_snippet_files")
      .insert({
        snippet_id: snippetId,
        filename: file.filename,
        content: file.content,
        position: file.position,
      })
      .select("id, filename, content, position")
      .single();
    if (error || !data) {
      toast.error(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.saveFileFailed")));
      return file;
    }
    return { id: data.id, filename: data.filename, content: data.content, position: data.position };
  };

  // ── Actualizar contenido/filename de un archivo + save debounced ──
  const updateFile = (snippetId: string, fileIdx: number, patch: Partial<SnippetFile>) => {
    setSnippets((prev) =>
      prev.map((s) => {
        if (s.id !== snippetId) return s;
        const files = s.files.map((f, i) => (i === fileIdx ? { ...f, ...patch } : f));
        return { ...s, files };
      }),
    );
    const file = snippets.find((s) => s.id === snippetId)?.files[fileIdx];
    if (!file) return;
    const key = `${snippetId}:${fileIdx}`;
    const existing = fileSaveTimersRef.current.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      fileSaveTimersRef.current.delete(key);
      void persistFile(snippetId, fileIdx);
    }, 1500);
    fileSaveTimersRef.current.set(key, timer);
  };

  const persistFile = async (snippetId: string, fileIdx: number) => {
    // Leemos del state actual para tomar el último patch.
    let target: { snippet: SnippetRow; file: SnippetFile } | null = null;
    setSnippets((current) => {
      const snippet = current.find((s) => s.id === snippetId);
      const file = snippet?.files[fileIdx];
      if (snippet && file) target = { snippet, file };
      return current;
    });
    if (!target) return;
    const { snippet, file } = target as { snippet: SnippetRow; file: SnippetFile };
    if (file.id.startsWith("legacy:")) {
      // Aún no existe en DB — la creamos y reemplazamos el id sintético.
      const persisted = await ensurePersistedFile(snippet.id, file);
      if (persisted.id !== file.id) {
        setSnippets((prev) =>
          prev.map((s) =>
            s.id === snippet.id
              ? { ...s, files: s.files.map((f, i) => (i === fileIdx ? persisted : f)) }
              : s,
          ),
        );
      }
      // Sincronizar source_code legacy con el primer archivo.
      if (fileIdx === 0) await syncLegacySourceCode(snippet.id, file.content);
      return;
    }
    const { error } = await db
      .from("session_snippet_files")
      .update({ filename: file.filename, content: file.content })
      .eq("id", file.id);
    if (error) {
      toast.error(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.saveFileFailed")));
      return;
    }
    if (fileIdx === 0) await syncLegacySourceCode(snippet.id, file.content);
  };

  // Mantiene source_code = primer archivo (fallback legacy).
  const syncLegacySourceCode = async (snippetId: string, content: string) => {
    await db.from("session_code_snippets").update({ source_code: content }).eq("id", snippetId);
  };

  // ── Crear snippet ──
  const addSnippet = async () => {
    if (readOnly) return;
    setBusy(true);
    try {
      const nextPosition = snippets.length;
      const starter = getStarterCode("java");
      const { data, error } = await db
        .from("session_code_snippets")
        .insert({
          session_id: sessionId,
          position: nextPosition,
          title: "",
          language: "java",
          source_code: starter,
        })
        .select(SELECT_COLS)
        .single();
      if (error || !data) {
        toast.error(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.createSnippetFailed")));
        return;
      }
      // Crear el primer archivo real para el snippet nuevo.
      const { data: fileData } = await db
        .from("session_snippet_files")
        .insert({
          snippet_id: data.id,
          filename: defaultFilename("java", 0),
          content: starter,
          position: 0,
        })
        .select("id, filename, content, position")
        .single();
      const files: SnippetFile[] = fileData
        ? [
            {
              id: fileData.id,
              filename: fileData.filename,
              content: fileData.content,
              position: fileData.position,
            },
          ]
        : filesFromLegacy(data);
      setSnippets((prev) => [...prev, { ...(data as SnippetRow), files, activeFileIdx: 0 }]);
    } finally {
      setBusy(false);
    }
  };

  // ── Eliminar snippet ──
  const deleteSnippet = async (id: string) => {
    if (readOnly) return;
    const ok = await confirm({
      title: t("hc_modulesSessionsSessionCodeSnippets.deleteSnippetTitle"),
      description: t("hc_modulesSessionsSessionCodeSnippets.deleteSnippetDescription"),
      confirmLabel: t("hc_modulesSessionsSessionCodeSnippets.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      // session_snippet_files se borran por ON DELETE CASCADE.
      const { error } = await db.from("session_code_snippets").delete().eq("id", id);
      if (error) {
        toast.error(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.deleteSnippetFailed")));
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

  // ── Agregar archivo a un snippet ──
  const addFile = async (snippetId: string) => {
    if (readOnly) return;
    const snippet = snippets.find((s) => s.id === snippetId);
    if (!snippet) return;
    const idx = snippet.files.length;
    const filename = defaultFilename(snippet.language, idx);
    const starter = snippet.language === "java" ? `class ${filename.replace(/\.java$/, "")} {\n\n}` : "";
    const { data, error } = await db
      .from("session_snippet_files")
      .insert({ snippet_id: snippetId, filename, content: starter, position: idx })
      .select("id, filename, content, position")
      .single();
    if (error || !data) {
      toast.error(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.addFileFailed")));
      return;
    }
    setSnippets((prev) =>
      prev.map((s) =>
        s.id === snippetId
          ? {
              ...s,
              files: [
                ...s.files,
                {
                  id: data.id,
                  filename: data.filename,
                  content: data.content,
                  position: data.position,
                },
              ],
              activeFileIdx: s.files.length,
            }
          : s,
      ),
    );
  };

  // ── Eliminar archivo de un snippet (no se puede borrar el último) ──
  const deleteFile = async (snippetId: string, fileIdx: number) => {
    if (readOnly) return;
    const snippet = snippets.find((s) => s.id === snippetId);
    if (!snippet || snippet.files.length <= 1) return;
    const file = snippet.files[fileIdx];
    const ok = await confirm({
      title: t("hc_modulesSessionsSessionCodeSnippets.deleteFileTitle"),
      description: t("hc_modulesSessionsSessionCodeSnippets.deleteFileDescription", { filename: file.filename }),
      confirmLabel: t("hc_modulesSessionsSessionCodeSnippets.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    // Si es un archivo legacy aún no persistido, solo lo quitamos del state.
    if (!file.id.startsWith("legacy:")) {
      const { error } = await db.from("session_snippet_files").delete().eq("id", file.id);
      if (error) {
        toast.error(friendlyError(error, t("hc_modulesSessionsSessionCodeSnippets.deleteFileFailed")));
        return;
      }
    }
    setSnippets((prev) =>
      prev.map((s) => {
        if (s.id !== snippetId) return s;
        const files = s.files.filter((_, i) => i !== fileIdx);
        const activeFileIdx = Math.min(s.activeFileIdx, files.length - 1);
        return { ...s, files, activeFileIdx: Math.max(0, activeFileIdx) };
      }),
    );
  };

  // ── Ejecutar snippet via execute-code edge (multi-archivo) ──
  // Pasamos snippet.id como `questionId` para el audit log.
  const runSnippet = async (snippet: SnippetRow) => {
    const files = snippet.files
      .map((f) => ({ filename: f.filename, content: f.content }))
      .filter((f) => f.content.trim().length > 0);
    if (files.length === 0) {
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
          files,
          // `sourceCode` legacy para edges aún sin soporte multi-archivo.
          sourceCode: combineFilesForExec(files, snippet.language),
          language: snippet.language,
          questionId: snippet.id,
        },
      });
      if (error || data?.error) {
        toast.error(friendlyError(error ?? data?.error, t("hc_modulesSessionsSessionCodeSnippets.runSnippetFailed")));
        return;
      }
      const stdout = (data?.stdout as string) ?? "";
      const stderr = (data?.stderr as string) ?? "";
      const exitCode = typeof data?.exitCode === "number" ? data.exitCode : 0;

      if (readOnly) {
        setLocalOutputs((prev) => ({
          ...prev,
          [snippet.id]: { stdout, stderr, exitCode },
        }));
      } else {
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
          console.warn("[SessionCodeSnippets] No se pudo cachear el output", updErr);
        }
      }
    } finally {
      setRunningId(null);
    }
  };

  // ── Copiar al portapapeles (archivo activo) ──
  const copyToClipboard = async (snippet: SnippetRow) => {
    const file = snippet.files[snippet.activeFileIdx] ?? snippet.files[0];
    try {
      await navigator.clipboard.writeText(file?.content ?? "");
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

  const setActiveFile = (snippetId: string, idx: number) => {
    setSnippets((prev) =>
      prev.map((s) => (s.id === snippetId ? { ...s, activeFileIdx: idx } : s)),
    );
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
        <Spinner size="sm" /> {t("hc_modulesSessionsSessionCodeSnippets.loadingSnippets")}
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
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Code2 className="h-8 w-8 opacity-40" />
        <p>{t("hc_modulesSessionsSessionCodeSnippets.studentEmptyState")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Code2 className="h-4 w-4 text-indigo-500" />
          {t("hc_modulesSessionsSessionCodeSnippets.heading")}
          {snippets.length > 0 && (
            <Badge variant="secondary" className="text-[10px] ml-1">
              {snippets.length}
            </Badge>
          )}
        </div>
        {!readOnly && (
          <Button size="sm" variant="outline" onClick={() => void addSnippet()} disabled={busy}>
            {busy ? <Spinner size="xs" className="mr-1" /> : <Plus className="h-3 w-3 mr-1" />}
            {t("hc_modulesSessionsSessionCodeSnippets.addSnippet")}
          </Button>
        )}
      </div>

      {snippets.length === 0 && !readOnly && (
        <p className="text-xs text-muted-foreground italic">
          {t("hc_modulesSessionsSessionCodeSnippets.teacherEmptyState")}
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
        const placeholderTitle = t("hc_modulesSessionsSessionCodeSnippets.snippetPlaceholderTitle", { number: idx + 1 });
        const activeFile = snippet.files[snippet.activeFileIdx] ?? snippet.files[0];
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
                      onChange={(e) => updateSnippetMeta(snippet.id, { title: e.target.value })}
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
                    onValueChange={(v) => updateSnippetMeta(snippet.id, { language: v })}
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
                  title={t("hc_modulesSessionsSessionCodeSnippets.copyActiveFileTitle")}
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
                    title={t("hc_modulesSessionsSessionCodeSnippets.deleteSnippetTitleAttr")}
                    disabled={busy}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>

              {/* Tab bar de archivos */}
              <div className="flex items-center gap-1 flex-wrap mt-2">
                {snippet.files.map((file, fileIdx) => {
                  const active = fileIdx === snippet.activeFileIdx;
                  return (
                    <div
                      key={file.id}
                      className={`group flex items-center gap-1 rounded-t-md border px-2 py-1 text-[11px] ${
                        active
                          ? "border-indigo-500/60 bg-indigo-500/10 font-medium"
                          : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {readOnly ? (
                        <button
                          type="button"
                          className="max-w-[140px] truncate"
                          onClick={() => setActiveFile(snippet.id, fileIdx)}
                          title={file.filename}
                        >
                          {file.filename || t("hc_modulesSessionsSessionCodeSnippets.fileFallbackName", { number: fileIdx + 1 })}
                        </button>
                      ) : active ? (
                        <Input
                          value={file.filename}
                          onChange={(e) =>
                            updateFile(snippet.id, fileIdx, { filename: e.target.value })
                          }
                          className="h-5 w-[120px] px-1 text-[11px] border-0 bg-transparent focus-visible:ring-1"
                          placeholder={defaultFilename(snippet.language, fileIdx)}
                        />
                      ) : (
                        <button
                          type="button"
                          className="max-w-[140px] truncate"
                          onClick={() => setActiveFile(snippet.id, fileIdx)}
                          title={file.filename}
                        >
                          {file.filename || t("hc_modulesSessionsSessionCodeSnippets.fileFallbackName", { number: fileIdx + 1 })}
                        </button>
                      )}
                      {!readOnly && snippet.files.length > 1 && (
                        <button
                          type="button"
                          className="opacity-50 hover:opacity-100 hover:text-destructive"
                          onClick={() => void deleteFile(snippet.id, fileIdx)}
                          title={t("hc_modulesSessionsSessionCodeSnippets.deleteFileTitleAttr")}
                          aria-label={t("hc_modulesSessionsSessionCodeSnippets.deleteFileAriaLabel", { filename: file.filename })}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {!readOnly && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-1.5 text-[11px]"
                    onClick={() => void addFile(snippet.id)}
                    title={t("hc_modulesSessionsSessionCodeSnippets.addFileTitle")}
                  >
                    <Plus className="h-3 w-3 mr-0.5" />
                    {t("hc_modulesSessionsSessionCodeSnippets.fileButton")}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="px-3 pb-3 pt-0">
              <CodeEditor
                key={activeFile?.id}
                value={activeFile?.content ?? ""}
                onChange={(v) => {
                  if (readOnly) return;
                  updateFile(snippet.id, snippet.activeFileIdx, { content: v });
                }}
                language={(snippet.language as CodeLanguage) ?? "java"}
                showLanguageSelector={false}
                showRunButton
                onRun={() => void runSnippet(snippet)}
                isRunning={runningId === snippet.id}
                readOnly={readOnly}
                hideHints
                height="200px"
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
                      • {t("hc_modulesSessionsSessionCodeSnippets.lastRun", { time: formatTime(snippet.last_executed_at) })}
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

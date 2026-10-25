/**
 * SessionTranscriptDialog — transcripciones de Teams de una sesión de clase.
 * Se abre desde el menú de la sesión en `app.teacher.attendance.tsx`.
 *
 * Dos caminos para traer la transcripción:
 *  - SUBIR el .vtt a mano (lo que Teams web descarga). Es el camino principal:
 *    el automático depende de que TI apruebe la app de Graph.
 *  - «Traer de Teams» (acción fetch_transcript del edge) cuando esté disponible.
 *
 * Además, por cada transcripción el docente marca cuáles hablantes son ÉL. Con
 * eso se guarda aparte el «texto del docente», que es lo único que el Tutor IA
 * puede leer (la transcripción completa tiene voces de estudiantes).
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateOnly } from "@/shared/lib/format";
import { Captions, Copy, Check, CalendarClock, AlertTriangle, Upload } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export interface TranscriptSession {
  id: string;
  title?: string | null;
  session_date: string;
  meeting_url?: string | null;
}

interface Props {
  session: TranscriptSession | null;
  onClose: () => void;
}

interface TranscriptRow {
  id: string;
  source: string | null;
  file_name: string | null;
  content_text: string | null;
  teacher_text: string | null;
  speakers: string[] | null;
  teacher_speakers: string[] | null;
  transcript_created_at: string | null;
}

const RECONNECT_CODES = new Set(["needs_reconnect", "not_microsoft_account", "not_connected"]);
const MAX_VTT_BYTES = 8 * 1024 * 1024;

export function SessionTranscriptDialog({ session, onClose }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [rows, setRows] = useState<TranscriptRow[]>([]);
  // Selección editable de hablantes-docente por transcripción (lowercase match).
  const [selection, setSelection] = useState<Record<string, string[]>>({});
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const open = session !== null;
  const hasTeams = /teams\.microsoft\.com\/l\/meetup-join/i.test(session?.meeting_url ?? "");

  const load = async (sessionId: string) => {
    setLoading(true);
    try {
      const { data, error } = await db
        .from("session_transcripts")
        .select(
          "id, source, file_name, content_text, teacher_text, speakers, teacher_speakers, transcript_created_at",
        )
        .eq("session_id", sessionId)
        .order("transcript_created_at", { ascending: true, nullsFirst: true });
      if (error) {
        toast.error(friendlyError(error, t("sessionTranscript.loadError")));
        return;
      }
      const list = (data ?? []) as TranscriptRow[];
      setRows(list);
      const sel: Record<string, string[]> = {};
      for (const r of list) sel[r.id] = r.teacher_speakers ?? [];
      setSelection(sel);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!session) {
      setRows([]);
      setSelection({});
      setErrorCode(null);
      setCopiedId(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      if (cancelled) return;
      await load(session.id);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id]);

  const onPickFile = async (file: File | null) => {
    if (!session || !file) return;
    if (file.size > MAX_VTT_BYTES) {
      toast.error(t("sessionTranscript.upload.tooLarge"));
      return;
    }
    setUploading(true);
    setErrorCode(null);
    try {
      const vtt = await file.text();
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: {
          action: "upload_transcript",
          sessionId: session.id,
          vtt,
          fileName: file.name,
        },
      });
      if (error) {
        toast.error(friendlyError(error, t("sessionTranscript.upload.error")));
        return;
      }
      const res = data as { ok?: boolean; error?: string };
      if (!res?.ok) {
        setErrorCode(res?.error ?? "unknown");
        return;
      }
      toast.success(t("sessionTranscript.upload.ok"));
      await load(session.id);
    } catch (e) {
      toast.error(friendlyError(e, t("sessionTranscript.upload.error")));
    } finally {
      setUploading(false);
    }
  };

  const fetchTranscript = async () => {
    if (!session) return;
    setFetching(true);
    setErrorCode(null);
    try {
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: { action: "fetch_transcript", provider: "microsoft", sessionId: session.id },
      });
      if (error) {
        toast.error(friendlyError(error, t("sessionTranscript.fetchError")));
        return;
      }
      const res = data as { ok?: boolean; error?: string; found?: number };
      if (!res?.ok) {
        setErrorCode(res?.error ?? "unknown");
        return;
      }
      if ((res.found ?? 0) === 0) setErrorCode("no_transcripts");
      else toast.success(t("sessionTranscript.fetchedOk"));
      await load(session.id);
    } catch (e) {
      toast.error(friendlyError(e, t("sessionTranscript.fetchError")));
    } finally {
      setFetching(false);
    }
  };

  const toggleSpeaker = (rowId: string, speaker: string) => {
    setSelection((prev) => {
      const cur = prev[rowId] ?? [];
      const has = cur.some((s) => s.toLowerCase() === speaker.toLowerCase());
      return {
        ...prev,
        [rowId]: has
          ? cur.filter((s) => s.toLowerCase() !== speaker.toLowerCase())
          : [...cur, speaker],
      };
    });
  };

  const saveSpeakers = async (rowId: string) => {
    setSavingId(rowId);
    try {
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: {
          action: "set_transcript_speakers",
          transcriptId: rowId,
          teacherSpeakers: selection[rowId] ?? [],
        },
      });
      if (error) {
        toast.error(friendlyError(error, t("sessionTranscript.speakers.saveError")));
        return;
      }
      const res = data as { ok?: boolean; error?: string; teacherText?: string };
      if (!res?.ok) {
        toast.error(t("sessionTranscript.speakers.saveError"));
        return;
      }
      toast.success(t("sessionTranscript.speakers.saved"));
      if (session) await load(session.id);
    } catch (e) {
      toast.error(friendlyError(e, t("sessionTranscript.speakers.saveError")));
    } finally {
      setSavingId(null);
    }
  };

  const copy = async (rowId: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(rowId);
      setTimeout(() => setCopiedId((c) => (c === rowId ? null : c)), 2000);
    } catch {
      toast.error(t("sessionTranscript.copyError"));
    }
  };

  const label = session
    ? `${session.title?.trim() || t("sessionTranscript.defaultSessionTitle")} · ${formatDateOnly(session.session_date)}`
    : "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[85dvh] flex flex-col gap-0 p-0">
        <DialogHeader className="p-4 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Captions className="h-5 w-5 text-primary" aria-hidden />
            {t("sessionTranscript.title")}
            {label && <span className="text-muted-foreground font-normal">· {label}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* Subir .vtt — camino principal. */}
          <div className="rounded-md border p-3 space-y-2">
            <p className="text-sm font-medium">{t("sessionTranscript.upload.title")}</p>
            <p className="text-xs text-muted-foreground">{t("sessionTranscript.upload.hint")}</p>
            <Button asChild disabled={uploading} aria-disabled={uploading}>
              <label className={uploading ? "pointer-events-none opacity-60" : "cursor-pointer"}>
                {uploading ? (
                  <Spinner size="sm" className="mr-2" />
                ) : (
                  <Upload className="h-4 w-4 mr-2" />
                )}
                {uploading ? t("sessionTranscript.upload.uploading") : t("sessionTranscript.upload.button")}
                <input
                  type="file"
                  accept=".vtt,text/vtt"
                  className="sr-only"
                  disabled={uploading}
                  onChange={(e) => {
                    void onPickFile(e.target.files?.[0] ?? null);
                    e.target.value = "";
                  }}
                />
              </label>
            </Button>
          </div>

          {/* Traer de Teams — secundario (depende de aprobación de TI). */}
          {hasTeams && (
            <div className="space-y-2">
              <Button variant="outline" onClick={() => void fetchTranscript()} disabled={fetching}>
                {fetching ? <Spinner size="sm" className="mr-2" /> : null}
                {fetching ? t("sessionTranscript.fetching") : t("sessionTranscript.fetch")}
              </Button>
              {fetching && (
                <p className="text-xs text-muted-foreground">{t("sessionTranscript.fetchingHint")}</p>
              )}
            </div>
          )}
          {!hasTeams && rows.length === 0 && (
            <Alert>
              <CalendarClock className="h-4 w-4" />
              <AlertDescription>
                {t("sessionTranscript.noTeams")}{" "}
                <Link to="/app/teacher/calendar" className="underline font-medium">
                  {t("sessionTranscript.goToCalendar")}
                </Link>
              </AlertDescription>
            </Alert>
          )}

          {/* Error de dominio traducido + acción. */}
          {errorCode && (
            <Alert variant={errorCode === "no_transcripts" ? "default" : "destructive"}>
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {t(`sessionTranscript.errors.${errorCode}`, {
                  defaultValue: t("sessionTranscript.errors.unknown"),
                })}{" "}
                {RECONNECT_CODES.has(errorCode) && (
                  <Link to="/app/teacher/calendar" className="underline font-medium">
                    {t("sessionTranscript.reconnect")}
                  </Link>
                )}
              </AlertDescription>
            </Alert>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" /> {t("sessionTranscript.loading")}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("sessionTranscript.empty")}</p>
          ) : (
            rows.map((r) => {
              const speakers = r.speakers ?? [];
              const sel = selection[r.id] ?? [];
              const dirty =
                JSON.stringify([...sel].sort()) !==
                JSON.stringify([...(r.teacher_speakers ?? [])].sort());
              return (
                <div key={r.id} className="rounded-md border p-3 space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {r.file_name || t("sessionTranscript.transcriptLabel")}
                  </p>

                  {/* Selección de hablantes-docente. */}
                  {speakers.length > 0 ? (
                    <div className="space-y-2">
                      <p className="text-sm">{t("sessionTranscript.speakers.question")}</p>
                      <div className="space-y-1.5">
                        {speakers.map((sp) => {
                          const checked = sel.some((s) => s.toLowerCase() === sp.toLowerCase());
                          return (
                            <label key={sp} className="flex items-center gap-2 text-sm cursor-pointer">
                              <Checkbox
                                checked={checked}
                                onCheckedChange={() => toggleSpeaker(r.id, sp)}
                              />
                              <span>{sp}</span>
                            </label>
                          );
                        })}
                      </div>
                      <Button size="sm" disabled={!dirty || savingId === r.id} onClick={() => void saveSpeakers(r.id)}>
                        {savingId === r.id ? <Spinner size="sm" className="mr-2" /> : null}
                        {t("sessionTranscript.speakers.save")}
                      </Button>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("sessionTranscript.speakers.none")}
                    </p>
                  )}

                  {/* Texto del docente (lo que lee el Tutor IA). */}
                  {r.teacher_text?.trim() ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-muted-foreground">
                          {t("sessionTranscript.teacherTextLabel")}
                        </span>
                        <Button variant="outline" size="sm" onClick={() => void copy(r.id, r.teacher_text ?? "")}>
                          {copiedId === r.id ? (
                            <Check className="h-4 w-4 mr-1.5 text-success" />
                          ) : (
                            <Copy className="h-4 w-4 mr-1.5" />
                          )}
                          {copiedId === r.id ? t("sessionTranscript.copied") : t("common.copy")}
                        </Button>
                      </div>
                      <pre className="whitespace-pre-wrap text-sm bg-muted rounded-md p-3 font-sans max-h-48 overflow-y-auto">
                        {r.teacher_text}
                      </pre>
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      {t("sessionTranscript.teacherTextEmpty")}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

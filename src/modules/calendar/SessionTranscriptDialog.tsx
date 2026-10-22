/**
 * SessionTranscriptDialog — trae y muestra la transcripción de Teams de una
 * sesión de clase. Se abre desde el menú de la sesión en
 * `app.teacher.attendance.tsx`.
 *
 * Flujo (P9): al abrir, muestra la transcripción ya guardada si existe. El
 * botón primario «Traer transcripción» invoca el edge `calendar`
 * (acción fetch_transcript), con un estado intermedio mientras tanto. Los
 * errores de dominio vienen como código y se traducen a un mensaje con la
 * acción a seguir.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { Captions, Copy, Check, CalendarClock, AlertTriangle } from "lucide-react";

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

/** Códigos que NO son fallo técnico: el edge los devuelve con ok:false y la UI
 *  los traduce. Para `needs_reconnect`/`not_microsoft_account`/`not_connected`
 *  mostramos además el enlace a Calendario. */
const RECONNECT_CODES = new Set(["needs_reconnect", "not_microsoft_account", "not_connected"]);

export function SessionTranscriptDialog({ session, onClose }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false); // cargando lo ya guardado
  const [fetching, setFetching] = useState(false); // trayendo de Teams
  const [text, setText] = useState("");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const open = session !== null;
  const hasTeams = /teams\.microsoft\.com\/l\/meetup-join/i.test(session?.meeting_url ?? "");

  // Al abrir: traer la transcripción ya guardada (si la hay).
  useEffect(() => {
    if (!session) {
      setText("");
      setErrorCode(null);
      setCopied(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const { data, error } = await db
          .from("session_transcripts")
          .select("content_text, transcript_created_at")
          .eq("session_id", session.id)
          .order("transcript_created_at", { ascending: true, nullsFirst: true });
        if (cancelled) return;
        if (error) {
          toast.error(friendlyError(error, t("sessionTranscript.loadError")));
          return;
        }
        const combined = (data ?? [])
          .map((r: { content_text: string | null }) => r.content_text ?? "")
          .filter(Boolean)
          .join("\n\n");
        setText(combined);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, t]);

  const fetchTranscript = async () => {
    if (!session) return;
    setFetching(true);
    setErrorCode(null);
    try {
      const { data, error } = await supabase.functions.invoke("calendar", {
        body: { action: "fetch_transcript", provider: "microsoft", sessionId: session.id },
      });
      if (error) {
        // Fallo técnico (no-2xx) — el cuerpo de dominio se pierde en invoke.
        toast.error(friendlyError(error, t("sessionTranscript.fetchError")));
        return;
      }
      const res = data as { ok?: boolean; error?: string; text?: string; found?: number };
      if (!res?.ok) {
        setErrorCode(res?.error ?? "unknown");
        return;
      }
      setText(res.text ?? "");
      if ((res.found ?? 0) === 0) {
        setErrorCode("no_transcripts");
      } else {
        toast.success(t("sessionTranscript.fetchedOk"));
      }
    } catch (e) {
      toast.error(friendlyError(e, t("sessionTranscript.fetchError")));
    } finally {
      setFetching(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("sessionTranscript.copyError"));
    }
  };

  const label = session
    ? `${session.title?.trim() || t("sessionTranscript.defaultSessionTitle")} · ${session.session_date}`
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

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {/* Sin reunión de Teams: explicar que primero hay que sincronizar. */}
          {!hasTeams ? (
            <Alert>
              <CalendarClock className="h-4 w-4" />
              <AlertDescription>
                {t("sessionTranscript.noTeams")}{" "}
                <Link to="/app/teacher/calendar" className="underline font-medium">
                  {t("sessionTranscript.goToCalendar")}
                </Link>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t("sessionTranscript.intro")}</p>
              <Button onClick={() => void fetchTranscript()} disabled={fetching}>
                {fetching ? <Spinner size="sm" className="mr-2" /> : null}
                {fetching
                  ? t("sessionTranscript.fetching")
                  : text
                    ? t("sessionTranscript.refetch")
                    : t("sessionTranscript.fetch")}
              </Button>
              {fetching && (
                <p className="text-xs text-muted-foreground">
                  {t("sessionTranscript.fetchingHint")}
                </p>
              )}
            </>
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

          {/* Transcripción guardada. */}
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" /> {t("sessionTranscript.loading")}
            </div>
          ) : text ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("sessionTranscript.transcriptLabel")}
                </span>
                <Button variant="outline" size="sm" onClick={() => void copy()}>
                  {copied ? (
                    <Check className="h-4 w-4 mr-1.5 text-success" />
                  ) : (
                    <Copy className="h-4 w-4 mr-1.5" />
                  )}
                  {copied ? t("sessionTranscript.copied") : t("common.copy")}
                </Button>
              </div>
              <pre className="whitespace-pre-wrap text-sm bg-muted rounded-md p-3 font-sans">
                {text}
              </pre>
            </div>
          ) : hasTeams && !errorCode ? (
            <p className="text-sm text-muted-foreground">{t("sessionTranscript.empty")}</p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

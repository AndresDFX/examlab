/**
 * Calendario — el docente conecta su cuenta de calendario externo
 * (Google hoy, Outlook próximamente) y sincroniza las sesiones del
 * curso como eventos con Meet link e invitación a los estudiantes
 * matriculados.
 *
 * Arquitectura: el servidor vive 100% en Supabase Edge Functions —
 *   - `calendar` (RPC): status/init/list/select/disconnect/sync
 *   - `calendar-oauth-callback` (público): recibe el code de Google
 *
 * Sin TanStack Query / Server Functions porque la app es un SPA en
 * Lovable Cloud (no hay runtime Node para SSR). State con useState +
 * useEffect; reads con supabase.functions.invoke().
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { CalendarDays, Link2, Unlink, RefreshCw, CheckCircle2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/app/teacher/calendar")({ component: CalendarPage });

// Proveedores soportados. Outlook llega cuando agreguemos el provider
// de Microsoft Graph — por ahora el select lo deja deshabilitado.
type CalendarProvider = "google" | "microsoft";

interface CalendarStatus {
  connected: boolean;
  provider: CalendarProvider | null;
  provider_email: string | null;
  calendar_id: string | null;
  calendar_name: string | null;
  updated_at: string | null;
}

interface CalendarItem {
  id: string;
  name: string;
  primary: boolean;
}

interface SyncResult {
  created: number;
  updated: number;
  failed: number;
  total: number;
  errors: string[];
}

interface CourseRow {
  id: string;
  name: string;
}

/** Wrapper alrededor de supabase.functions.invoke('calendar', { body: { action, ... } }).
 *  Centraliza el manejo de errores para evitar 5 try/catch idénticos. */
async function callCalendar<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("calendar", { body });
  if (error) throw new Error(error.message);
  if (data && typeof data === "object" && "ok" in data && data.ok === false) {
    throw new Error((data as { error?: string }).error ?? "unknown_error");
  }
  return data as T;
}

function CalendarPage() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [provider, setProvider] = useState<CalendarProvider>("google");
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [calendars, setCalendars] = useState<CalendarItem[]>([]);
  const [calendarsLoading, setCalendarsLoading] = useState(false);
  const [calendarsError, setCalendarsError] = useState<string | null>(null);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [selectedCalId, setSelectedCalId] = useState<string>("");
  const [selectedCourseId, setSelectedCourseId] = useState<string>("");
  const [connecting, setConnecting] = useState(false);
  const [savingCalendar, setSavingCalendar] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  // ── Status (siempre, no depende de connect) ──
  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const r = await callCalendar<CalendarStatus & { ok: true }>({
        action: "status",
        provider,
      });
      setStatus(r);
      if (r.calendar_id) setSelectedCalId(r.calendar_id);
    } catch (e) {
      toast.error(`${t("calendar.statusError")}: ${(e as Error).message}`);
    } finally {
      setStatusLoading(false);
    }
  }, [provider, t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  // ── Toast del callback (?ok=1 o ?err=...) ──
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("ok")) {
      toast.success(t("calendar.connectedToast"));
      window.history.replaceState({}, "", window.location.pathname);
      void loadStatus();
    } else if (sp.get("err")) {
      const err = sp.get("err")!;
      const friendly =
        err === "no_refresh_token"
          ? t("calendar.errorNoRefresh")
          : `${t("calendar.connectError")}: ${err}`;
      toast.error(friendly);
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Cursos del docente (para el selector de sync) ──
  useEffect(() => {
    if (!user) return;
    void (async () => {
      const { data, error } = await supabase
        .from("course_teachers")
        .select("course_id, courses:course_id (id, name)")
        .eq("user_id", user.id);
      if (error) return;
      const rows = (data ?? [])
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((r: any) => r.courses)
        .filter(Boolean) as CourseRow[];
      setCourses(rows);
    })();
  }, [user]);

  // ── Calendarios disponibles (solo si conectado) ──
  const loadCalendars = useCallback(async () => {
    setCalendarsLoading(true);
    setCalendarsError(null);
    try {
      const r = await callCalendar<{ ok: true; calendars: CalendarItem[] }>({
        action: "list",
        provider,
      });
      setCalendars(r.calendars);
    } catch (e) {
      setCalendarsError((e as Error).message);
    } finally {
      setCalendarsLoading(false);
    }
  }, [provider]);

  useEffect(() => {
    if (status?.connected) void loadCalendars();
  }, [status?.connected, loadCalendars]);

  // ── Acciones ──
  const handleConnect = async () => {
    setConnecting(true);
    try {
      const r = await callCalendar<{ ok: true; url: string }>({
        action: "init",
        provider,
        origin: window.location.origin,
      });
      window.location.href = r.url;
    } catch (e) {
      toast.error(`${t("calendar.connectError")}: ${(e as Error).message}`);
      setConnecting(false);
    }
  };

  const handleSaveCalendar = async () => {
    const cal = calendars.find((c) => c.id === selectedCalId);
    if (!cal) {
      toast.error(t("calendar.calendarNotFound"));
      return;
    }
    setSavingCalendar(true);
    try {
      await callCalendar({
        action: "select",
        provider,
        calendarId: cal.id,
        calendarName: cal.name,
      });
      toast.success(t("calendar.calendarSavedToast"));
      await loadStatus();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingCalendar(false);
    }
  };

  const handleDisconnect = async () => {
    const ok = await confirm({
      title: t("calendar.disconnectTitle"),
      description: t("calendar.disconnectBody"),
      confirmLabel: t("calendar.disconnectAction"),
      tone: "warning",
    });
    if (!ok) return;
    setDisconnecting(true);
    try {
      await callCalendar({ action: "disconnect", provider });
      toast.success(t("calendar.disconnectedToast"));
      setStatus(null);
      setCalendars([]);
      setSelectedCalId("");
      await loadStatus();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSync = async () => {
    if (!selectedCourseId || !status?.calendar_id) return;
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = await callCalendar<SyncResult & { ok: true }>({
        action: "sync",
        provider,
        courseId: selectedCourseId,
      });
      setSyncResult(r);
      toast.success(
        t("calendar.syncDoneToast", {
          created: r.created,
          updated: r.updated,
          failed: r.failed,
        }),
      );
    } catch (e) {
      toast.error(`${t("calendar.syncError")}: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  };

  const connected = !!status?.connected;

  return (
    <div className="container max-w-4xl py-6 space-y-6">
      <PageHeader
        title={t("calendar.title")}
        subtitle={t("calendar.subtitle")}
        icon={<CalendarDays className="h-6 w-6 text-primary" />}
      />

      {/* Provider selector — Google único disponible por ahora; Outlook
          aparece deshabilitado para que el docente sepa que está en hoja
          de ruta. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("calendar.providerLabel")}</CardTitle>
          <CardDescription>{t("calendar.providerHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={provider} onValueChange={(v) => setProvider(v as CalendarProvider)}>
            <SelectTrigger className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="google">Google Calendar</SelectItem>
              <SelectItem value="microsoft" disabled>
                Outlook / Microsoft 365 ({t("calendar.comingSoon")})
              </SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {statusLoading ? (
        <div className="flex justify-center py-8">
          <Spinner size="lg" />
        </div>
      ) : !connected ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("calendar.connectTitle")}</CardTitle>
            <CardDescription>{t("calendar.connectBody")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleConnect} disabled={connecting}>
              {connecting ? (
                <Spinner size="sm" className="mr-2" />
              ) : (
                <Link2 className="h-4 w-4 mr-2" />
              )}
              {t("calendar.connectAction")}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                  {t("calendar.connectedTitle")}
                  <Badge variant="outline" className="text-[10px]">
                    {provider === "google" ? "Google" : "Microsoft"}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {status?.provider_email ?? t("calendar.connectedFallback")}
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                <Unlink className="h-4 w-4 mr-2" />
                {t("calendar.disconnectAction")}
              </Button>
            </CardHeader>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("calendar.step1Title")}</CardTitle>
              <CardDescription>{t("calendar.step1Body")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {calendarsLoading ? (
                <Spinner />
              ) : calendarsError ? (
                <Alert variant="destructive">
                  <AlertDescription>{calendarsError}</AlertDescription>
                </Alert>
              ) : (
                <>
                  <Label>{t("calendar.calendarLabel")}</Label>
                  <Select value={selectedCalId} onValueChange={setSelectedCalId}>
                    <SelectTrigger>
                      <SelectValue placeholder={t("calendar.calendarPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {calendars.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                          {c.primary ? ` (${t("calendar.primary")})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    onClick={handleSaveCalendar}
                    disabled={
                      !selectedCalId || savingCalendar || selectedCalId === status?.calendar_id
                    }
                  >
                    {savingCalendar ? <Spinner size="sm" className="mr-2" /> : null}
                    {t("calendar.saveCalendarAction")}
                  </Button>
                  {status?.calendar_name && (
                    <p className="text-sm text-muted-foreground">
                      {t("calendar.currentCalendar")}:{" "}
                      <span className="font-medium">{status.calendar_name}</span>
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t("calendar.step2Title")}</CardTitle>
              <CardDescription>{t("calendar.step2Body")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Label>{t("calendar.courseLabel")}</Label>
              <Select value={selectedCourseId} onValueChange={setSelectedCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("calendar.coursePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                onClick={handleSync}
                disabled={!selectedCourseId || !status?.calendar_id || syncing}
              >
                {syncing ? (
                  <Spinner size="sm" className="mr-2" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-2" />
                )}
                {t("calendar.syncAction")}
              </Button>
              {!status?.calendar_id && (
                <p className="text-sm text-muted-foreground">{t("calendar.saveCalendarFirst")}</p>
              )}
              {syncResult && (
                <Alert>
                  <AlertDescription className="space-y-1">
                    <div>
                      {t("calendar.syncSummary", {
                        total: syncResult.total,
                        created: syncResult.created,
                        updated: syncResult.updated,
                        failed: syncResult.failed,
                      })}
                    </div>
                    {syncResult.errors.length > 0 && (
                      <ul className="text-xs list-disc list-inside text-destructive">
                        {syncResult.errors.slice(0, 5).map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                      </ul>
                    )}
                  </AlertDescription>
                </Alert>
              )}
              <p className="text-xs text-muted-foreground">
                {t("calendar.syncFootnote")}{" "}
                <Link to="/app/teacher/attendance" className="underline">
                  {t("calendar.viewSessions")}
                </Link>
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

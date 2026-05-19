import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { useNotifications } from "@/hooks/use-notifications";
import { formatDate, formatDateTime } from "@/shared/lib/format";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { OpenFeedbackModal } from "@/modules/grading/OpenFeedbackModal";
import { PendingExamNotesModal } from "@/modules/exams/PendingExamNotesModal";
import { pendingResponsesCount } from "@/modules/grading/feedback-stats";
import { AiGradingQueueWidget } from "@/modules/ai/AiGradingQueueWidget";
import { AiOverrideDialog } from "@/modules/ai/AiOverrideDialog";
import { cn } from "@/shared/lib/utils";
import {
  Users,
  BookOpen,
  FileText,
  ClipboardList,
  Hammer,
  FolderKanban,
  Calendar,
  Clock,
  AlertTriangle,
  ArrowRight,
  ShieldCheck,
  Play,
  Send,
  Eye,
  MessageSquareText,
  Reply,
  TrendingUp,
  UserCog,
  Inbox,
  CalendarClock,
  CalendarCheck,
  Sparkles,
  Bot,
  CircleCheck,
  Search,
} from "lucide-react";

export const Route = createFileRoute("/app/")({ component: Dashboard });

// `DASHBOARD_NOTIF_LIMIT` y `formatNotifDate` se removieron junto con
// el card de notificaciones del dashboard. Las notificaciones siguen
// disponibles desde el bell del header global (NotificationBell), que
// tiene su propio formato relativo.

function Dashboard() {
  const { profile, user } = useAuth();
  const activeRole = useActiveRole();
  // Las notificaciones siguen viviendo en el bell del header global
  // (NotificationBell). Aquí solo las usamos para disparar el toast de
  // bienvenida con las no-leídas — el card grande de notificaciones se
  // removió del dashboard para que las 4 cards de eventos (Próximas
  // clases / proyectos / exámenes / talleres) ocupen toda la altura.
  const { notifications, unreadCount } = useNotifications(user?.id, activeRole);
  const { t } = useTranslation();

  const isAdmin = activeRole === "Admin";
  const isTeacher = activeRole === "Docente";
  const isStudent = activeRole === "Estudiante";

  // Toast unread on mount — sigue siendo útil para que al entrar al
  // dashboard el docente vea de inmediato qué hay nuevo.
  useEffect(() => {
    if (unreadCount > 0) {
      const recent = notifications.filter((n) => !n.read).slice(0, 3);
      recent.forEach((n) => {
        toast.info(n.title, { description: n.body, duration: 5000 });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    // Layout flex-col con altura mínima del viewport (descontado solo
    // el padding del AppLayout). El card de notificaciones se quitó del
    // dashboard, así que los cards de eventos (Próximas clases /
    // proyectos / exámenes / talleres) usan TODO el espacio vertical
    // disponible vía flex-1 + min-h-0 en el wrapper interno.
    <div className="flex flex-col gap-6 min-h-[calc(100vh-5rem)]">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          {t("dashboard.hello")}, {profile?.full_name?.split(" ")[0] ?? "👋"}
        </h1>
        <p className="text-muted-foreground">
          {isAdmin
            ? t("dashboard.greetingAdmin")
            : isTeacher
              ? t("dashboard.greetingTeacher")
              : t("dashboard.greetingStudent")}
        </p>
      </div>

      {isAdmin && <AdminDashboard />}
      {isTeacher && <TeacherDashboard userId={user?.id} />}
      {isStudent && <StudentDashboard userId={user?.id} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ADMIN DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function AdminDashboard() {
  const { t } = useTranslation();
  const [counts, setCounts] = useState({
    users: 0,
    courses: 0,
    exams: 0,
    submissions: 0,
    workshops: 0,
  });
  const [recentUsers, setRecentUsers] = useState<
    {
      id: string;
      full_name: string;
      institutional_email: string;
      created_at: string;
      roles: string[];
    }[]
  >([]);
  // ── AI usage stats (última hora) — reemplazan los 5 cards superiores
  // que antes solo mostraban totales agregados sin contexto temporal.
  // El admin ahora ve de un vistazo si el sistema de IA está sano:
  // cuántas llamadas, cuántos errores, qué se está haciendo con IA.
  // Renombramos a *Last24h porque el filtro de fecha pasó de 1h a 24h
  // (más informativo para un dashboard que se mira un par de veces al
  // día). Los nombres preservan el tag de ventana temporal para que
  // cualquier display pueda mostrarlo sin lookup adicional.
  const [aiStats, setAiStats] = useState({
    callsLastHour: 0,
    errorsLastHour: 0,
    gradingsLastHour: 0,
    questionsGenLastHour: 0,
    plagiarismLastHour: 0,
  });
  /** Métricas del módulo de email — últimas 24h. Reemplazo del bloque
   *  de "Opciones rápidas" (Usuarios + Cursos eran solo atajos
   *  duplicados del sidebar; este widget aporta info operacional real
   *  ahora que el sistema de correo es crítico). */
  const [emailStats, setEmailStats] = useState<{
    delivered: number;
    skipped: number;
    failed: number;
    recent: Array<{
      action: string;
      severity: string;
      created_at: string;
      metadata: Record<string, unknown>;
    }>;
  } | null>(null);
  // Errores últimas 3h — severity error|critical en audit_logs.
  const [errorStats, setErrorStats] = useState<{
    count: number;
    topActions: Array<{ action: string; count: number }>;
  } | null>(null);

  useEffect(() => {
    (async () => {
      const [u, c, e, s, w] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("courses").select("id", { count: "exact", head: true }),
        supabase.from("exams").select("id", { count: "exact", head: true }),
        supabase.from("submissions").select("id", { count: "exact", head: true }),
        supabase.from("workshops").select("id", { count: "exact", head: true }),
      ]);
      setCounts({
        users: u.count ?? 0,
        courses: c.count ?? 0,
        exams: e.count ?? 0,
        submissions: s.count ?? 0,
        workshops: w.count ?? 0,
      });

      // Recent users: traemos también el id + roles para mostrar badge
      // y ampliamos a 10. user_roles puede tener 0..N filas por usuario;
      // hacemos JOIN client-side para no complicar la query.
      const { data: ru } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email, created_at")
        .order("created_at", { ascending: false })
        .limit(10);
      const ruRows = (ru ?? []) as Array<{
        id: string;
        full_name: string;
        institutional_email: string;
        created_at: string;
      }>;
      if (ruRows.length > 0) {
        const { data: rolesRows } = await supabase
          .from("user_roles")
          .select("user_id, role")
          .in(
            "user_id",
            ruRows.map((u) => u.id),
          );
        const rolesByUser = new Map<string, string[]>();
        for (const r of (rolesRows ?? []) as Array<{ user_id: string; role: string }>) {
          const arr = rolesByUser.get(r.user_id) ?? [];
          arr.push(r.role);
          rolesByUser.set(r.user_id, arr);
        }
        setRecentUsers(ruRows.map((u) => ({ ...u, roles: rolesByUser.get(u.id) ?? [] })));
      } else {
        setRecentUsers([]);
      }

      // Métricas de email en las últimas 24h. Un SELECT con filtros
      // específicos por action — más eficiente que cargar todo y
      // agrupar en cliente. Si la tabla aún no tiene la categoría
      // 'email' (migración no aplicada en este entorno) los counts
      // quedan en 0 sin romper.
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // Ventana de 24h para todas las métricas de IA — antes era 1h, lo
      // que dejaba el dashboard frecuentemente "vacío" cuando el admin
      // entraba fuera de pico de uso. 24h captura el patrón completo de
      // una jornada típica.
      const sinceHour = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;

      // ── AI usage stats (última hora) ──
      // Filtramos por las acciones que ya estaban definidas (audit log
      // labels). Si alguna no aparece la migración no se ha aplicado y
      // el count queda en 0 sin romper.
      // `list_recent_ai_executions` se quitó del Promise.all junto con su
      // setter — la card "Ejecuciones IA" se removió del dashboard porque
      // duplicaba lo que la cola IA full-width ya expone. Si en el futuro
      // se necesita el listado detallado, está en /app/admin/audit-logs.
      const [aiCallsRes, aiErrorsRes, aiGradingsRes, aiQuestionsRes, aiPlagiarismRes] =
        await Promise.all([
          dbAny
            .from("audit_logs")
            .select("id", { count: "exact", head: true })
            .in("action", [
              "ai.grading_started",
              "ai.grading_failed",
              "ai_grading.completed",
              "ai_questions.generated",
              "ai_plagiarism.detected",
              "ai.grading_retry_run",
              "ai.questions_generation_failed",
            ])
            .gte("created_at", sinceHour),
          dbAny
            .from("audit_logs")
            .select("id", { count: "exact", head: true })
            .in("action", ["ai.grading_failed", "ai.questions_generation_failed"])
            .gte("created_at", sinceHour),
          dbAny
            .from("audit_logs")
            .select("id", { count: "exact", head: true })
            .eq("action", "ai_grading.completed")
            .gte("created_at", sinceHour),
          dbAny
            .from("audit_logs")
            .select("id", { count: "exact", head: true })
            .eq("action", "ai_questions.generated")
            .gte("created_at", sinceHour),
          dbAny
            .from("audit_logs")
            .select("id", { count: "exact", head: true })
            .eq("action", "ai_plagiarism.detected")
            .gte("created_at", sinceHour),
        ]);
      setAiStats({
        callsLastHour: aiCallsRes.count ?? 0,
        errorsLastHour: aiErrorsRes.count ?? 0,
        gradingsLastHour: aiGradingsRes.count ?? 0,
        questionsGenLastHour: aiQuestionsRes.count ?? 0,
        plagiarismLastHour: aiPlagiarismRes.count ?? 0,
      });

      const [delivRes, skipRes, failRes, recentRes] = await Promise.all([
        dbAny
          .from("audit_logs")
          .select("id", { count: "exact", head: true })
          .eq("category", "email")
          .eq("action", "email.delivered")
          .gte("created_at", since),
        dbAny
          .from("audit_logs")
          .select("id", { count: "exact", head: true })
          .eq("category", "email")
          .eq("action", "email.skipped")
          .gte("created_at", since),
        dbAny
          .from("audit_logs")
          .select("id", { count: "exact", head: true })
          .eq("category", "email")
          .eq("action", "email.failed")
          .gte("created_at", since),
        dbAny
          .from("audit_logs")
          .select("action, severity, created_at, metadata")
          .eq("category", "email")
          .gte("created_at", since)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);
      setEmailStats({
        delivered: delivRes.count ?? 0,
        skipped: skipRes.count ?? 0,
        failed: failRes.count ?? 0,
        recent: (recentRes.data ?? []) as Array<{
          action: string;
          severity: string;
          created_at: string;
          metadata: Record<string, unknown>;
        }>,
      });

      // Errores últimas 3h — cualquier categoría con severity error|critical.
      const since3h = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const [errCountRes, errTopRes] = await Promise.all([
        dbAny
          .from("audit_logs")
          .select("id", { count: "exact", head: true })
          .in("severity", ["error", "critical"])
          .gte("created_at", since3h),
        dbAny
          .from("audit_logs")
          .select("action")
          .in("severity", ["error", "critical"])
          .gte("created_at", since3h)
          .order("created_at", { ascending: false })
          .limit(200),
      ]);
      const byAction = new Map<string, number>();
      for (const r of (errTopRes.data ?? []) as Array<{ action: string }>) {
        byAction.set(r.action, (byAction.get(r.action) ?? 0) + 1);
      }
      setErrorStats({
        count: errCountRes.count ?? 0,
        topActions: Array.from(byAction.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([action, count]) => ({ action, count })),
      });
    })();
  }, []);

  return (
    <>
      {/* Cards de uso de IA — última hora.
          Reemplazan los totales agregados (Users/Courses/Exams/etc.) que
          aportaban poco operacionalmente. Estas métricas le dicen al
          admin en tiempo real si el sistema de IA está sano: cuántas
          llamadas se hicieron, cuántos errores hubo, qué se está
          calificando o generando. Los totales antiguos siguen
          disponibles en cada módulo respectivo. */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat
          icon={Sparkles}
          label="Llamadas IA (24h)"
          value={aiStats.callsLastHour}
          color="text-indigo-500 dark:text-indigo-400"
        />
        <Stat
          icon={AlertTriangle}
          label="Errores IA (24h)"
          value={aiStats.errorsLastHour}
          color={
            aiStats.errorsLastHour > 0
              ? "text-destructive"
              : "text-emerald-500 dark:text-emerald-400"
          }
        />
        <Stat
          icon={CircleCheck}
          label="Calificaciones IA (24h)"
          value={aiStats.gradingsLastHour}
          color="text-emerald-500 dark:text-emerald-400"
        />
        <Stat
          icon={Bot}
          label="Preguntas IA (24h)"
          value={aiStats.questionsGenLastHour}
          color="text-violet-500 dark:text-violet-400"
        />
        <Stat
          icon={Search}
          label="Plagio detectado (24h)"
          value={aiStats.plagiarismLastHour}
          color="text-amber-500 dark:text-amber-400"
        />
      </div>

      {/* Cola IA full-width — Admin ve botón "Procesar ahora" para
          drenar la cola sin esperar al cron hourly. Antes ocupaba una
          de 3 columnas; lo extendimos a todo el ancho porque la
          observabilidad de la cola es la métrica operacional más
          importante en el dashboard (job pending, retries, throughput)
          y le faltaba espacio horizontal para mostrar todo lo que tiene
          que mostrar. La card "Ejecuciones IA" que vivía aquí se quitó
          — duplicaba info que la cola ya expone y no aportaba acción
          accionable distinta. */}
      <AiGradingQueueWidget isAdmin />

      {/* Grilla operacional de 2 columnas: Correos + Errores. Antes era
          de 3 (incluía "Ejecuciones IA"); con la card removida el grid
          se balancea a 2 cols extendidas, cada card duplica su ancho
          horizontal en pantallas md+ — más legible. En mobile sigue
          siendo 1 columna. `auto-rows-fr` mantiene alineación vertical. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 auto-rows-fr">
        {/* Métricas de correo — últimas 24h. Reemplaza el bloque de
            "Opciones rápidas" porque ese era solo un atajo duplicado del
            sidebar. Este widget aporta info operacional real: el admin
            ve de un vistazo si el sistema de email está sano y entra a
            auditoría si hay fallos. */}
        <Card className="h-full flex flex-col">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Inbox className="h-4 w-4 text-cyan-500 dark:text-cyan-400" />
              Correos (últimas 24h)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 flex-1 flex flex-col">
            {!emailStats ? (
              <p className="text-sm text-muted-foreground py-2">Cargando…</p>
            ) : emailStats.delivered + emailStats.skipped + emailStats.failed === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                Sin actividad de correo en las últimas 24 horas.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  <EmailStatTile
                    label="Entregados"
                    value={emailStats.delivered}
                    color="text-emerald-600 dark:text-emerald-400"
                    bg="bg-emerald-500/10"
                  />
                  <EmailStatTile
                    label="Omitidos"
                    value={emailStats.skipped}
                    color="text-amber-600 dark:text-amber-400"
                    bg="bg-amber-500/10"
                  />
                  <EmailStatTile
                    label="Fallidos"
                    value={emailStats.failed}
                    color="text-destructive"
                    bg="bg-destructive/10"
                  />
                </div>
                {emailStats.recent.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Últimos eventos</p>
                    {emailStats.recent.slice(0, 2).map((ev, i) => {
                      const severityColor =
                        ev.severity === "error"
                          ? "text-destructive"
                          : ev.severity === "warning"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground";
                      const reason =
                        typeof ev.metadata?.reason === "string"
                          ? (ev.metadata.reason as string)
                          : null;
                      return (
                        <div
                          key={i}
                          className="flex items-center justify-between gap-2 text-[11px] border-b last:border-b-0 pb-1"
                        >
                          <div className="min-w-0 flex-1">
                            <span className={`font-mono ${severityColor}`}>{ev.action}</span>
                            {reason && <span className="text-muted-foreground"> · {reason}</span>}
                          </div>
                          <span className="text-muted-foreground tabular-nums shrink-0">
                            {formatDateTime(ev.created_at)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
            <Link
              to="/app/admin/audit-logs"
              search={{ category: "email" } as Record<string, unknown>}
              className="block mt-auto"
            >
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                Ver auditoría de correos <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Errores últimas 3h — alerta operacional. Antes vivía en una
            segunda fila aparte; lo movimos a la grilla principal para
            que las 4 cards operacionales caigan en una sola fila en
            pantallas grandes. */}
        <Card
          className={`h-full flex flex-col ${
            errorStats && errorStats.count > 0 ? "border-destructive/40 bg-destructive/5" : ""
          }`}
        >
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle
                className={`h-4 w-4 ${
                  errorStats && errorStats.count > 0
                    ? "text-destructive"
                    : "text-emerald-500 dark:text-emerald-400"
                }`}
              />
              Errores (últimas 3h)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 flex-1 flex flex-col">
            {!errorStats ? (
              <p className="text-sm text-muted-foreground py-2">Cargando…</p>
            ) : errorStats.count === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                Sin errores ni eventos críticos. 🎉
              </p>
            ) : (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-semibold tabular-nums text-destructive">
                    {errorStats.count}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    evento{errorStats.count === 1 ? "" : "s"} con severity error/critical
                  </span>
                </div>
                {errorStats.topActions.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Top acciones</p>
                    {errorStats.topActions.slice(0, 3).map((a) => (
                      <div
                        key={a.action}
                        className="flex items-center justify-between gap-2 text-[11px] border-b last:border-b-0 pb-1"
                      >
                        <span className="font-mono truncate">{a.action}</span>
                        <span className="text-muted-foreground tabular-nums shrink-0">
                          {a.count}×
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            <Link
              to="/app/admin/audit-logs"
              search={{ severity: "error" } as Record<string, unknown>}
              className="block mt-auto"
            >
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                Ver auditoría de errores <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Mini-tile para mostrar un count + label con color. Usado solo por
 *  el widget de correos del AdminDashboard. */
function EmailStatTile({
  label,
  value,
  color,
  bg,
}: {
  label: string;
  value: number;
  color: string;
  bg: string;
}) {
  return (
    <div className={`rounded-md p-2.5 ${bg}`}>
      <div className={`text-2xl font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[10px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TEACHER DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function TeacherDashboard({ userId }: { userId: string | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  void userId; // la lógica de stats es rol-based, no depende del user_id
  const [counts, setCounts] = useState({
    pendingExamNotes: 0,
    /** Conversaciones del módulo /app/messages cuyo último mensaje
     *  (visible para mí, respetando cleared_at) lo envió la otra parte.
     *  La query es la RPC `count_unanswered_conversations`. */
    unansweredMessages: 0,
    /** Threads abiertos de retroalimentación con último comment NO de
     *  un docente. Se mantiene como métrica separada — es un dominio
     *  distinto (feedback de entregas vs. mensajería directa). */
    pendingMyResponse: 0,
    openThreads: 0,
    /** Sesiones de asistencia con `session_date = today` en mis cursos. */
    todaySessions: 0,
    /** Errores de llamada a IA disparados por este docente en la última
     *  hora. Cuenta `audit_logs` con `action = 'ai.grading_failed'` o
     *  `'ai.questions_generation_failed'` y `actor_id = mi user_id`. */
    aiErrorsLastHour: 0,
  });
  const [upcomingExams, setUpcomingExams] = useState<any[]>([]);
  const [activeWorkshops, setActiveWorkshops] = useState<any[]>([]);
  const [activeProjects, setActiveProjects] = useState<any[]>([]);
  /** Próximas sesiones de asistencia en cursos asignados al docente,
   *  con session_date >= hoy. Top 5 ordenadas por fecha + start_time. */
  const [upcomingSessions, setUpcomingSessions] = useState<any[]>([]);
  const [openFeedbackModalOpen, setOpenFeedbackModalOpen] = useState(false);
  /** Mismo modal pero con filtro "needsMyResponse" — abierto desde el
   *  card "Comentarios pendientes por respuesta". */
  const [pendingResponseModalOpen, setPendingResponseModalOpen] = useState(false);
  const [pendingNotesModalOpen, setPendingNotesModalOpen] = useState(false);
  // Dialog para activar/gestionar el código override de IA inmediata —
  // saltea la cola async durante una ventana corta.
  const [overrideDialogOpen, setOverrideDialogOpen] = useState(false);

  // Cuenta de exam_notes (notas de apoyo) en estado 'pendiente' — chuletas
  // que el estudiante subió y esperan revisión del docente. Se llama
  // también después de aprobar/rechazar desde el modal para refrescar
  // el badge sin recargar el dashboard completo.
  const refreshPendingExamNotes = async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count } = await (supabase as any)
      .from("exam_notes")
      .select("id", { count: "exact", head: true })
      .eq("status", "pendiente");
    setCounts((prev) => ({ ...prev, pendingExamNotes: count ?? 0 }));
  };

  useEffect(() => {
    (async () => {
      const now = new Date().toISOString();
      // Fecha de hoy en formato YYYY-MM-DD (zona local) para comparar
      // con `attendance_sessions.session_date` que es columna DATE sin TZ.
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

      // Conversaciones abiertas: feedback_threads con closed=false que el
      // docente puede ver (RLS filtra por curso). pendingMyResponse =
      // subset donde el último comment NO es de un docente.
      // unansweredMessages = conversaciones del módulo /app/messages
      // donde el último mensaje (visible) no es mío. Vive en una RPC
      // SECURITY DEFINER por eficiencia + correctness.
      // todaySessions = attendance_sessions con session_date = hoy (RLS
      // filtra por mis cursos).
      const [pendingNotes, openThreadsList, unansweredRes, todaySess] = await Promise.all([
        (supabase as any)
          .from("exam_notes")
          .select("id", { count: "exact", head: true })
          .eq("status", "pendiente"),
        (supabase as any).from("feedback_threads").select("id").eq("closed", false),
        (supabase as any).rpc("count_unanswered_conversations"),
        (supabase as any)
          .from("attendance_sessions")
          .select("id", { count: "exact", head: true })
          .eq("session_date", todayStr),
      ]);
      const openThreadIds: string[] = (openThreadsList.data ?? []).map((r: any) => r.id);
      let pendingMyResponse = 0;
      if (openThreadIds.length > 0) {
        const { data: comments } = await (supabase as any)
          .from("feedback_comments")
          .select("thread_id, author_role, created_at")
          .in("thread_id", openThreadIds);
        pendingMyResponse = pendingResponsesCount(
          openThreadIds,
          (comments ?? []) as Array<{
            thread_id: string;
            author_role: string | null;
            created_at: string;
          }>,
        );
      }
      // Si la RPC falla porque la migración no está aplicada, caemos a
      // 0 para que el dashboard no rompa. El bug se nota cuando el badge
      // se queda en 0 aunque haya conversaciones — el usuario sabe que
      // debe publicar la migración.
      const unansweredCount = typeof unansweredRes.data === "number" ? unansweredRes.data : 0;
      // Conteo de errores de llamada a IA del docente en la última hora.
      // RPC count_ai_errors_last_hour(actor_id) — si el docente acaba de
      // calificar y el provider devolvió 429/5xx, ese error queda en
      // audit_logs y aparece aquí. Si la migración no está aplicada o
      // el RPC falla, el card muestra 0 sin romper.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: aiErrCount } = await (supabase as any).rpc("count_ai_errors_last_hour", {
        _actor_id: userId ?? null,
      });
      setCounts({
        pendingExamNotes: pendingNotes.count ?? 0,
        unansweredMessages: unansweredCount,
        pendingMyResponse,
        openThreads: openThreadIds.length,
        todaySessions: todaySess.count ?? 0,
        aiErrorsLastHour: typeof aiErrCount === "number" ? aiErrCount : 0,
      });

      // Próximas clases: attendance_sessions del docente con
      // session_date >= hoy, ordenadas por fecha y hora. RLS recorta
      // a sus cursos.
      const { data: sess } = await (supabase as any)
        .from("attendance_sessions")
        .select("id, title, session_date, start_time, course_id, course:courses(name)")
        .gte("session_date", todayStr)
        .order("session_date", { ascending: true })
        .order("start_time", { ascending: true, nullsFirst: false })
        // Limit subido de 5 a 8 para que las cards (que ahora se expanden
        // verticalmente cuando no hay notificaciones) muestren más datos
        // útiles. El scroll interno del CardContent maneja la altura.
        .limit(8);
      setUpcomingSessions(sess ?? []);

      const { data: exams } = await supabase
        .from("exams")
        .select("id, title, start_time, end_time, time_limit_minutes, course:courses(name)")
        .gte("end_time", now)
        .order("start_time")
        .limit(8);
      setUpcomingExams(exams ?? []);

      const { data: ws } = await supabase
        .from("workshops")
        .select("id, title, due_date, status, course:courses(name)")
        .eq("status", "published")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(8);
      setActiveWorkshops(ws ?? []);

      const { data: pjs } = await (supabase as any)
        .from("projects")
        .select("id, title, due_date, status, course:courses(name)")
        .eq("status", "published")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(8);
      setActiveProjects(pjs ?? []);
    })();
  }, []);

  return (
    // Wrapper flex-col + flex-1 para que la fila de 4 cards de abajo
    // pueda crecer hasta llenar la altura disponible del viewport
    // cuando NO hay tarjeta de notificaciones bajo el dashboard. Si las
    // notificaciones aparecen, esta sección cede el espacio
    // automáticamente (cada card scrollea internamente). min-h-0
    // permite el shrinking dentro del padre flex.
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat
          icon={FileText}
          label={t("dashboard.stats.pendingExamNotes", {
            defaultValue: "Notas de examen pendientes",
          })}
          value={counts.pendingExamNotes}
          color="text-violet-500 dark:text-violet-400"
          onClick={() => setPendingNotesModalOpen(true)}
        />
        {/* Errores llamada IA (última hora): cuántos requests del docente
            a Gemini/OpenAI/etc. fallaron en los últimos 60 min (rate
            limit 429, key inválida, etc.). Si > 0 el cron de reintento
            los recoge cada 30 min. Click → abre Auditoría con filtro
            preconfigurado. */}
        <Stat
          icon={AlertTriangle}
          label="Errores IA (1h)"
          value={counts.aiErrorsLastHour}
          color={
            counts.aiErrorsLastHour > 0
              ? "text-destructive"
              : "text-emerald-500 dark:text-emerald-400"
          }
          onClick={() => void navigate({ to: "/app/teacher/audit-logs" })}
        />
        {/* Comentarios pendientes por respuesta del docente actual:
            threads abiertos donde el último comment lo escribió alguien
            que NO soy yo. Click → abre OpenFeedbackModal con
            filterMode="needsMyResponse". */}
        <Stat
          icon={Reply}
          label={t("dashboard.stats.pendingMyResponse", {
            defaultValue: "Comentarios pendientes por respuesta",
          })}
          value={counts.pendingMyResponse}
          color="text-rose-500 dark:text-rose-400"
          onClick={() => setPendingResponseModalOpen(true)}
        />
        <Stat
          icon={MessageSquareText}
          label={t("dashboard.stats.openThreads", {
            defaultValue: "Comentarios abiertos",
          })}
          value={counts.openThreads}
          color="text-pink-500 dark:text-pink-400"
          onClick={() => setOpenFeedbackModalOpen(true)}
        />
        {/* Sesiones de asistencia HOY en mis cursos. Click → módulo
            de asistencia para tomar la lista o cerrar el check-in. */}
        <Stat
          icon={CalendarClock}
          label={t("dashboard.stats.todaySessions", {
            defaultValue: "Sesiones hoy",
          })}
          value={counts.todaySessions}
          color="text-blue-500 dark:text-blue-400"
          onClick={() => void navigate({ to: "/app/teacher/attendance" })}
        />
      </div>

      {/* Cola IA + atajo "Activar IA inmediata" — el docente ve si hay
          jobs en su cola y, si necesita una nota IA YA, pega el código
          override que le pasó el admin para abrir ventana sincrónica. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <AiGradingQueueWidget />
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-amber-500" />
              IA inmediata (override)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Por defecto las calificaciones IA pasan por la cola async (procesada cada hora). Si
              necesitas una nota IA ahora, pídele al administrador un código y actívalo aquí — abre
              una ventana sincrónica corta sin tocar la configuración global.
            </p>
            <Button size="sm" variant="outline" onClick={() => setOverrideDialogOpen(true)}>
              <Sparkles className="h-3.5 w-3.5 mr-1" />
              Activar / gestionar IA inmediata
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* `flex-1 min-h-0` permite que la grid de 4 cards crezca hasta
          el final del viewport cuando no hay tarjeta de notificaciones
          abajo, y se encoja sin desbordar cuando sí la hay. Cada card
          dentro escucha esa altura con su propio flex-col + scroll. */}
      <div className="grid md:grid-cols-4 gap-4 flex-1 min-h-0">
        {/* Próximas clases — sesiones de asistencia con session_date >=
            hoy en los cursos asignados al docente. Reemplaza el bloque
            "Acciones rápidas" porque es más accionable: el docente ve a
            simple vista qué viene en los próximos días sin abrir el
            módulo de asistencia. RLS filtra a sus cursos. */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-cyan-500 dark:text-cyan-300" />{" "}
              {t("dashboard.upcomingClasses", { defaultValue: "Próximas clases" })}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            {/* La lista usa flex-1 + overflow-y-auto: cuando hay muchos
                items y la card creció (porque no hay notificaciones
                abajo), se ven más sin que el botón "Gestionar" se
                empuje fuera del viewport. */}
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {upcomingSessions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noUpcomingClasses", {
                    defaultValue: "No tienes sesiones próximas programadas.",
                  })}
                </p>
              ) : (
                upcomingSessions.map((s: any) => {
                  // session_date es DATE (YYYY-MM-DD); formatDate
                  // ya maneja string ISO. start_time viene separado;
                  // si existe lo concatenamos para mostrar hora.
                  const dateLabel = formatDate(s.session_date);
                  const timeLabel = s.start_time ? ` · ${s.start_time.slice(0, 5)}` : "";
                  return (
                    <EventRow
                      key={s.id}
                      title={s.title ?? t("dashboard.untitledSession", { defaultValue: "Clase" })}
                      subtitle={s.course?.name}
                      date={`${dateLabel}${timeLabel}`}
                    />
                  );
                })
              )}
            </div>
            <Link to="/app/teacher/attendance" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Active projects */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-rose-500 dark:text-rose-400" />{" "}
              {t("dashboard.activeProjects")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {activeProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noActiveProjects")}
                </p>
              ) : (
                activeProjects.map((p: any) => (
                  <EventRow
                    key={p.id}
                    title={p.title}
                    subtitle={p.course?.name}
                    date={p.due_date ? formatDate(p.due_date) : t("dashboard.noDate")}
                  />
                ))
              )}
            </div>
            <Link to="/app/teacher/projects" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Upcoming exams */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-violet-500 dark:text-violet-400" />{" "}
              {t("dashboard.upcomingExams")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {upcomingExams.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noUpcomingExams")}
                </p>
              ) : (
                upcomingExams.map((e: any) => {
                  const isOpen =
                    new Date() >= new Date(e.start_time) && new Date() <= new Date(e.end_time);
                  return (
                    <EventRow
                      key={e.id}
                      title={e.title}
                      subtitle={e.course?.name}
                      date={formatDate(e.start_time)}
                      badge={isOpen ? t("dashboard.inProgress") : undefined}
                      badgeColor="bg-success text-success-foreground"
                    />
                  );
                })
              )}
            </div>
            <Link to="/app/teacher/exams" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Active workshops */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" />{" "}
              {t("dashboard.activeWorkshops")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {activeWorkshops.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noActiveWorkshops")}
                </p>
              ) : (
                activeWorkshops.map((w: any) => (
                  <EventRow
                    key={w.id}
                    title={w.title}
                    subtitle={w.course?.name}
                    date={w.due_date ? formatDate(w.due_date) : t("dashboard.noDate")}
                  />
                ))
              )}
            </div>
            <Link to="/app/teacher/workshops" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      <OpenFeedbackModal open={openFeedbackModalOpen} onOpenChange={setOpenFeedbackModalOpen} />
      {/* Mismo modal, filtrado a "pendientes de mi respuesta". Compartir
          el componente evita duplicar la lógica de carga + render. */}
      <OpenFeedbackModal
        open={pendingResponseModalOpen}
        onOpenChange={setPendingResponseModalOpen}
        filterMode="needsMyResponse"
      />
      <PendingExamNotesModal
        open={pendingNotesModalOpen}
        onOpenChange={setPendingNotesModalOpen}
        onChange={refreshPendingExamNotes}
      />
      <AiOverrideDialog open={overrideDialogOpen} onOpenChange={setOverrideDialogOpen} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   STUDENT DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function StudentDashboard({ userId }: { userId: string | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [upcomingExams, setUpcomingExams] = useState<any[]>([]);
  const [pendingWorkshops, setPendingWorkshops] = useState<any[]>([]);
  const [pendingProjects, setPendingProjects] = useState<any[]>([]);
  /** Próximas sesiones de asistencia en cursos donde estoy matriculado,
   *  con session_date >= hoy. Mirror del bloque del docente. */
  const [upcomingSessions, setUpcomingSessions] = useState<any[]>([]);
  const [counts, setCounts] = useState({
    /** Mensajes pendientes sin responder — mismo RPC que el docente
     *  (`count_unanswered_conversations`), filtrado por `auth.uid()`. */
    unansweredMessages: 0,
    /** Sesiones de asistencia con `session_date = today` en mis cursos. */
    todaySessions: 0,
  });

  useEffect(() => {
    if (!userId) return;
    (async () => {
      // Fecha de hoy en formato YYYY-MM-DD (zona local) para comparar
      // con `attendance_sessions.session_date` que es columna DATE sin TZ.
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

      // Assigned exams
      const { data: asg } = await supabase
        .from("exam_assignments")
        .select(
          "exam:exams(id, title, start_time, end_time, time_limit_minutes, course:courses(name))",
        )
        .eq("user_id", userId);
      const examIds = (asg ?? []).map((a: any) => a.exam?.id).filter(Boolean);
      const { data: doneSubs } = examIds.length
        ? await supabase
            .from("submissions")
            .select("exam_id")
            .eq("user_id", userId)
            .in("exam_id", examIds)
            .in("status", ["completado", "sospechoso"])
        : { data: [] as any[] };
      const doneExamIds = new Set((doneSubs ?? []).map((s: any) => s.exam_id));
      const exams = (asg ?? [])
        .map((a: any) => a.exam)
        .filter((e: any) => e && new Date(e.end_time) > new Date() && !doneExamIds.has(e.id))
        .sort(
          (a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
        )
        // Subido a 8 para alinear con el dashboard del docente (las
        // cards crecen vertical y muestran más items útiles).
        .slice(0, 8);
      setUpcomingExams(exams);

      // Assigned workshops — "por entregar" = published + open
      // (due_date >= hoy) + el alumno aún no entregó. Antes incluíamos
      // talleres ya cerrados y ya entregados, lo que inflaba el count
      // y confundía al alumno.
      const { data: wasg } = await supabase
        .from("workshop_assignments")
        .select("workshop:workshops(id, title, due_date, status, start_date, course:courses(name))")
        .eq("user_id", userId);
      const todayISO = new Date().toISOString();
      const candidateWs = (wasg ?? [])
        .map((a: any) => a.workshop)
        .filter(
          (w: any) =>
            w &&
            w.status === "published" &&
            (!w.start_date || new Date(w.start_date) <= new Date()) &&
            // Cierre futuro (o sin cierre — entonces siempre "open").
            (!w.due_date || new Date(w.due_date) >= new Date(todayISO)),
        );
      const candidateWsIds = candidateWs.map((w: any) => w.id);
      // Excluye los que YA entregó el alumno. Estados finales = entregado/
      // calificado/ai_revisado/requiere_revision. "iniciado" no cuenta
      // como entregado — sigue siendo "por entregar".
      const { data: doneWsSubs } = candidateWsIds.length
        ? await supabase
            .from("workshop_submissions")
            .select("workshop_id, status")
            .eq("user_id", userId)
            .in("workshop_id", candidateWsIds)
        : { data: [] as Array<{ workshop_id: string; status: string }> };
      const finalSubStates = new Set([
        "entregado",
        "calificado",
        "ai_revisado",
        "requiere_revision",
      ]);
      const submittedWsIds = new Set(
        ((doneWsSubs ?? []) as Array<{ workshop_id: string; status: string }>)
          .filter((s) => finalSubStates.has(s.status))
          .map((s) => s.workshop_id),
      );
      const ws = candidateWs
        .filter((w: any) => !submittedWsIds.has(w.id))
        .sort(
          (a: any, b: any) =>
            new Date(a.due_date ?? "9999").getTime() - new Date(b.due_date ?? "9999").getTime(),
        )
        .slice(0, 8);
      setPendingWorkshops(ws);

      // Cursos matriculados (necesarios para proyectos + próximas clases)
      const dbAny = supabase as any;
      const { data: enr } = await dbAny
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", userId);
      const enrolledCourseIds = ((enr ?? []) as { course_id: string }[]).map((r) => r.course_id);

      // Pending projects (vía cursos matriculados + asignaciones explícitas)
      const { data: linked } = enrolledCourseIds.length
        ? await dbAny
            .from("project_courses")
            .select("project_id")
            .in("course_id", enrolledCourseIds)
        : { data: [] as { project_id: string }[] };
      const { data: pasg } = await dbAny
        .from("project_assignments")
        .select("project_id")
        .eq("user_id", userId);
      const projectIds = Array.from(
        new Set([
          ...((linked ?? []) as { project_id: string }[]).map((r) => r.project_id),
          ...((pasg ?? []) as { project_id: string }[]).map((r) => r.project_id),
        ]),
      );
      const { data: pjData } = projectIds.length
        ? await dbAny
            .from("projects")
            .select("id, title, due_date, status, start_date, course:courses(name)")
            .in("id", projectIds)
            .eq("status", "published")
        : { data: [] as any[] };
      const { data: pSubs } = projectIds.length
        ? await dbAny
            .from("project_submissions")
            .select("project_id, status")
            .eq("user_id", userId)
            .in("project_id", projectIds)
        : { data: [] as any[] };
      const submittedIds = new Set(
        ((pSubs ?? []) as { project_id: string; status: string }[])
          .filter((s) => ["entregado", "calificado", "ai_revisado"].includes(s.status))
          .map((s) => s.project_id),
      );
      // Mismo criterio que workshops: published + start_date pasado
      // + due_date futuro (o sin due_date) + no entregado por el alumno.
      const pjs = ((pjData ?? []) as any[])
        .filter(
          (p) =>
            !submittedIds.has(p.id) &&
            (!p.start_date || new Date(p.start_date) <= new Date()) &&
            (!p.due_date || new Date(p.due_date) >= new Date()),
        )
        .sort(
          (a: any, b: any) =>
            new Date(a.due_date ?? "9999").getTime() - new Date(b.due_date ?? "9999").getTime(),
        )
        .slice(0, 8);
      setPendingProjects(pjs);

      // Métricas tipo "docente": mensajes sin responder + sesiones hoy.
      // El RPC count_unanswered_conversations es simétrico — filtra por
      // auth.uid(), funciona igual para docente que para estudiante.
      // Las sesiones de hoy las contamos limitando a cursos donde estoy
      // matriculado (RLS de attendance_sessions es abierta, filtramos en
      // cliente para no traer todo el campus).
      const [unansweredRes, todaySess] = await Promise.all([
        dbAny.rpc("count_unanswered_conversations"),
        enrolledCourseIds.length
          ? dbAny
              .from("attendance_sessions")
              .select("id", { count: "exact", head: true })
              .eq("session_date", todayStr)
              .in("course_id", enrolledCourseIds)
          : Promise.resolve({ count: 0 }),
      ]);
      const unansweredCount = typeof unansweredRes.data === "number" ? unansweredRes.data : 0;
      setCounts({
        unansweredMessages: unansweredCount,
        todaySessions: todaySess.count ?? 0,
      });

      // Próximas clases — top 8 sesiones >= hoy en mis cursos, ordenadas
      // por fecha y hora. Si no estoy matriculado en nada queda vacío.
      const { data: sess } = enrolledCourseIds.length
        ? await dbAny
            .from("attendance_sessions")
            .select("id, title, session_date, start_time, course_id, course:courses(name)")
            .gte("session_date", todayStr)
            .in("course_id", enrolledCourseIds)
            .order("session_date", { ascending: true })
            .order("start_time", { ascending: true, nullsFirst: false })
            .limit(8)
        : { data: [] as any[] };
      setUpcomingSessions(sess ?? []);
    })();
  }, [userId]);

  return (
    // Mismo wrapper que TeacherDashboard: flex-col + flex-1 + min-h-0
    // permite que la grid de 4 cards se estire hasta llenar el viewport
    // disponible. Cada card scrollea internamente su lista cuando hay
    // muchos items, sin empujar el botón "Ver todo" fuera de pantalla.
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat
          icon={FileText}
          label={t("dashboard.stats.pendingExams")}
          value={upcomingExams.length}
          color="text-violet-500 dark:text-violet-400"
        />
        <Stat
          icon={Hammer}
          label={t("dashboard.stats.pendingWorkshops")}
          value={pendingWorkshops.length}
          color="text-amber-500 dark:text-amber-400"
        />
        <Stat
          icon={FolderKanban}
          label={t("dashboard.stats.pendingProjects")}
          value={pendingProjects.length}
          color="text-rose-500 dark:text-rose-400"
        />
        {/* Mensajes pendientes sin responder — mismo RPC que el docente.
            Click abre /app/messages para ir directo a la bandeja. */}
        <Stat
          icon={Inbox}
          label={t("dashboard.stats.unansweredMessages", {
            defaultValue: "Mensajes pendientes sin responder",
          })}
          value={counts.unansweredMessages}
          color="text-amber-500 dark:text-amber-400"
          onClick={() => void navigate({ to: "/app/messages" })}
        />
        {/* Sesiones de asistencia HOY en mis cursos matriculados.
            Click → módulo de asistencia del estudiante. */}
        <Stat
          icon={CalendarClock}
          label={t("dashboard.stats.todaySessions", {
            defaultValue: "Sesiones hoy",
          })}
          value={counts.todaySessions}
          color="text-blue-500 dark:text-blue-400"
          onClick={() => void navigate({ to: "/app/student/attendance" })}
        />
      </div>

      {/* Grid de 4 cards con flex-1 + min-h-0 — mismo patrón del docente.
          El orden replica el del docente: clases / proyectos / exámenes /
          talleres. Eso unifica la lectura visual entre los dos roles. */}
      <div className="grid md:grid-cols-4 gap-4 flex-1 min-h-0">
        {/* Próximas clases — reemplaza el bloque "Acceso rápido" porque
            es más accionable: el alumno ve a simple vista qué sesiones
            tiene programadas sin tener que abrir el módulo de asistencia. */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-cyan-500 dark:text-cyan-300" />{" "}
              {t("dashboard.upcomingClasses", { defaultValue: "Próximas clases" })}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {upcomingSessions.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noUpcomingClasses", {
                    defaultValue: "No tienes sesiones próximas programadas.",
                  })}
                </p>
              ) : (
                upcomingSessions.map((s: any) => {
                  const dateLabel = formatDate(s.session_date);
                  const timeLabel = s.start_time ? ` · ${s.start_time.slice(0, 5)}` : "";
                  return (
                    <EventRow
                      key={s.id}
                      title={s.title ?? t("dashboard.untitledSession", { defaultValue: "Clase" })}
                      subtitle={s.course?.name}
                      date={`${dateLabel}${timeLabel}`}
                    />
                  );
                })
              )}
            </div>
            <Link to="/app/student/attendance" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("common.seeAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Pending projects */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-rose-500 dark:text-rose-400" />{" "}
              {t("dashboard.pendingDeliveryProjects")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {pendingProjects.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noPendingProjects")}
                </p>
              ) : (
                pendingProjects.map((p: any) => {
                  const isOverdue = p.due_date && new Date(p.due_date) < new Date();
                  return (
                    <Link key={p.id} to="/app/student/projects" className="block">
                      <div className="flex items-start gap-2 p-2.5 rounded-md border hover:border-primary/40 transition-colors cursor-pointer">
                        <div className="mt-0.5">
                          {isOverdue ? (
                            <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                          ) : (
                            <Send className="h-3.5 w-3.5 text-rose-500 dark:text-rose-400" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{p.title}</div>
                          <div className="text-xs text-muted-foreground">{p.course?.name}</div>
                          {p.due_date && (
                            <div className="text-xs text-muted-foreground mt-0.5">
                              {t("dashboard.dueLabel")}: {formatDate(p.due_date)}
                            </div>
                          )}
                        </div>
                        {isOverdue && (
                          <Badge variant="destructive" className="text-[10px] shrink-0">
                            {t("dashboard.overdue")}
                          </Badge>
                        )}
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
            <Link to="/app/student/projects" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("common.seeAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Upcoming exams */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-violet-500 dark:text-violet-400" />{" "}
              {t("dashboard.upcomingExams")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {upcomingExams.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noStudentUpcomingExams")}
                </p>
              ) : (
                upcomingExams.map((e: any) => {
                  const isOpen =
                    new Date() >= new Date(e.start_time) && new Date() <= new Date(e.end_time);
                  return (
                    <Link
                      key={e.id}
                      to="/app/student/take/$examId"
                      params={{ examId: e.id }}
                      className="block"
                    >
                      <div className="flex items-start gap-2 p-2.5 rounded-md border hover:border-primary/40 transition-colors cursor-pointer">
                        <div className="mt-0.5">
                          {isOpen ? (
                            <Play className="h-3.5 w-3.5 text-success" />
                          ) : (
                            <Clock className="h-3.5 w-3.5 text-muted-foreground/50" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate">{e.title}</div>
                          <div className="text-xs text-muted-foreground">
                            {e.course?.name} · {e.time_limit_minutes} {t("common.min")}
                          </div>
                        </div>
                        {isOpen && (
                          <Badge className="bg-success text-success-foreground text-[10px] shrink-0">
                            {t("dashboard.start")}
                          </Badge>
                        )}
                      </div>
                    </Link>
                  );
                })
              )}
            </div>
            <Link to="/app/student/exams" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("common.seeAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Pending workshops */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" />{" "}
              {t("dashboard.pendingDeliveryWorkshops")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {pendingWorkshops.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("dashboard.noPendingWorkshops")}
                </p>
              ) : (
                pendingWorkshops.map((w: any) => {
                  const isOverdue = w.due_date && new Date(w.due_date) < new Date();
                  return (
                    <div key={w.id} className="flex items-start gap-2 p-2.5 rounded-md border">
                      <div className="mt-0.5">
                        {isOverdue ? (
                          <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                        ) : (
                          <Send className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">{w.title}</div>
                        <div className="text-xs text-muted-foreground">{w.course?.name}</div>
                        {w.due_date && (
                          <div className="text-xs text-muted-foreground mt-0.5">
                            {t("dashboard.dueLabel")}: {formatDate(w.due_date)}
                          </div>
                        )}
                      </div>
                      {isOverdue && (
                        <Badge variant="destructive" className="text-[10px] shrink-0">
                          {t("dashboard.overdue")}
                        </Badge>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <Link to="/app/student/workshops" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("common.seeAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHARED COMPONENTS
   ═══════════════════════════════════════════════════════════ */

function Stat({
  icon: Icon,
  label,
  value,
  color = "text-primary",
  onClick,
}: {
  icon: any;
  label: string;
  value: number;
  color?: string;
  onClick?: () => void;
}) {
  const interactive = !!onClick;
  return (
    <Card
      onClick={onClick}
      className={
        interactive
          ? "cursor-pointer hover:border-primary/40 hover:shadow-sm transition-all"
          : undefined
      }
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
          </div>
          <div
            className={`h-9 w-9 rounded-lg bg-muted/50 flex items-center justify-center ${color}`}
          >
            <Icon className="h-4.5 w-4.5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function QuickCard({
  to,
  title,
  desc,
  icon: Icon,
  color = "bg-primary/10 text-primary",
}: {
  to: string;
  title: string;
  desc: string;
  icon: any;
  color?: string;
}) {
  // Cards compactos: padding y tamaño de ícono reducidos para que en
  // la columna angosta del dashboard (1/4 del ancho en md+) las
  // tarjetas no se vean abultadas. La descripción se trunca a 1 línea
  // con `line-clamp-1` — antes "Define entregables y asigna a cursos"
  // se partía a 2 líneas y desbalanceaba el grid.
  return (
    <Link to={to} className="block">
      <Card className="hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer">
        <CardContent className="p-3 flex items-center gap-2.5">
          <div className={`h-8 w-8 rounded-md flex items-center justify-center shrink-0 ${color}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium leading-tight">{title}</div>
            <div className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{desc}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function EventRow({
  title,
  subtitle,
  date,
  badge,
  badgeColor = "bg-primary text-primary-foreground",
}: {
  title: string;
  subtitle?: string;
  date: string;
  badge?: string;
  badgeColor?: string;
}) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-md border">
      <div className="mt-0.5">
        <span className="flex h-2 w-2 rounded-full bg-muted-foreground/30" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{title}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        <div className="text-xs text-muted-foreground mt-0.5">{date}</div>
      </div>
      {badge && <Badge className={`text-[10px] shrink-0 ${badgeColor}`}>{badge}</Badge>}
    </div>
  );
}

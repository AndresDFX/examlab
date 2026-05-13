import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { useNotifications } from "@/hooks/use-notifications";
import { formatDate, formatDateTime, formatTime } from "@/lib/format";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { OpenFeedbackModal } from "@/components/OpenFeedbackModal";
import { PendingExamNotesModal } from "@/components/PendingExamNotesModal";
import { pendingResponsesCount } from "@/lib/feedback-stats";
import {
  Users,
  BookOpen,
  FileText,
  ClipboardList,
  GraduationCap,
  Hammer,
  FolderKanban,
  Calendar,
  Clock,
  Bell,
  CheckCircle2,
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
} from "lucide-react";

export const Route = createFileRoute("/app/")({ component: Dashboard });

const DASHBOARD_NOTIF_LIMIT = 5;

function formatNotifDate(
  iso: string,
  t: (key: string, opts?: Record<string, unknown>) => string,
  locale: string,
): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return t("dashboard.notifications.relativeNow");
  if (diffMins < 60) return t("dashboard.notifications.relativeMins", { min: diffMins });
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return t("dashboard.notifications.relativeHours", { hour: diffHours });
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return `${t("dashboard.notifications.relativeYesterday")} ${formatTime(d)}`;
  // Weekday + time: caso muy específico de notificaciones recientes
  // (esta semana). Lo dejamos inline porque ningún otro lugar lo usa.
  if (diffDays < 7)
    return d.toLocaleDateString(locale, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  return formatDateTime(d);
}

function Dashboard() {
  const { profile, user } = useAuth();
  const activeRole = useActiveRole();
  const { notifications, unreadCount, markAsRead } = useNotifications(user?.id, activeRole);
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith("en") ? "en" : "es";

  const isAdmin = activeRole === "Admin";
  const isTeacher = activeRole === "Docente";
  const isStudent = activeRole === "Estudiante";

  // Toast unread on mount
  useEffect(() => {
    if (unreadCount > 0) {
      const recent = notifications.filter((n) => !n.read).slice(0, 3);
      recent.forEach((n) => {
        toast.info(n.title, { description: n.body, duration: 5000 });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recentNotifs = notifications.slice(0, DASHBOARD_NOTIF_LIMIT);

  return (
    <div className="space-y-6">
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

      {/* Notifications — shared across roles */}
      {recentNotifs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Bell className="h-4 w-4 text-primary" />
                {t("dashboard.notifications.title")}
                {unreadCount > 0 && (
                  <Badge className="text-[10px] h-5">
                    {t("dashboard.notifications.unread", { count: unreadCount })}
                  </Badge>
                )}
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {t("dashboard.notifications.lastN", { count: DASHBOARD_NOTIF_LIMIT })}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
              {recentNotifs.map((n) => (
                <button
                  key={n.id}
                  onClick={() => !n.read && markAsRead(n.id)}
                  className={`w-full text-left flex items-start gap-2 p-2.5 rounded-md border transition-colors ${
                    n.read
                      ? "bg-muted/20 hover:bg-muted/30 opacity-70"
                      : "bg-primary/5 hover:bg-primary/10 border-primary/20"
                  }`}
                >
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 rounded-full shrink-0 ${n.read ? "bg-muted-foreground/30" : "bg-primary"}`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <div className="text-sm font-medium truncate">{n.title}</div>
                      <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
                        {formatNotifDate(n.created_at, t, locale)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground line-clamp-1 mt-0.5">{n.body}</p>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
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
    { full_name: string; institutional_email: string; created_at: string }[]
  >([]);

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

      const { data: ru } = await supabase
        .from("profiles")
        .select("full_name, institutional_email, created_at")
        .order("created_at", { ascending: false })
        .limit(5);
      setRecentUsers((ru ?? []) as any);
    })();
  }, []);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat
          icon={Users}
          label={t("dashboard.stats.users")}
          value={counts.users}
          color="text-indigo-500 dark:text-indigo-400"
        />
        <Stat
          icon={BookOpen}
          label={t("dashboard.stats.courses")}
          value={counts.courses}
          color="text-blue-500 dark:text-blue-400"
        />
        <Stat
          icon={FileText}
          label={t("dashboard.stats.exams")}
          value={counts.exams}
          color="text-violet-500 dark:text-violet-400"
        />
        <Stat
          icon={Hammer}
          label={t("dashboard.stats.workshops")}
          value={counts.workshops}
          color="text-amber-500 dark:text-amber-400"
        />
        <Stat
          icon={ClipboardList}
          label={t("dashboard.stats.submissions")}
          value={counts.submissions}
          color="text-emerald-500 dark:text-emerald-400"
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-indigo-500" /> {t("dashboard.recentUsers")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recentUsers.map((u, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded-md border text-sm">
                <div className="h-7 w-7 rounded-full bg-indigo-500/10 flex items-center justify-center text-xs font-medium text-indigo-600 dark:text-indigo-400">
                  {u.full_name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{u.full_name}</div>
                  <div className="text-xs text-muted-foreground truncate">
                    {u.institutional_email}
                  </div>
                </div>
              </div>
            ))}
            <Link to="/app/admin/users" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manageUsers")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            {t("dashboard.administration")}
          </h2>
          <div className="grid grid-cols-2 gap-3">
            <QuickCard
              to="/app/admin/users"
              title={t("dashboard.cards.usersTitle")}
              desc={t("dashboard.cards.usersDesc")}
              icon={Users}
              color="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400"
            />
            <QuickCard
              to="/app/admin/courses"
              title={t("dashboard.cards.coursesTitle")}
              desc={t("dashboard.cards.coursesDescAdmin")}
              icon={BookOpen}
              color="bg-blue-500/10 text-blue-600 dark:text-blue-400"
            />
          </div>
        </div>
      </div>
    </>
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
        (supabase as any)
          .from("feedback_threads")
          .select("id")
          .eq("closed", false),
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
      const unansweredCount =
        typeof unansweredRes.data === "number" ? unansweredRes.data : 0;
      setCounts({
        pendingExamNotes: pendingNotes.count ?? 0,
        unansweredMessages: unansweredCount,
        pendingMyResponse,
        openThreads: openThreadIds.length,
        todaySessions: todaySess.count ?? 0,
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
        .limit(5);
      setUpcomingSessions(sess ?? []);

      const { data: exams } = await supabase
        .from("exams")
        .select("id, title, start_time, end_time, time_limit_minutes, course:courses(name)")
        .gte("end_time", now)
        .order("start_time")
        .limit(4);
      setUpcomingExams(exams ?? []);

      const { data: ws } = await supabase
        .from("workshops")
        .select("id, title, due_date, status, course:courses(name)")
        .eq("status", "published")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(4);
      setActiveWorkshops(ws ?? []);

      const { data: pjs } = await (supabase as any)
        .from("projects")
        .select("id, title, due_date, status, course:courses(name)")
        .eq("status", "published")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(4);
      setActiveProjects(pjs ?? []);
    })();
  }, []);

  return (
    <>
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
        {/* Mensajes pendientes sin responder: conversaciones del módulo
            /app/messages donde el último mensaje no es mío. Click → abre
            /app/messages para que el docente vaya directo a responder. */}
        <Stat
          icon={Inbox}
          label={t("dashboard.stats.unansweredMessages", {
            defaultValue: "Mensajes pendientes sin responder",
          })}
          value={counts.unansweredMessages}
          color="text-amber-500 dark:text-amber-400"
          onClick={() => void navigate({ to: "/app/messages" })}
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
            defaultValue: "Conversaciones abiertas",
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

      <div className="grid md:grid-cols-4 gap-4">
        {/* Próximas clases — sesiones de asistencia con session_date >=
            hoy en los cursos asignados al docente. Reemplaza el bloque
            "Acciones rápidas" porque es más accionable: el docente ve a
            simple vista qué viene en los próximos días sin abrir el
            módulo de asistencia. RLS filtra a sus cursos. */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-cyan-500 dark:text-cyan-300" />{" "}
              {t("dashboard.upcomingClasses", { defaultValue: "Próximas clases" })}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
            <Link to="/app/teacher/attendance" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Active projects */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-rose-500 dark:text-rose-400" />{" "}
              {t("dashboard.activeProjects")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
            <Link to="/app/teacher/projects" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Upcoming exams */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-violet-500 dark:text-violet-400" />{" "}
              {t("dashboard.upcomingExams")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingExams.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">{t("dashboard.noUpcomingExams")}</p>
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
            <Link to="/app/teacher/exams" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Active workshops */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" />{" "}
              {t("dashboard.activeWorkshops")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   STUDENT DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function StudentDashboard({ userId }: { userId: string | undefined }) {
  const { t } = useTranslation();
  const [upcomingExams, setUpcomingExams] = useState<any[]>([]);
  const [pendingWorkshops, setPendingWorkshops] = useState<any[]>([]);
  const [pendingProjects, setPendingProjects] = useState<any[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [courseCount, setCourseCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    (async () => {
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
        .slice(0, 4);
      setUpcomingExams(exams);

      // Assigned workshops
      const { data: wasg } = await supabase
        .from("workshop_assignments")
        .select("workshop:workshops(id, title, due_date, status, course:courses(name))")
        .eq("user_id", userId);
      const ws = (wasg ?? [])
        .map((a: any) => a.workshop)
        .filter(
          (w: any) =>
            w &&
            w.status === "published" &&
            (!w.start_date || new Date(w.start_date) <= new Date()),
        )
        .sort(
          (a: any, b: any) =>
            new Date(a.due_date ?? "9999").getTime() - new Date(b.due_date ?? "9999").getTime(),
        )
        .slice(0, 4);
      setPendingWorkshops(ws);

      // Pending projects (vía cursos matriculados + asignaciones explícitas)
      const dbAny = supabase as any;
      const { data: enr } = await dbAny
        .from("course_enrollments")
        .select("course_id")
        .eq("user_id", userId);
      const enrolledCourseIds = ((enr ?? []) as { course_id: string }[]).map((r) => r.course_id);
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
      const pjs = ((pjData ?? []) as any[])
        .filter(
          (p) => !submittedIds.has(p.id) && (!p.start_date || new Date(p.start_date) <= new Date()),
        )
        .sort(
          (a: any, b: any) =>
            new Date(a.due_date ?? "9999").getTime() - new Date(b.due_date ?? "9999").getTime(),
        )
        .slice(0, 4);
      setPendingProjects(pjs);

      // Completed submissions
      const { count } = await supabase
        .from("submissions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("status", "completado");
      setCompletedCount(count ?? 0);

      // Enrolled courses
      const { count: cc } = await supabase
        .from("course_enrollments")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId);
      setCourseCount(cc ?? 0);
    })();
  }, [userId]);

  return (
    <>
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
        <Stat
          icon={CheckCircle2}
          label={t("dashboard.stats.completed")}
          value={completedCount}
          color="text-emerald-500 dark:text-emerald-400"
        />
        <Stat
          icon={BookOpen}
          label={t("dashboard.stats.courses")}
          value={courseCount}
          color="text-blue-500 dark:text-blue-400"
        />
      </div>

      <div className="grid md:grid-cols-4 gap-4">
        {/* Upcoming exams */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-violet-500 dark:text-violet-400" />{" "}
              {t("dashboard.upcomingExams")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
            <Link to="/app/student/exams" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("common.seeAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Pending workshops */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" />{" "}
              {t("dashboard.pendingDeliveryWorkshops")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
            <Link to="/app/student/workshops" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("common.seeAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* Pending projects */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <FolderKanban className="h-4 w-4 text-rose-500 dark:text-rose-400" />{" "}
              {t("dashboard.pendingDeliveryProjects")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
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
            <Link to="/app/student/projects" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("common.seeAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">{t("common.quickAccess")}</h2>
          <div className="space-y-2.5">
            <QuickCard
              to="/app/student/exams"
              title={t("dashboard.cards.examsStudent")}
              desc={t("dashboard.cards.examsStudentDesc")}
              icon={GraduationCap}
              color="bg-violet-500/10 text-violet-600 dark:text-violet-400"
            />
            <QuickCard
              to="/app/student/workshops"
              title={t("dashboard.cards.workshopsStudent")}
              desc={t("dashboard.cards.workshopsStudentDesc")}
              icon={Hammer}
              color="bg-amber-500/10 text-amber-600 dark:text-amber-400"
            />
            <QuickCard
              to="/app/student/projects"
              title={t("dashboard.cards.projectsStudent")}
              desc={t("dashboard.cards.projectsStudentDesc")}
              icon={FolderKanban}
              color="bg-rose-500/10 text-rose-600 dark:text-rose-400"
            />
            <QuickCard
              to="/app/student/courses"
              title={t("dashboard.cards.coursesStudent")}
              desc={t("dashboard.cards.coursesStudentDesc")}
              icon={BookOpen}
              color="bg-blue-500/10 text-blue-600 dark:text-blue-400"
            />
          </div>
        </div>
      </div>
    </>
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

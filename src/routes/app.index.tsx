import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { useNotifications } from "@/hooks/use-notifications";
import { formatDate, formatDateOnly, formatDateTime } from "@/shared/lib/format";
import { sessionIsUpcoming } from "@/shared/lib/session-time";
import { consumeBootLastRoute } from "@/shared/lib/last-route";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { OpenFeedbackModal } from "@/modules/grading/OpenFeedbackModal";
import { PendingExamNotesModal } from "@/modules/exams/PendingExamNotesModal";
import {
  pendingResponsesCount,
  studentPendingResponseCount,
} from "@/modules/grading/feedback-stats";
import { AiGradingQueueWidget } from "@/modules/ai/AiGradingQueueWidget";
import { StudentEventsCalendar } from "@/modules/dashboard/StudentEventsCalendar";
import {
  FileText,
  Hammer,
  FolderKanban,
  Calendar,
  Clock,
  AlertTriangle,
  ArrowRight,
  Play,
  Send,
  MessageSquareText,
  Reply,
  Inbox,
  CalendarClock,
  Bot,
  CircleCheck,
  Search,
  ListOrdered,
  RefreshCw,
  Building2,
  Users as UsersIcon,
  BookOpen,
  ShieldCheck,
  Trophy,
  ClipboardCheck,
  Stethoscope,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CourseDiagnosticDialog } from "@/modules/courses/CourseDiagnosticDialog";
import { aggregatePendingGradingByCourse, type PendingGradingCourse } from "@/modules/courses/pending-grading";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useKahootCourseLeaderboard } from "@/modules/polls/use-kahoot-course-leaderboard";

/** Formato relativo simple ("ahora", "5m", "2h", "1d"). Duplicado del
 *  helper en AiGradingQueueWidget para no acoplar 2 rutas sobre un
 *  concepto puramente UI. */
function relativeAge(iso: string): string {
  const diffMin = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (diffMin < 1) return i18n.t("hc_routesAppIndex.relativeNow");
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.floor(diffH / 24)}d`;
}

export const Route = createFileRoute("/app/")({ component: Dashboard });

function Dashboard() {
  const { profile, user } = useAuth();
  const activeRole = useActiveRole();
  // useNotifications acá solo alimenta el toast de bienvenida con
  // no-leídas; el bell del header global (NotificationBell) es la
  // superficie persistente.
  const { notifications, unreadCount } = useNotifications(user?.id, activeRole);
  const { t } = useTranslation();

  const isAdmin = activeRole === "Admin";
  const isTeacher = activeRole === "Docente";
  const isStudent = activeRole === "Estudiante";
  const isSuperAdmin = activeRole === "SuperAdmin";

  // "Déjame donde estaba": si la app abrió en el dashboard pero hay una última
  // ruta guardada (reopen de PWA / post-login / recarga en /app), saltamos a
  // ella UNA sola vez por carga (consumeBootLastRoute es one-shot + gateado a
  // boot en /app, así que el botón Inicio NO la dispara). window.location
  // porque la ruta puede tener segmentos dinámicos que navigate({to}) tipado
  // no resuelve desde un string concreto.
  useEffect(() => {
    const last = consumeBootLastRoute();
    if (last) window.location.replace(last);
  }, []);

  // Toast de bienvenida con los no leídos: se dispara UNA vez tras la PRIMERA
  // carga (useNotifications resuelve async → con deps [] el efecto corría con
  // notifications=[] y nunca mostraba nada). El ref evita que polling/realtime
  // lo re-disparen.
  const welcomeShownRef = useRef(false);
  useEffect(() => {
    if (welcomeShownRef.current || unreadCount === 0) return;
    welcomeShownRef.current = true;
    notifications
      .filter((n) => !n.read)
      .slice(0, 3)
      .forEach((n) => {
        toast.info(n.title, { description: n.body, duration: 5000 });
      });
  }, [unreadCount, notifications]);

  return (
    // Layout flex-col. En desktop (lg+) CAPEAMOS la altura al viewport
    // (descontado el padding del AppLayout) + overflow-hidden → el dashboard
    // NUNCA hace scroll de PÁGINA: los cards y el calendario scrollean
    // internamente (flex-1 + min-h-0 + overflow-y-auto). En <lg (mobile/
    // tablet) dejamos altura natural + scroll, que es lo esperado en pantallas
    // chicas con layout apilado. Aplica a los 4 roles (wrapper compartido).
    // gap-4 (no 6) para ganar espacio vertical y que entre sin recortar.
    <div className="flex flex-col gap-4 lg:h-[calc(100dvh-5rem)] lg:overflow-hidden">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          {t("dashboard.hello")}, {profile?.full_name ?? "👋"}
        </h1>
        <p className="text-muted-foreground">
          {isSuperAdmin
            ? t("dashboard.greetingSuperAdmin")
            : isAdmin
              ? t("dashboard.greetingAdmin")
              : isTeacher
                ? t("dashboard.greetingTeacher")
                : t("dashboard.greetingStudent")}
        </p>
      </div>

      {isSuperAdmin && <SuperAdminDashboard />}
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
  const { profile } = useAuth();
  // tenant_id del Admin actual — necesario para filtrar EXPLÍCITAMENTE
  // los counts de submissions/workshop_submissions/project_submissions,
  // que NO tienen columna tenant_id propia y dependen de la cadena
  // submissions → exam/workshop/project → courses.tenant_id. La RLS
  // de esas tablas no siempre limita cross-tenant (Admin con rol global
  // o leak de policy), así que acotamos en el cliente como
  // defense-in-depth. Sin esto un tenant nuevo veía counts de OTROS
  // tenants en el card "Por calificar".
  const adminTenantId = profile?.tenant_id ?? null;
  // ── Stat cards superiores: métricas INSTITUCIONALES ──
  // Antes eran 4 métricas IA (errores 24h, respuestas IA, plagio, pendientes
  // docentes). Reemplazadas por métricas de negocio del Admin: cursos
  // activos, usuarios matriculados, items pendientes de calificar, y
  // pendientes docentes (única que sobrevivió — la más accionable de las
  // originales). Las métricas IA siguen visibles para el Admin desde el
  // card "Cola IA" abajo + /app/admin/audit-logs.
  const [adminStats, setAdminStats] = useState({
    coursesActive: 0,
    usersTotal: 0,
    pendingGrading: 0,
    pendingTeacherResponses: 0,
  });
  // ── Cards inferiores: 4 en grid, contenido admin-céntrico ──
  // Antes mostraban "Próximos exámenes" / "Próximas clases" que se
  // sentían como vista de Docente. Reemplazados por "Cursos recientes"
  // + "Actividad reciente" (audit_logs del tenant) — más alineado al rol
  // Admin que ya tiene métricas de carga y operación, no agenda
  // pedagógica.
  const [recentCourses, setRecentCourses] = useState<
    Array<{ id: string; name: string; period: string | null; created_at: string }>
  >([]);
  const [recentEvents, setRecentEvents] = useState<
    Array<{
      id: string;
      action: string;
      category: string;
      severity: string;
      actor_email: string | null;
      entity_name: string | null;
      created_at: string;
    }>
  >([]);
  // ── Diagnóstico de TODOS los cursos del tenant (espeja el modal
  // "Pendientes de calificación" del Docente, pero sobre el set de
  // cursos del tenant, no sólo los del docente). El Admin abre el modal
  // desde la stat "Por calificar", elige un curso y se abre el
  // CourseDiagnosticDialog (reusado, ya soporta Admin/SuperAdmin).
  const [allCoursesModalOpen, setAllCoursesModalOpen] = useState(false);
  const [diagCourse, setDiagCourse] = useState<{ id: string; name: string } | null>(null);
  // Lista de cursos del tenant con su conteo de pendientes (count 0
  // incluido, para poder diagnosticar CUALQUIER curso). Ordenada por
  // count desc, luego nombre.
  const [coursesDiagnostic, setCoursesDiagnostic] = useState<PendingGradingCourse[]>([]);

  useEffect(() => {
    // Guard contra navegación rápida: si el admin sale del dashboard
    // antes de que la query resuelva (~500ms en cold cache), el setState
    // disparaba warning "set state on unmounted component" y un toast
    // huérfano en pantalla nueva. `cancelled` corta el flow.
    let cancelled = false;
    (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;

      // Paso 1: resolver IDs del tenant del admin para acotar
      // explícitamente los counts de submissions. RLS debería hacerlo
      // pero un tenant nuevo veía counts de otros (51 cuando debería
      // ser 0). Defense-in-depth a nivel client.
      let examIds: string[] = [];
      let workshopIds: string[] = [];
      let projectIds: string[] = [];
      // Cursos vivos del tenant (id+name) — usados tanto para acotar los
      // counts de submissions como para listar los cursos en el modal de
      // diagnóstico. Atribución actividad→curso y conteo por curso reusan
      // este mismo set.
      let tenantCourseList: { id: string; name: string }[] = [];
      let tenantCourseIds: string[] = [];
      if (adminTenantId) {
        const { data: courseRows } = await dbAny
          .from("courses")
          .select("id, name")
          .eq("tenant_id", adminTenantId)
          // Excluir cursos en PAPELERA: sus exámenes/talleres/proyectos NO
          // deben contar como "por calificar" (regla universal soft-delete).
          // Bug: el curso "Pruebas" (soft-deleted) inflaba el conteo con 2
          // entregas de prueba aunque el detalle por curso mostraba 0.
          .is("deleted_at", null);
        if (cancelled) return;
        tenantCourseList = ((courseRows ?? []) as Array<{ id: string; name: string }>).map((r) => ({
          id: r.id,
          name: r.name,
        }));
        const courseIds = tenantCourseList.map((r) => r.id);
        tenantCourseIds = courseIds;
        if (courseIds.length > 0) {
          const [examsRes, workshopsRes, projectsRes] = await Promise.all([
            dbAny.from("exams").select("id").in("course_id", courseIds).is("deleted_at", null),
            dbAny.from("workshops").select("id").in("course_id", courseIds).is("deleted_at", null),
            dbAny.from("projects").select("id").in("course_id", courseIds).is("deleted_at", null),
          ]);
          if (cancelled) return;
          examIds = ((examsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
          workshopIds = ((workshopsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
          projectIds = ((projectsRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
        }
      }
      // Si no hay items del tenant, los counts son 0 sin pegarle a la DB
      // (un `.in("col", [])` en PostgREST devuelve TODOS los rows, NO
      // ninguno — el bug que causaba el leak de "51" cross-tenant).
      const hasExams = examIds.length > 0;
      const hasWorkshops = workshopIds.length > 0;
      const hasProjects = projectIds.length > 0;

      // Métricas institucionales (RLS + filtro explícito por tenant en
      // submissions). Plus listas para los cards inferiores
      // admin-céntricos: cursos recientes y eventos recientes.
      const [
        coursesRes,
        usersRes,
        examPendingRes,
        workshopPendingRes,
        projectPendingRes,
        openThreadsRes,
        recentCoursesRes,
        recentEventsRes,
      ] = await Promise.all([
        // courses: RLS filtra al tenant del Admin (la tabla SÍ tiene tenant_id).
        // Excluye cursos en papelera (deleted_at) — la stat "Cursos" cuenta
        // sólo cursos vigentes, igual que el grid de Cursos.
        dbAny.from("courses").select("id", { count: "exact", head: true }).is("deleted_at", null),
        // profiles: misma idea.
        dbAny.from("profiles").select("id", { count: "exact", head: true }),
        // submissions (exámenes): status `en_progreso|completado|sospechoso`,
        // SIN columna `final_grade` — usamos `ai_grade IS NULL` para
        // detectar "pendiente de calificar IA". El filtro por
        // `exam_id IN (...)` acota al tenant.
        hasExams
          ? dbAny
              .from("submissions")
              .select("id", { count: "exact", head: true })
              .in("status", ["completado", "sospechoso"])
              .is("ai_grade", null)
              // "Calificado" = CUALQUIER nota persistida. Un examen calificado
              // MANUALMENTE por el docente tiene `ai_grade=null` pero
              // `final_override_grade` seteado → NO es pendiente. Sin este
              // filtro, los exámenes con override contaban como "por calificar"
              // (bug Camacho: 35 ya calificados a mano se contaban). Espeja el
              // `has_final_grade = ai_grade || final_override_grade` del diagnóstico.
              .is("final_override_grade", null)
              .in("exam_id", examIds)
          : Promise.resolve({ count: 0 }),
        hasWorkshops
          ? dbAny
              .from("workshop_submissions")
              .select("id", { count: "exact", head: true })
              .eq("status", "entregado")
              .is("final_grade", null)
              // Idem: graded = final_grade || ai_grade (diagnóstico). Excluye
              // los ya calificados por IA sin override.
              .is("ai_grade", null)
              .in("workshop_id", workshopIds)
          : Promise.resolve({ count: 0 }),
        hasProjects
          ? dbAny
              .from("project_submissions")
              .select("id", { count: "exact", head: true })
              .eq("status", "entregado")
              .is("final_grade", null)
              // Sólo "por calificar" REAL: excluye las ya calificadas por IA que
              // esperan SUSTENTACIÓN (submission_grade ya seteado → la nota base
              // existe, falta el factor de sustentación, no la calificación) y
              // las ya calificadas por IA (ai_grade seteado).
              .is("submission_grade", null)
              .is("ai_grade", null)
              .in("project_id", projectIds)
          : Promise.resolve({ count: 0 }),
        // Threads abiertos a nivel plataforma (Admin RLS = sin filtro).
        // Los usamos para calcular cuántos esperan respuesta de un docente.
        dbAny.from("feedback_threads").select("id").eq("closed", false),
        // Cursos recientes (institución), max 8. Excluye papelera.
        dbAny
          .from("courses")
          .select("id, name, period, created_at")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(8),
        // Eventos recientes (audit_logs del tenant, max 8). RLS los
        // filtra al tenant del Admin.
        dbAny
          .from("audit_logs")
          .select("id, action, category, severity, actor_email, entity_name, created_at")
          .order("created_at", { ascending: false })
          .limit(8),
      ]);
      if (cancelled) return;

      // Cálculo de pendientes docentes: para cada thread abierto, mirar
      // el último comentario; si no es de rol 'teacher', cuenta. Reutiliza
      // `pendingResponsesCount` (mismo helper que el TeacherDashboard).
      const openThreadIds: string[] = ((openThreadsRes.data ?? []) as Array<{ id: string }>).map(
        (r) => r.id,
      );
      let pendingTeacherResponses = 0;
      if (openThreadIds.length > 0) {
        const { data: cmts } = await dbAny
          .from("feedback_comments")
          .select("thread_id, author_role, created_at")
          .in("thread_id", openThreadIds);
        if (cancelled) return;
        pendingTeacherResponses = pendingResponsesCount(
          openThreadIds,
          (cmts ?? []) as Array<{
            thread_id: string;
            author_role: string | null;
            created_at: string;
          }>,
        );
      }

      setAdminStats({
        coursesActive: coursesRes.count ?? 0,
        usersTotal: usersRes.count ?? 0,
        pendingGrading:
          (examPendingRes.count ?? 0) +
          (workshopPendingRes.count ?? 0) +
          (projectPendingRes.count ?? 0),
        pendingTeacherResponses,
      });
      setRecentCourses((recentCoursesRes.data ?? []) as typeof recentCourses);
      setRecentEvents((recentEventsRes.data ?? []) as typeof recentEvents);

      // ── Pendientes de calificación POR CURSO del tenant ──
      // Espeja la agregación del TeacherDashboard, pero sobre el SET DE
      // CURSOS DEL TENANT (no course_teachers). Mismas reglas de filtrado
      // que la stat "Por calificar" arriba + atribución actividad→curso +
      // filtro por matrícula vigente (igual que el diagnóstico). El modal
      // lista TODOS los cursos del tenant (count 0 incluido) para poder
      // diagnosticar cualquiera, no sólo los que tienen pendientes.
      if (tenantCourseIds.length === 0) {
        if (!cancelled) setCoursesDiagnostic([]);
      } else {
        // Actividad → curso (única). Exámenes: course_id directo.
        // Talleres/proyectos M:N: primer curso del tenant que los enlaza.
        const activityToCourse = new Map<string, string>();
        const [exRows, wcRows, pcRows] = await Promise.all([
          dbAny
            .from("exams")
            .select("id, course_id")
            .in("course_id", tenantCourseIds)
            .is("deleted_at", null)
            .is("parent_exam_id", null),
          dbAny
            .from("workshop_courses")
            .select("workshop_id, course_id")
            .in("course_id", tenantCourseIds),
          dbAny
            .from("project_courses")
            .select("project_id, course_id")
            .in("course_id", tenantCourseIds),
        ]);
        if (cancelled) return;
        for (const e of (exRows.data ?? []) as Array<{ id: string; course_id: string }>)
          activityToCourse.set(e.id, e.course_id);
        for (const r of (wcRows.data ?? []) as Array<{ workshop_id: string; course_id: string }>)
          if (!activityToCourse.has(r.workshop_id)) activityToCourse.set(r.workshop_id, r.course_id);
        for (const r of (pcRows.data ?? []) as Array<{ project_id: string; course_id: string }>)
          if (!activityToCourse.has(r.project_id)) activityToCourse.set(r.project_id, r.course_id);

        const diagExamIds = ((exRows.data ?? []) as Array<{ id: string }>).map((e) => e.id);
        const diagWorkshopIds = [
          ...new Set(((wcRows.data ?? []) as Array<{ workshop_id: string }>).map((r) => r.workshop_id)),
        ];
        const diagProjectIds = [
          ...new Set(((pcRows.data ?? []) as Array<{ project_id: string }>).map((r) => r.project_id)),
        ];

        const [exSub, wsSub, prjSub, enrRows] = await Promise.all([
          diagExamIds.length
            ? dbAny
                .from("submissions")
                .select("exam_id, user_id")
                .in("status", ["completado", "sospechoso"])
                .is("ai_grade", null)
                .is("final_override_grade", null)
                .in("exam_id", diagExamIds)
            : Promise.resolve({ data: [] }),
          diagWorkshopIds.length
            ? dbAny
                .from("workshop_submissions")
                .select("workshop_id, user_id")
                .eq("status", "entregado")
                .is("final_grade", null)
                .is("ai_grade", null)
                .in("workshop_id", diagWorkshopIds)
            : Promise.resolve({ data: [] }),
          diagProjectIds.length
            ? dbAny
                .from("project_submissions")
                .select("project_id, user_id")
                .eq("status", "entregado")
                .is("final_grade", null)
                .is("submission_grade", null)
                .is("ai_grade", null)
                .in("project_id", diagProjectIds)
            : Promise.resolve({ data: [] }),
          dbAny
            .from("course_enrollments")
            .select("course_id, user_id")
            .in("course_id", tenantCourseIds),
        ]);
        if (cancelled) return;
        // Set de matriculados por curso — no contar entregas de estudiantes
        // que ya NO están en el curso (entrega huérfana). Coincide con el
        // diagnóstico, que itera sólo sobre matriculados.
        const enrolledByCourse = new Map<string, Set<string>>();
        for (const e of (enrRows.data ?? []) as Array<{ course_id: string; user_id: string }>) {
          const set = enrolledByCourse.get(e.course_id) ?? new Set<string>();
          set.add(e.user_id);
          enrolledByCourse.set(e.course_id, set);
        }
        const isEnrolled = (activityId: string, uid: string): boolean => {
          const cid = activityToCourse.get(activityId);
          return cid ? (enrolledByCourse.get(cid)?.has(uid) ?? false) : false;
        };
        const pendingActivityIds: string[] = [];
        for (const s of (exSub.data ?? []) as Array<{ exam_id: string; user_id: string }>)
          if (isEnrolled(s.exam_id, s.user_id)) pendingActivityIds.push(s.exam_id);
        for (const s of (wsSub.data ?? []) as Array<{ workshop_id: string; user_id: string }>)
          if (isEnrolled(s.workshop_id, s.user_id)) pendingActivityIds.push(s.workshop_id);
        for (const s of (prjSub.data ?? []) as Array<{ project_id: string; user_id: string }>)
          if (isEnrolled(s.project_id, s.user_id)) pendingActivityIds.push(s.project_id);

        const agg = aggregatePendingGradingByCourse(
          tenantCourseList,
          activityToCourse,
          pendingActivityIds,
        );
        // Fusionar con la lista completa de cursos del tenant para incluir
        // también los que NO tienen pendientes (count 0) — el modal es de
        // DIAGNÓSTICO de cualquier curso, no sólo de los pendientes.
        // aggregatePendingGradingByCourse omite los count<=0, así que los
        // agregamos acá. Orden: count desc, luego nombre (es-CO).
        const countById = new Map(agg.byCourse.map((c) => [c.courseId, c.count]));
        const merged: PendingGradingCourse[] = tenantCourseList.map((c) => ({
          courseId: c.id,
          courseName: c.name,
          count: countById.get(c.id) ?? 0,
        }));
        merged.sort(
          (a, b) => b.count - a.count || a.courseName.localeCompare(b.courseName, "es-CO"),
        );
        if (!cancelled) setCoursesDiagnostic(merged);
      }
    })();
    return () => {
      cancelled = true;
    };
    // adminTenantId en deps para re-fetch cuando el profile cargue
    // (en el primer render del dashboard puede venir null mientras
    // useAuth termina de hidratar) y para re-fetch si el SuperAdmin
    // cambia de override de tenant.
  }, [adminTenantId]);

  return (
    // Wrapper flex-col + flex-1 + min-h-0 — espeja el patrón del
    // TeacherDashboard: stats compactos arriba, cards accionables abajo
    // ocupando el alto restante del viewport. Errores se consultan
    // ahora desde /app/admin/audit-logs con filtro severity=error.
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      {/* Row PRIMARIA — 4 stat cards INSTITUCIONALES. Antes eran 4
          métricas operativas IA (errores, respuestas, plagio,
          pendientes docentes). Cambio 2026-05-26: las 3 primeras
          movidas a la Cola IA + auditoría; arriba quedan métricas de
          negocio del Admin (cursos, usuarios, items pendientes,
          pendientes docentes). Mismo grid (2-col mobile, 4-col md+)
          y mismo componente <Stat> que Teacher/Student/SuperAdmin. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={BookOpen}
          label={t("dashboard.stats.courses")}
          value={adminStats.coursesActive}
          color="text-fuchsia-500 dark:text-fuchsia-400"
        />
        <Stat
          icon={UsersIcon}
          label={t("dashboard.stats.users")}
          value={adminStats.usersTotal}
          color="text-indigo-500 dark:text-indigo-400"
        />
        <Stat
          icon={ListOrdered}
          label={t("dashboard.stats.pendingGrades")}
          value={adminStats.pendingGrading}
          color={
            adminStats.pendingGrading > 0
              ? "text-amber-500 dark:text-amber-400"
              : "text-emerald-500 dark:text-emerald-400"
          }
          // Click → modal con TODOS los cursos del tenant; cada uno abre su
          // Diagnóstico (espeja el flujo del Docente).
          onClick={() => setAllCoursesModalOpen(true)}
        />
        <Stat
          icon={Reply}
          label={t("dashboard.stats.pendingTeacherResponses")}
          value={adminStats.pendingTeacherResponses}
          color="text-rose-500 dark:text-rose-400"
        />
      </div>

      {/* 2 cards abajo que ocupan el alto restante. Antes eran 4
          (Cursos recientes, Actividad reciente, Cola IA, Correos);
          la salud operativa de Cola IA y Correos se ve en sus módulos
          dedicados — el dashboard prioriza la vista institucional
          accionable. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* (1) Cursos recientes — últimos 8 del tenant. RLS los acota. */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <BookOpen className="h-4 w-4 text-fuchsia-500 dark:text-fuchsia-400" />
              {t("hc_routesAppIndex.recentCourses")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
              {recentCourses.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">{t("hc_routesAppIndex.noCoursesYet")}</p>
              ) : (
                recentCourses.map((c) => (
                  <EventRow
                    key={c.id}
                    title={c.name}
                    subtitle={c.period ?? undefined}
                    date={formatDate(c.created_at)}
                  />
                ))
              )}
            </div>
            <Link to="/app/admin/courses" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("hc_routesAppIndex.viewAll")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>

        {/* (2) Actividad reciente — eventos recientes del audit_log
            scopado al tenant del Admin vía RLS. */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <CircleCheck className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
              {t("hc_routesAppIndex.recentActivity")}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto min-h-0 pr-1">
              {recentEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("hc_routesAppIndex.noEventsYet")}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {recentEvents.map((ev) => {
                    const sevDot =
                      ev.severity === "error"
                        ? "bg-rose-500"
                        : ev.severity === "warning"
                          ? "bg-amber-500"
                          : "bg-emerald-500";
                    return (
                      <li key={ev.id} className="flex items-start gap-2 rounded-md border p-2">
                        <span
                          className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${sevDot}`}
                          aria-hidden
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate" title={ev.action}>
                            {ev.action}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate">
                            {ev.actor_email ?? t("hc_routesAppIndex.system")}
                            {ev.entity_name ? ` · ${ev.entity_name}` : ""} ·{" "}
                            {relativeAge(ev.created_at)}
                          </div>
                        </div>
                        <Badge variant="outline" className="text-[10px] shrink-0">
                          {ev.category}
                        </Badge>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <Link to="/app/admin/audit-logs" className="block">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                {t("dashboard.viewAudit")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Diagnóstico de cursos del tenant — detalle por curso. Espeja el
          modal "Pendientes de calificación" del Docente, pero lista TODOS
          los cursos del tenant (no sólo los del docente). Cada curso abre
          su Diagnóstico (CourseDiagnosticDialog, que ya soporta Admin/SA). */}
      <Dialog open={allCoursesModalOpen} onOpenChange={setAllCoursesModalOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Stethoscope className="h-5 w-5 text-emerald-600" />
              {t("dashboard.adminDiagnostic.title", {
                defaultValue: "Diagnóstico de cursos",
              })}
            </DialogTitle>
          </DialogHeader>
          {coursesDiagnostic.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {t("dashboard.adminDiagnostic.empty", {
                defaultValue: "No hay cursos en esta institución todavía.",
              })}
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {t("dashboard.adminDiagnostic.openHint", {
                  defaultValue:
                    "Elige un curso para ver su diagnóstico completo (pendientes, errores IA, conversaciones, asistencia).",
                })}
              </p>
              <div className="divide-y max-h-[60dvh] overflow-y-auto">
                {coursesDiagnostic.map((c) => (
                  <button
                    key={c.courseId}
                    type="button"
                    onClick={() => {
                      setAllCoursesModalOpen(false);
                      setDiagCourse({ id: c.courseId, name: c.courseName });
                    }}
                    className="w-full flex items-center justify-between gap-3 px-2 py-2.5 text-left hover:bg-muted/50 rounded-md"
                  >
                    <span className="text-sm font-medium truncate">{c.courseName}</span>
                    <span className="flex items-center gap-2 shrink-0">
                      {c.count > 0 && (
                        <Badge variant="destructive" className="text-[10px] tabular-nums">
                          {c.count}
                        </Badge>
                      )}
                      <Stethoscope className="h-4 w-4 text-emerald-600" />
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {diagCourse && (
        <CourseDiagnosticDialog
          open={!!diagCourse}
          onOpenChange={(o) => {
            if (!o) setDiagCourse(null);
          }}
          courseId={diagCourse.id}
          courseName={diagCourse.name}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   TEACHER DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function TeacherDashboard({ userId }: { userId: string | undefined }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // Pendientes de calificación cross-curso (reemplaza "Sesiones hoy").
  const [pendingGradingTotal, setPendingGradingTotal] = useState(0);
  const [pendingByCourse, setPendingByCourse] = useState<PendingGradingCourse[]>([]);
  const [pendingGradingModalOpen, setPendingGradingModalOpen] = useState(false);
  // Curso para el que se abre el Diagnóstico desde el modal (reusa el dialog
  // existente, que tiene "Calificar todos con IA").
  const [diagCourse, setDiagCourse] = useState<{ id: string; name: string } | null>(null);
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
    /** Jobs pendientes en `ai_grading_queue` visibles para este docente
     *  (RLS filtra a sus cursos). Sustituye al antiguo "Errores IA (1h)"
     *  porque, post-refactor, los errores ahora se ven dentro del módulo
     *  Cron → tab IA (con filtro `failed`) y la métrica accionable en el
     *  dashboard es "cuánto trabajo IA tengo pendiente". */
    aiPendingJobs: 0,
  });
  const [upcomingExams, setUpcomingExams] = useState<any[]>([]);
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
    // Guard contra navegación rápida (mismo razonamiento que el effect
    // del AdminDashboard arriba).
    let cancelled = false;
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
          .eq("session_date", todayStr)
          .is("deleted_at", null),
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
      // Cuenta de jobs pendientes en la cola IA visible para el docente.
      // RLS filtra automáticamente: el docente ve los jobs de sus cursos.
      // Reemplaza al antiguo "errores IA (1h)" — los errores quedan en
      // el módulo Cron → tab IA con su filtro `failed`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count: pendingAiCount } = await (supabase as any)
        .from("ai_grading_queue")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending");
      if (cancelled) return;
      setCounts({
        pendingExamNotes: pendingNotes.count ?? 0,
        unansweredMessages: unansweredCount,
        pendingMyResponse,
        openThreads: openThreadIds.length,
        todaySessions: todaySess.count ?? 0,
        aiPendingJobs: pendingAiCount ?? 0,
      });

      // Pendientes de calificación POR CURSO (cross-curso). Mismas reglas que
      // el dashboard Admin: examen (completado/sospechoso + ai_grade null),
      // taller/proyecto (entregado + final_grade null). Atribuimos cada
      // entrega a un curso del docente (examen: course_id directo; taller/
      // proyecto M:N: primer curso del docente que lo enlaza).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny2 = supabase as any;
      if (userId) {
        const { data: ctRows } = await dbAny2
          .from("course_teachers")
          .select("course_id")
          .eq("user_id", userId);
        const myCourseIds: string[] = ((ctRows ?? []) as any[]).map((r) => r.course_id);
        if (!cancelled && myCourseIds.length) {
          const { data: myCourses } = await dbAny2
            .from("courses")
            .select("id, name")
            .in("id", myCourseIds)
            .is("deleted_at", null);
          const courseList = ((myCourses ?? []) as any[]).map((c) => ({ id: c.id, name: c.name }));
          const liveCourseIds = courseList.map((c) => c.id);

          // Actividad → curso (única). Exámenes: course_id directo.
          const activityToCourse = new Map<string, string>();
          const [exRows, wcRows, pcRows] = await Promise.all([
            liveCourseIds.length
              ? dbAny2
                  .from("exams")
                  .select("id, course_id")
                  .in("course_id", liveCourseIds)
                  .is("deleted_at", null)
                  .is("parent_exam_id", null)
              : Promise.resolve({ data: [] }),
            liveCourseIds.length
              ? dbAny2
                  .from("workshop_courses")
                  .select("workshop_id, course_id")
                  .in("course_id", liveCourseIds)
              : Promise.resolve({ data: [] }),
            liveCourseIds.length
              ? dbAny2
                  .from("project_courses")
                  .select("project_id, course_id")
                  .in("course_id", liveCourseIds)
              : Promise.resolve({ data: [] }),
          ]);
          for (const e of (exRows.data ?? []) as any[]) activityToCourse.set(e.id, e.course_id);
          // M:N: primer curso del docente que enlaza el taller/proyecto.
          for (const r of (wcRows.data ?? []) as any[])
            if (!activityToCourse.has(r.workshop_id)) activityToCourse.set(r.workshop_id, r.course_id);
          for (const r of (pcRows.data ?? []) as any[])
            if (!activityToCourse.has(r.project_id)) activityToCourse.set(r.project_id, r.course_id);

          const examIds = (exRows.data ?? []).map((e: any) => e.id);
          const workshopIds = [...new Set(((wcRows.data ?? []) as any[]).map((r) => r.workshop_id))];
          const projectIds = [...new Set(((pcRows.data ?? []) as any[]).map((r) => r.project_id))];

          const [exSub, wsSub, prjSub, enrRows] = await Promise.all([
            examIds.length
              ? dbAny2
                  .from("submissions")
                  .select("exam_id, user_id")
                  .in("status", ["completado", "sospechoso"])
                  .is("ai_grade", null)
                  // Excluye exámenes calificados MANUALMENTE (override del
                  // docente) — graded = ai_grade || final_override_grade, igual
                  // que el diagnóstico. Sin esto el stat docente mostraba 35
                  // mientras el detalle por curso (diagnóstico) mostraba 0.
                  .is("final_override_grade", null)
                  .in("exam_id", examIds)
              : Promise.resolve({ data: [] }),
            workshopIds.length
              ? dbAny2
                  .from("workshop_submissions")
                  .select("workshop_id, user_id")
                  .eq("status", "entregado")
                  .is("final_grade", null)
                  .is("ai_grade", null)
                  .in("workshop_id", workshopIds)
              : Promise.resolve({ data: [] }),
            projectIds.length
              ? dbAny2
                  .from("project_submissions")
                  .select("project_id, user_id")
                  .eq("status", "entregado")
                  .is("final_grade", null)
                  // Excluye las ya calificadas por IA que esperan sustentación
                  // (submission_grade seteado) y las ya calificadas por IA
                  // (ai_grade) — no son "por calificar".
                  .is("submission_grade", null)
                  .is("ai_grade", null)
                  .in("project_id", projectIds)
              : Promise.resolve({ data: [] }),
            // Matrícula vigente por curso — para NO contar entregas de
            // estudiantes que ya NO están en el curso (su entrega quedó
            // huérfana). Así el conteo coincide con el diagnóstico, que
            // itera sólo sobre matriculados.
            liveCourseIds.length
              ? dbAny2
                  .from("course_enrollments")
                  .select("course_id, user_id")
                  .in("course_id", liveCourseIds)
              : Promise.resolve({ data: [] }),
          ]);
          // Set de matriculados por curso.
          const enrolledByCourse = new Map<string, Set<string>>();
          for (const e of (enrRows.data ?? []) as any[]) {
            const set = enrolledByCourse.get(e.course_id) ?? new Set<string>();
            set.add(e.user_id);
            enrolledByCourse.set(e.course_id, set);
          }
          const isEnrolled = (activityId: string, uid: string): boolean => {
            const cid = activityToCourse.get(activityId);
            return cid ? (enrolledByCourse.get(cid)?.has(uid) ?? false) : false;
          };
          const pendingActivityIds: string[] = [];
          for (const s of (exSub.data ?? []) as any[])
            if (isEnrolled(s.exam_id, s.user_id)) pendingActivityIds.push(s.exam_id);
          for (const s of (wsSub.data ?? []) as any[])
            if (isEnrolled(s.workshop_id, s.user_id)) pendingActivityIds.push(s.workshop_id);
          for (const s of (prjSub.data ?? []) as any[])
            if (isEnrolled(s.project_id, s.user_id)) pendingActivityIds.push(s.project_id);
          const agg = aggregatePendingGradingByCourse(courseList, activityToCourse, pendingActivityIds);
          if (!cancelled) {
            setPendingGradingTotal(agg.total);
            setPendingByCourse(agg.byCourse);
          }
        } else if (!cancelled) {
          setPendingGradingTotal(0);
          setPendingByCourse([]);
        }
      }

      // Próximas clases: attendance_sessions del docente con
      // session_date >= hoy, ordenadas por fecha y hora. RLS recorta
      // a sus cursos.
      const { data: sess } = await (supabase as any)
        .from("attendance_sessions")
        .select("id, title, session_date, start_time, duration_minutes, course_id, course:courses(name)")
        .gte("session_date", todayStr)
        .is("deleted_at", null)
        .order("session_date", { ascending: true })
        .order("start_time", { ascending: true, nullsFirst: false })
        // Traemos un margen amplio (no 8) porque el corte fino "ya terminó
        // hoy" se hace en JS abajo: session_date es DATE, así que el filtro
        // server-side no puede descartar por hora. Sin margen, podríamos
        // quedarnos cortos tras descartar las pasadas de hoy.
        .limit(40);
      // "Próximas" = fecha+HORA actual, no solo fecha: descartamos las
      // sesiones de HOY cuyo fin (session_date + start_time + duración) ya
      // pasó, y recién entonces tomamos las 8 primeras.
      const nowMs = Date.now();
      setUpcomingSessions(((sess ?? []) as any[]).filter((s) => sessionIsUpcoming(s, nowMs)).slice(0, 8));

      // Próximos exámenes: solo published (consistente con workshops/
      // projects). Los borradores no aparecen en el widget — el docente
      // los ve en la lista completa de exámenes.
      const { data: exams } = await (supabase as any)
        .from("exams")
        .select("id, title, start_time, end_time, time_limit_minutes, status, course:courses(name)")
        .eq("status", "published")
        .gte("end_time", now)
        .is("deleted_at", null)
        .order("start_time")
        .limit(8);
      if (cancelled) return;
      setUpcomingExams(exams ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    // Wrapper flex-col + flex-1 para que la fila de 4 cards de abajo
    // pueda crecer hasta llenar la altura disponible del viewport
    // cuando NO hay tarjeta de notificaciones bajo el dashboard. Si las
    // notificaciones aparecen, esta sección cede el espacio
    // automáticamente (cada card scrollea internamente). min-h-0
    // permite el shrinking dentro del padre flex.
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          icon={FileText}
          label={t("dashboard.stats.pendingExamNotes", {
            defaultValue: "Notas de examen pendientes",
          })}
          value={counts.pendingExamNotes}
          color="text-violet-500 dark:text-violet-400"
          onClick={() => setPendingNotesModalOpen(true)}
        />
        {/* Cola IA — jobs pendientes en la cola IA visible para el
            docente (sus cursos vía RLS). Métrica accionable: cuántas
            calificaciones IA tengo encoladas esperando turno. Click →
            módulo Cola → tab IA para verlas y, si es urgente, procesar
            o activar la ventana sincrónica con un código override. */}
        <Stat
          icon={ListOrdered}
          label={t("hc_routesAppIndex.queuePending")}
          value={counts.aiPendingJobs}
          color="text-indigo-500 dark:text-indigo-400"
          onClick={() => void navigate({ to: "/app/teacher/ai-cron" })}
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
        {/* Pendientes de calificación cross-curso (reemplaza "Sesiones hoy").
            Entregas entregadas sin nota final, sumadas sobre TODOS mis
            cursos. Click → modal con el detalle por curso; desde cada curso
            se abre el Diagnóstico (que tiene "Calificar todos con IA"). */}
        <Stat
          icon={ClipboardCheck}
          label={t("dashboard.stats.pendingGrading", {
            defaultValue: "Pendientes de calificación",
          })}
          value={pendingGradingTotal}
          color="text-blue-500 dark:text-blue-400"
          onClick={() => setPendingGradingModalOpen(true)}
        />
      </div>

      {/* Cron IA + IA inmediata se trasladaron al módulo Cron → tab IA.
          El stat "Cron IA (pendientes)" de arriba reemplaza el glance
          que daba el AiGradingQueueWidget; click en él lleva al módulo
          completo donde el docente activa también el código override
          si necesita IA sincrónica YA. */}

      {/* 2 cards abajo que ocupan el alto restante del viewport. Antes
          eran 4; talleres y proyectos activos se ven en sus módulos
          dedicados — el dashboard prioriza lo time-critical (clases +
          exámenes). */}
      {/* Calendario (izq) + agenda de 2 cards (der) — MISMO layout que el
          dashboard del estudiante. El calendario muestra los eventos de
          TODOS los cursos que dicta el docente + los cierres de corte
          (mode="teacher"). */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
        <div className="min-h-0 flex">
          <StudentEventsCalendar
            userId={userId}
            mode="teacher"
            className="h-full w-full flex flex-col min-h-0"
          />
        </div>

        {/* Próximas clases + Próximos exámenes apilados a la derecha. */}
        <div className="flex flex-col gap-4 min-h-0">
        {/* Próximas clases */}
        <Card className="flex flex-col min-h-0 lg:flex-1">
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
                  // session_date es DATE (YYYY-MM-DD sin TZ): formatDateOnly ancla a
                  // mediodía local para evitar el corrimiento UTC -1 día.
                  const dateLabel = formatDateOnly(s.session_date);
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

        {/* Próximos exámenes */}
        <Card className="flex flex-col min-h-0 lg:flex-1">
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
        </div>
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

      {/* Pendientes de calificación — detalle por curso. Cada curso abre su
          Diagnóstico (que incluye "Calificar todos con IA"). */}
      <Dialog open={pendingGradingModalOpen} onOpenChange={setPendingGradingModalOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-blue-600" />
              {t("dashboard.pendingGradingModal.title", {
                defaultValue: "Pendientes de calificación por curso",
              })}
            </DialogTitle>
          </DialogHeader>
          {pendingByCourse.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              {t("dashboard.pendingGradingModal.empty", {
                defaultValue: "No tienes entregas pendientes de calificación. ✨",
              })}
            </p>
          ) : (
            <div className="divide-y max-h-[60dvh] overflow-y-auto">
              {pendingByCourse.map((c) => (
                <button
                  key={c.courseId}
                  type="button"
                  onClick={() => {
                    setPendingGradingModalOpen(false);
                    setDiagCourse({ id: c.courseId, name: c.courseName });
                  }}
                  className="w-full flex items-center justify-between gap-3 px-2 py-2.5 text-left hover:bg-muted/50 rounded-md"
                >
                  <span className="text-sm font-medium truncate">{c.courseName}</span>
                  <span className="flex items-center gap-2 shrink-0">
                    <Badge variant="destructive" className="text-[10px] tabular-nums">
                      {c.count}
                    </Badge>
                    <Stethoscope className="h-4 w-4 text-emerald-600" />
                  </span>
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {diagCourse && (
        <CourseDiagnosticDialog
          open={!!diagCourse}
          onOpenChange={(o) => {
            if (!o) setDiagCourse(null);
          }}
          courseId={diagCourse.id}
          courseName={diagCourse.name}
        />
      )}
    </div>
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
  /** Cursos matriculados (id + nombre) para el ranking Kahoot acumulado que
   *  reemplaza las cards de "Próximas clases" / "Próximos exámenes". */
  const [enrolledCourses, setEnrolledCourses] = useState<{ id: string; name: string }[]>([]);
  /** Modal "Conversaciones pendientes" — abre OpenFeedbackModal con
   *  filterMode='studentNeedsResponse'. */
  const [pendingResponseModalOpen, setPendingResponseModalOpen] = useState(false);
  const [counts, setCounts] = useState({
    /** Conversaciones pendientes: feedback_threads abiertos cuyo
     *  último comentario es del docente (la pelota está en mi cancha).
     *  Inversa del card del docente. */
    pendingMyResponse: 0,
  });

  useEffect(() => {
    if (!userId) return;
    // Guard contra navegación rápida (mismo razonamiento que los
    // dashboards Admin/Teacher arriba).
    let cancelled = false;
    (async () => {
      // Assigned exams — solo published. Draft (sin publicar) y closed
      // (cerrado manualmente por el docente) no aparecen en el dashboard
      // del estudiante. Mismo criterio que workshops/projects.
      const { data: asg } = await supabase
        .from("exam_assignments")
        .select(
          "exam:exams(id, title, start_time, end_time, time_limit_minutes, status, deleted_at, course:courses(name))",
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
        .filter(
          (e: any) =>
            e &&
            !e.deleted_at &&
            (e.status ?? "published") === "published" &&
            new Date(e.end_time) > new Date() &&
            !doneExamIds.has(e.id),
        )
        .sort(
          (a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
        )
        // Subido a 8 para alinear con el dashboard del docente (las
        // cards crecen vertical y muestran más items útiles).
        .slice(0, 8);
      if (cancelled) return;
      setUpcomingExams(exams);

      // Assigned workshops — "por entregar" = published + open
      // (due_date >= hoy) + el alumno aún no entregó. Antes incluíamos
      // talleres ya cerrados y ya entregados, lo que inflaba el count
      // y confundía al alumno.
      const { data: wasg } = await supabase
        .from("workshop_assignments")
        .select("workshop:workshops(id, title, due_date, status, start_date, deleted_at, course:courses(name))")
        .eq("user_id", userId);
      const todayISO = new Date().toISOString();
      const candidateWs = (wasg ?? [])
        .map((a: any) => a.workshop)
        .filter(
          (w: any) =>
            w &&
            !w.deleted_at &&
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
      if (cancelled) return;
      setPendingWorkshops(ws);

      // Cursos matriculados (necesarios para proyectos + próximas clases)
      const dbAny = supabase as any;
      const { data: enr } = await dbAny
        .from("course_enrollments")
        .select("course_id, course:courses(id, name, deleted_at)")
        .eq("user_id", userId);
      // Papelera: saltar cursos soft-deleted del selector de ranking y del set
      // de ids que alimenta la búsqueda de proyectos pendientes.
      const enrolledCoursesList = ((enr ?? []) as any[])
        .map((r) => r.course)
        .filter((c: any) => c && c.id && c.name && !c.deleted_at) as { id: string; name: string }[];
      if (!cancelled) setEnrolledCourses(enrolledCoursesList);
      const enrolledCourseIds = enrolledCoursesList.map((c) => c.id);

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
            .is("deleted_at", null)
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
      if (cancelled) return;
      setPendingProjects(pjs);

      // Conversaciones pendientes — feedback_threads abiertos del
      // estudiante donde el ÚLTIMO comentario es de un docente (la pelota
      // está en mi cancha). RLS solo me trae mis threads.
      const { data: openThreadsRes } = await dbAny
        .from("feedback_threads")
        .select("id")
        .eq("closed", false);
      const openThreadIds: string[] = ((openThreadsRes ?? []) as Array<{ id: string }>).map(
        (r) => r.id,
      );
      let pendingMyResponse = 0;
      if (openThreadIds.length > 0) {
        const { data: cmts } = await dbAny
          .from("feedback_comments")
          .select("thread_id, author_role, created_at")
          .in("thread_id", openThreadIds);
        pendingMyResponse = studentPendingResponseCount(
          openThreadIds,
          (cmts ?? []) as Array<{
            thread_id: string;
            author_role: string | null;
            created_at: string;
          }>,
        );
      }
      if (cancelled) return;
      setCounts({ pendingMyResponse });
      // (Las "Próximas clases" del estudiante se removieron del dashboard: la
      // columna derecha ahora muestra el ranking acumulado de Kahoot por curso,
      // que se carga en el componente StudentKahootRanking vía RPC + realtime.)
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    // Mismo wrapper que TeacherDashboard: flex-col + flex-1 + min-h-0
    // permite que la grid de 4 cards se estire hasta llenar el viewport
    // disponible. Cada card scrollea internamente su lista cuando hay
    // muchos items, sin empujar el botón "Ver todo" fuera de pantalla.
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
        {/* Conversaciones pendientes — threads abiertos del estudiante
            donde el último comment fue del docente (estoy pendiente de
            responder). Inversa del card del docente. Click → abre el
            modal de OpenFeedbackModal con filterMode=needsMyResponse. */}
        <Stat
          icon={Reply}
          label={t("dashboard.stats.conversationsPending", {
            defaultValue: "Conversaciones pendientes",
          })}
          value={counts.pendingMyResponse}
          color="text-sky-500 dark:text-sky-400"
          onClick={() => setPendingResponseModalOpen(true)}
        />
      </div>

      {/* Calendario (izq) + agenda de 2 cards (der) lado a lado en
          desktop. Antes el calendario de eventos iba como bloque aparte
          ENTRE los stats y los 2 cards, lo que empujaba la agenda fuera
          del viewport y forzaba scroll de página. Ahora comparte la
          región flex-1 con la agenda → todo cabe en UNA pantalla en
          desktop sin scroll. En mobile (<lg) se apilan y el scroll
          natural es esperado. La agenda (clases + exámenes) prioriza lo
          time-critical; los contadores siguen arriba como stats. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* Calendario de eventos (dots por tipo: Examen / Taller /
            Proyecto / Clase / Inicio-Fin de curso). overflow-y-auto: en
            pantallas muy bajas el mes scrollea DENTRO de su columna, sin
            empujar el scroll de la página. */}
        <div className="min-h-0 flex">
          <StudentEventsCalendar userId={userId} className="h-full w-full flex flex-col min-h-0" />
        </div>

        {/* Columna derecha: 2 cards apiladas. ANTES eran dos rankings Kahoot
            idénticos (slot 0 y 1) — el usuario reportó la duplicación. Ahora:
            (1) "Próximos exámenes" (lista accionable, complementa el conteo del
            stat y los dots del calendario) y (2) UN ranking Kahoot (gamificación).
            Sin cards repetidas. */}
        <div className="flex flex-col gap-4 min-h-0">
          {/* Próximos exámenes — usa upcomingExams ya cargado arriba. */}
          <Card className="flex flex-col min-h-0 lg:flex-1">
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
              <Link to="/app/student/exams" className="block">
                <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                  {t("dashboard.viewAll", { defaultValue: "Ver todos" })}{" "}
                  <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            </CardContent>
          </Card>

          {/* Ranking ACUMULADO de Kahoot por curso (gamificación). El alumno
              elige entre sus cursos y ve en vivo quién va punteando (1º-4º). */}
          <StudentKahootRanking courses={enrolledCourses} userId={userId} slot={0} />
        </div>
      </div>

      {/* Modal "Conversaciones pendientes" — abre desde el stat tile.
          Reutiliza OpenFeedbackModal con filterMode='studentNeedsResponse'
          que filtra a threads donde el último comment es del docente. */}
      <OpenFeedbackModal
        open={pendingResponseModalOpen}
        onOpenChange={setPendingResponseModalOpen}
        filterMode="studentNeedsResponse"
      />
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
  sub,
  color = "text-primary",
  onClick,
}: {
  // `icon` opcional: sin ícono el card queda solo con label + valor + sub.
  // SuperAdmin dashboard pidió esa variante para no recargar visualmente
  // los 4 tiles superiores (los otros dashboards mantienen sus íconos).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: any;
  label: string;
  value: number | string;
  /** Línea secundaria debajo del valor (ej. "todas activas", "8 de 24").
   *  Opcional — solo se muestra si se pasa. */
  sub?: string;
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
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground line-clamp-2 leading-tight">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
            {sub && (
              <div className="text-[10px] text-muted-foreground/70 mt-0.5 truncate">{sub}</div>
            )}
          </div>
          {Icon && (
            <div
              className={`h-9 w-9 rounded-lg bg-muted/50 flex items-center justify-center shrink-0 ${color}`}
            >
              <Icon className="h-4.5 w-4.5" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * StudentKahootRanking — card del dashboard del estudiante con el ranking
 * ACUMULADO de Kahoot por curso (en vivo). Reemplaza las cards de "Próximas
 * clases" / "Próximos exámenes" manteniendo el layout (2 cards apiladas). El
 * alumno elige entre sus cursos matriculados; `slot` define el curso default
 * (0 → primero, 1 → segundo si hay). Tenant-safe vía kahoot_course_leaderboard.
 */
function StudentKahootRanking({
  courses,
  userId,
  slot,
}: {
  courses: { id: string; name: string }[];
  userId: string | undefined;
  slot: number;
}) {
  const { t } = useTranslation();
  const [courseId, setCourseId] = useState<string | null>(null);
  useEffect(() => {
    if (courses.length === 0) {
      setCourseId(null);
      return;
    }
    setCourseId((prev) => prev ?? courses[Math.min(slot, courses.length - 1)]?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses]);
  const { rows, loading } = useKahootCourseLeaderboard(courseId, 4);
  const medal = ["text-amber-500", "text-slate-400", "text-orange-500"];

  return (
    <Card className="flex flex-col min-h-0 lg:flex-1">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <Trophy className="h-4 w-4 text-amber-500" />
          {t("dashboard.kahootRanking", { defaultValue: "Ranking de retos" })}
        </CardTitle>
        {courses.length > 0 && (
          <Select value={courseId ?? undefined} onValueChange={setCourseId}>
            <SelectTrigger className="h-8 text-xs mt-1">
              <SelectValue placeholder={t("dashboard.kahootSelectCourse", { defaultValue: "Elige un curso" })} />
            </SelectTrigger>
            <SelectContent>
              {courses.map((c) => (
                <SelectItem key={c.id} value={c.id} className="text-xs">
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
        <div className="flex-1 overflow-y-auto space-y-2 min-h-0 pr-1">
          {courses.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              {t("dashboard.kahootNoCourses", { defaultValue: "No estás matriculado en cursos." })}
            </p>
          ) : loading ? (
            <p className="text-sm text-muted-foreground py-2">{t("common.loading")}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              {t("dashboard.kahootNoGames", {
                defaultValue: "Aún no hay puntajes de retos en este curso.",
              })}
            </p>
          ) : (
            rows.map((r) => {
              const isMe = r.user_id === userId;
              return (
                <div
                  key={r.user_id}
                  className={`flex items-center gap-3 p-2.5 rounded-md border ${isMe ? "border-primary/50 bg-primary/5" : ""}`}
                >
                  <span
                    className={`w-7 text-center font-black tabular-nums ${medal[r.rank - 1] ?? "text-muted-foreground"}`}
                  >
                    {r.rank}º
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      {r.full_name}
                      {isMe && (
                        <span className="ml-1 text-xs text-primary">({t("common.you", { defaultValue: "Tú" })})</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {r.games_played} {t("dashboard.kahootGames", { defaultValue: "juegos" })}
                    </div>
                  </div>
                  <span className="font-bold tabular-nums">{r.total_score}</span>
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
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

/* ═══════════════════════════════════════════════════════════
   SUPERADMIN DASHBOARD
   ═══════════════════════════════════════════════════════════ */

/**
 * SuperAdminDashboard — vista global de la plataforma para el dueño.
 *
 * SuperAdmin = dueño de la plataforma (vos). Ve métricas agregadas
 * cross-tenant para entender salud / volumen de uso. NO duplica el
 * dashboard de Admin (al activeRole=Admin se ve ese); este es el
 * "tablero del dueño" con stats que solo importan a nivel plataforma:
 *   - # de instituciones activas
 *   - # de usuarios totales
 *   - # de cursos activos
 *   - # de jobs IA pendientes (cross-tenant)
 *   - # de tenants nuevos en los últimos 30 días
 *
 * Plus: lista de las últimas N instituciones creadas con quick access
 * a "Ver como" o a editar.
 */
function SuperAdminDashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    tenantsActive: 0,
    tenantsInactive: 0,
    usersTotal: 0,
    coursesTotal: 0,
    aiJobsPending: 0,
    aiJobsFailed: 0,
    newTenants30d: 0,
    errors24h: 0,
    submissionsToday: 0,
  });
  // Instituciones con su uso real (usuarios + cursos). Ordenadas por
  // # de usuarios desc — el SuperAdmin ve de un vistazo cuáles
  // instituciones están activas y cuáles vacías, más útil que un orden
  // por fecha de creación.
  const [tenantStats, setTenantStats] = useState<
    Array<{
      id: string;
      slug: string;
      name: string;
      is_active: boolean;
      userCount: number;
      courseCount: number;
    }>
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dbAny = supabase as any;
      const now = Date.now();
      const since30Ms = now - 30 * 24 * 60 * 60 * 1000;
      const since24hIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const sinceTodayIso = todayStart.toISOString();

      const [
        tenantsRes,
        profilesRes,
        coursesRes,
        aiPendingRes,
        aiFailedRes,
        errors24hRes,
        subExamRes,
        subWsRes,
        subProjRes,
      ] = await Promise.all([
        // Tenants completos: derivamos active/inactive/new30d/uso en memoria
        // (1 query en vez de 4 counts separados).
        // Excluye tenants en papelera (deleted_at IS NOT NULL) para que
        // no inflen los conteos del dashboard SuperAdmin (mig 20260818000000).
        dbAny
          .from("tenants")
          .select("id, slug, name, is_active, created_at")
          .is("deleted_at", null),
        // tenant_id de cada profile → total + conteo por institución.
        dbAny.from("profiles").select("tenant_id"),
        // tenant_id de cada curso → total + conteo por institución.
        // Excluye cursos en papelera (deleted_at IS NOT NULL) para que no
        // inflen coursesTotal ni el courseCount por institución (regla papelera).
        dbAny.from("courses").select("tenant_id").is("deleted_at", null),
        dbAny
          .from("ai_grading_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "pending"),
        dbAny
          .from("ai_grading_queue")
          .select("id", { count: "exact", head: true })
          .eq("status", "failed"),
        dbAny
          .from("audit_logs")
          .select("id", { count: "exact", head: true })
          .eq("severity", "error")
          .gte("created_at", since24hIso),
        dbAny
          .from("submissions")
          .select("id", { count: "exact", head: true })
          .gte("submitted_at", sinceTodayIso),
        dbAny
          .from("workshop_submissions")
          .select("id", { count: "exact", head: true })
          .gte("submitted_at", sinceTodayIso),
        dbAny
          .from("project_submissions")
          .select("id", { count: "exact", head: true })
          .gte("submitted_at", sinceTodayIso),
      ]);
      if (cancelled) return;

      const tenants = (tenantsRes.data ?? []) as Array<{
        id: string;
        slug: string;
        name: string;
        is_active: boolean;
        created_at: string;
      }>;
      const profiles = (profilesRes.data ?? []) as Array<{ tenant_id: string | null }>;
      const courses = (coursesRes.data ?? []) as Array<{ tenant_id: string | null }>;

      // Conteos por institución en memoria.
      const usersByTenant = new Map<string, number>();
      for (const p of profiles) {
        if (p.tenant_id) usersByTenant.set(p.tenant_id, (usersByTenant.get(p.tenant_id) ?? 0) + 1);
      }
      const coursesByTenant = new Map<string, number>();
      for (const c of courses) {
        if (c.tenant_id)
          coursesByTenant.set(c.tenant_id, (coursesByTenant.get(c.tenant_id) ?? 0) + 1);
      }

      const tenantsWithUse = tenants
        .map((t) => ({
          id: t.id,
          slug: t.slug,
          name: t.name,
          is_active: t.is_active,
          userCount: usersByTenant.get(t.id) ?? 0,
          courseCount: coursesByTenant.get(t.id) ?? 0,
        }))
        .sort((a, b) => b.userCount - a.userCount || a.name.localeCompare(b.name));

      setTenantStats(tenantsWithUse);
      setStats({
        tenantsActive: tenants.filter((t) => t.is_active).length,
        tenantsInactive: tenants.filter((t) => !t.is_active).length,
        usersTotal: profiles.length,
        coursesTotal: courses.length,
        aiJobsPending: aiPendingRes.count ?? 0,
        aiJobsFailed: aiFailedRes.count ?? 0,
        newTenants30d: tenants.filter((t) => new Date(t.created_at).getTime() >= since30Ms).length,
        errors24h: errors24hRes.count ?? 0,
        submissionsToday: (subExamRes.count ?? 0) + (subWsRes.count ?? 0) + (subProjRes.count ?? 0),
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-col gap-4 flex-1 min-h-0">
      {/* 4 stats arriba — clickeables (navegan al módulo), igual que en
          los dashboards de Teacher/Student. */}
      {/* SIN íconos: decisión de diseño 2026-05-27 — los 4 cards del
          SuperAdmin van limpios (solo label + valor + sub). Los íconos
          coloridos cargaban visualmente el header del dashboard y se
          sentía inconsistente con la lectura "scan + entendí" del resto.
          El componente <Stat> acepta `icon` opcional; los demás
          dashboards (Admin/Teacher/Student) los mantienen. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat
          label={t("hc_routesAppIndex.institutions")}
          value={loading ? "—" : stats.tenantsActive}
          sub={
            stats.tenantsInactive > 0
              ? t("hc_routesAppIndex.tenantsPaused", { count: stats.tenantsInactive })
              : t("hc_routesAppIndex.allActive")
          }
          onClick={() => void navigate({ to: "/app/superadmin/tenants" })}
        />
        <Stat
          label={t("hc_routesAppIndex.users")}
          value={loading ? "—" : stats.usersTotal}
          sub={t("hc_routesAppIndex.crossTenant")}
          onClick={() => void navigate({ to: "/app/admin/users" })}
        />
        <Stat
          label={t("hc_routesAppIndex.courses")}
          value={loading ? "—" : stats.coursesTotal}
          sub={t("hc_routesAppIndex.crossTenant")}
          onClick={() => void navigate({ to: "/app/admin/courses" })}
        />
        <Stat
          label={t("hc_routesAppIndex.aiQueue")}
          value={loading ? "—" : stats.aiJobsPending}
          sub={
            stats.aiJobsFailed > 0
              ? t("hc_routesAppIndex.aiQueueFailedCount", { count: stats.aiJobsFailed })
              : t("hc_routesAppIndex.noFailed")
          }
          onClick={() => void navigate({ to: "/app/admin/ai-cron" })}
        />
      </div>

      {/* 2 cards abajo que ocupan el alto restante del viewport. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* Instituciones — ordenadas por uso (usuarios), con conteos. */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Building2 className="h-4 w-4 text-violet-500 dark:text-violet-400" />
              {t("hc_routesAppIndex.institutions")}
            </CardTitle>
            <Link to="/app/superadmin/tenants">
              <Button variant="ghost" size="sm" className="h-7 text-xs">
                {t("hc_routesAppIndex.manage")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <div className="flex-1 overflow-y-auto min-h-0 pr-1">
              {loading ? (
                <p className="text-sm text-muted-foreground py-2">{t("hc_routesAppIndex.loading")}</p>
              ) : tenantStats.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  {t("hc_routesAppIndex.noInstitutionsYet")}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {tenantStats.map((tt) => (
                    <li
                      key={tt.id}
                      className="flex items-center justify-between gap-2 rounded-md border p-2.5"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate flex items-center gap-1.5">
                          {tt.name}
                          {!tt.is_active && (
                            <Badge variant="outline" className="text-[10px] shrink-0">
                              {t("hc_routesAppIndex.paused")}
                            </Badge>
                          )}
                        </div>
                        {/* La "URL del tenant" (/t/<slug>) se removió: el slug NO
                            vive en la URL (ver use-tenant.ts) — se resuelve por
                            localStorage. Mostrar esa ruta era engañoso. */}
                      </div>
                      <div className="text-[11px] text-muted-foreground text-right shrink-0 tabular-nums">
                        <div>{t("hc_routesAppIndex.userCount", { count: tt.userCount })}</div>
                        <div>{t("hc_routesAppIndex.courseCount", { count: tt.courseCount })}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {stats.newTenants30d > 0 && !loading && (
              <p className="text-[11px] text-muted-foreground">
                {t("hc_routesAppIndex.newTenants30d", { count: stats.newTenants30d })}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Salud del sistema — métricas operativas de la plataforma. */}
        <Card className="flex flex-col min-h-0">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />
              {t("hc_routesAppIndex.systemHealth")}
            </CardTitle>
            <Link to="/app/admin/audit-logs">
              <Button variant="ghost" size="sm" className="h-7 text-xs">
                {t("hc_routesAppIndex.audit")} <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col gap-2 min-h-0">
            <HealthRow
              icon={AlertTriangle}
              label={t("hc_routesAppIndex.errors24h")}
              value={loading ? "—" : stats.errors24h}
              tone={stats.errors24h > 0 ? "bad" : "good"}
              onClick={() => void navigate({ to: "/app/admin/audit-logs" })}
            />
            <HealthRow
              icon={ListOrdered}
              label={t("hc_routesAppIndex.aiQueueFailed")}
              value={loading ? "—" : stats.aiJobsFailed}
              tone={stats.aiJobsFailed > 0 ? "warn" : "good"}
              onClick={() => void navigate({ to: "/app/admin/ai-cron" })}
            />
            <HealthRow
              icon={ListOrdered}
              label={t("hc_routesAppIndex.aiQueuePendingLabel")}
              value={loading ? "—" : stats.aiJobsPending}
              tone="neutral"
              onClick={() => void navigate({ to: "/app/admin/ai-cron" })}
            />
            <HealthRow
              icon={Send}
              label={t("hc_routesAppIndex.submissionsToday")}
              value={loading ? "—" : stats.submissionsToday}
              tone="neutral"
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Fila de métrica para el card "Salud del sistema" del SuperAdmin.
 *  `tone` colorea el valor según severidad. `onClick` la hace navegable. */
function HealthRow({
  icon: Icon,
  label,
  value,
  tone,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  tone: "good" | "warn" | "bad" | "neutral";
  onClick?: () => void;
}) {
  const valueColor =
    tone === "bad"
      ? "text-rose-500 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-500 dark:text-amber-400"
        : tone === "good"
          ? "text-emerald-500 dark:text-emerald-400"
          : "text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className={`flex items-center justify-between gap-2 rounded-md border p-2.5 text-left w-full ${
        onClick ? "cursor-pointer hover:border-primary/40 transition-colors" : "cursor-default"
      }`}
    >
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        {label}
      </span>
      <span className={`text-lg font-semibold tabular-nums ${valueColor}`}>{value}</span>
    </button>
  );
}

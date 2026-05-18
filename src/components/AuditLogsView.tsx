/**
 * AuditLogsView — vista compartida Admin/Docente del registro de auditoría.
 * mode='admin'   → carga todos los eventos, muestra filtro por curso.
 * mode='teacher' → RLS filtra automáticamente a los cursos del docente.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TableEmpty } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { DateCell } from "@/components/ui/date-cell";
import { useTranslation } from "react-i18next";
import {
  Shield,
  AlertTriangle,
  AlertCircle,
  ShieldAlert,
  Info,
  Search,
  X,
  ChevronDown,
  ChevronRight,
  Download,
} from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { toCSV } from "@/lib/csv";
import { toast } from "sonner";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// ─── Tipos ────────────────────────────────────────────────────────────────────

type AuditLog = {
  id: string;
  created_at: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_role: string | null;
  action: string;
  category: string;
  severity: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_name: string | null;
  course_id: string | null;
  course_name: string | null;
  metadata: Record<string, unknown>;
};

// ─── Catálogos de etiquetas ────────────────────────────────────────────────────

// Mapa completo de `action` → etiqueta humana. Lo agrupamos por
// dominio (CRUD, entregas, IA, fraude, etc.) para que sea fácil revisar
// si falta alguno y editar de un vistazo. Si un evento entra a `audit_logs`
// sin entrada en este mapa, el grid lo muestra con el string crudo
// (`ai.grading_started` en vez de "Calificación IA iniciada") — lo cual
// es perfectamente válido como fallback, pero menos legible.
const ACTION_LABELS: Record<string, string> = {
  // ── Exámenes — CRUD + ciclo de vida ──
  "exam.created": "Examen creado",
  "exam.updated": "Examen actualizado",
  "exam.deleted": "Examen eliminado",
  "exam.bulk_deleted": "Exámenes eliminados (masivo)",
  "exam.published": "Examen publicado",
  "exam.closed": "Examen cerrado",
  "exam.duplicated": "Examen duplicado",

  // ── Talleres — CRUD ──
  "workshop.created": "Taller creado",
  "workshop.updated": "Taller actualizado",
  "workshop.deleted": "Taller eliminado",
  "workshop.bulk_deleted": "Talleres eliminados (masivo)",

  // ── Proyectos — CRUD ──
  "project.created": "Proyecto creado",
  "project.updated": "Proyecto actualizado",
  "project.deleted": "Proyecto eliminado",
  "project.bulk_deleted": "Proyectos eliminados (masivo)",

  // ── Cursos ──
  "course.created": "Curso creado",
  "course.updated": "Curso actualizado",
  "course.deleted": "Curso eliminado",

  // ── Matrículas ──
  "enrollment.added": "Estudiante matriculado",
  "enrollment.removed": "Estudiante desmatriculado",
  "enrollment.bulk_added": "Matriculación masiva",

  // ── Entregas de examen ──
  "submission.exam.started": "Examen iniciado",
  "submission.exam.submitted": "Examen entregado",
  "submission.exam.graded": "Examen calificado",
  "submission.exam.grade_updated": "Nota de examen actualizada",
  "submission.exam.flagged_suspicious": "Examen marcado sospechoso",

  // ── Entregas de taller ──
  "submission.workshop.submitted": "Taller entregado",
  "submission.workshop.graded": "Taller calificado",
  "submission.workshop.updated_in_progress": "Taller editado en progreso",

  // ── Entregas de proyecto ──
  "submission.project.submitted": "Proyecto entregado",
  "submission.project.graded": "Proyecto calificado",
  "submission.project.updated_in_progress": "Proyecto editado en progreso",

  // ── Calificación manual (docente sobreescribe IA) ──
  "grade.manual_override": "Nota manual guardada",
  "grade.manual_cleared": "Nota manual eliminada",
  "grading.ai_triggered": "Calificación IA iniciada",
  "grading.grade_override": "Nota manual guardada",
  "grading.defense_saved": "Sustentación guardada",
  "grading.manual_save": "Calificación manual guardada",

  // ── IA — generación + calificación ──
  "ai.grading_started": "Calificación IA iniciada",
  "ai.grading_failed": "Error de IA — calificación",
  "ai.questions_generation_failed": "Error de IA — generación de preguntas",
  "ai_grading.completed": "Calificación IA completada",
  "ai_questions.generated": "Preguntas generadas con IA",
  "ai_plagiarism.detected": "Plagio detectado por IA",
  "ai.grading_retry_run": "Reintento automático de calificación IA",
  "ai.grading_retry_run_failed": "Reintento automático de calificación IA falló",
  // ── Ejecución de código (compilador remoto) ──
  "code.executed": "Código ejecutado",
  "code.compile_error": "Error de compilación",
  "code.execute_failed": "Error de IA — compilador",
  // Disparado desde el cliente (app.student.take) cuando el invoke de
  // execute-code falla (HTTP no-2xx o excepción de red).
  "code_execution_error": "Error ejecutando código",

  // ── Fraude / integridad ──
  "fraud.plagiarism_run": "Análisis de plagio ejecutado",
  "fraud.plagiarism_detection_started": "Detección de plagio iniciada",
  "fraud.plagiarism_detected": "Detección de plagio completada",
  "fraud.plagiarism_detection_failed": "Detección de plagio fallida",
  "fraud.manual_flag": "Marcado como fraude manualmente",
  "fraud.warnings_cleared_all": "Advertencias borradas",

  // ── Asistencia (check-in con QR) ──
  "attendance.checkin_opened": "Check-in de asistencia abierto",
  "attendance.checkin_closed": "Check-in de asistencia cerrado",
  "attendance.pending_marked_absent": "Pendientes marcados como ausentes",

  // ── Contenidos (módulo Contenidos del docente) ──
  "content.generated": "Contenido generado",
  "content.generation_failed": "Generación de contenido fallida",
  "content.regeneration_failed": "Regeneración de contenido fallida",

  // ── Configuración del sistema (admin) ──
  "edge_secrets.set": "Edge Function Secret actualizado",
  "edge_secrets.unset": "Edge Function Secret eliminado",
  "edge_secrets.error": "Error gestionando Edge Function Secret",
  "ai_model.activated": "Modelo de IA actualizado",
  "ai_prompt.updated": "Prompt de IA actualizado",
  "ai_prompt.restored_default": "Prompt de IA restaurado al default",
  "ai_prompt.course_override_saved": "Prompt de IA override por curso",
  "ai_prompt.course_override_removed": "Prompt de IA override removido",
  "branding.created": "Marca institucional creada",
  "branding.updated": "Marca institucional actualizada",

  // ── Usuarios ──
  "user.created": "Usuario creado",
  "user.deleted": "Usuario eliminado",
  "user.bulk_deleted": "Usuarios eliminados (masivo)",
  "user.bulk_imported": "Usuarios importados (masivo)",
  "user.role_added": "Rol asignado",
  "user.role_removed": "Rol removido",
  "user.roles_updated": "Roles actualizados",
  "user.password_changed": "Contraseña cambiada",
  "user.password_change_failed": "Cambio de contraseña fallido",
  "user.password_reset_by_admin": "Contraseña restablecida por admin",
  "user.password_reset_failed": "Reset de contraseña fallido",
  "user.logged_out": "Sesión cerrada",
  "user.login_failed": "Inicio de sesión fallido",
  "user.navigated": "Navegación interna",

  // ── Calendario externo (Google / Outlook) ──
  "calendar.connected": "Calendario conectado",
  "calendar.connect_failed": "Conexión de calendario fallida",
  "calendar.disconnected": "Calendario desconectado",
  "calendar.synced": "Calendario sincronizado",
  "calendar.sync_failed": "Sincronización de calendario fallida",

  // ── Notificaciones por correo (trigger SQL + edge function send-email) ──
  "email.dispatched": "Correo enviado al SMTP",
  "email.delivered": "Correo entregado",
  "email.skipped": "Correo omitido",
  "email.failed": "Correo fallido",
};

// Solo guardamos las clases CSS; el label se resuelve con t("audit.categories.<key>").
const CATEGORY_CONFIG: Record<string, { cls: string }> = {
  exam: {
    cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  },
  workshop: {
    cls: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  },
  project: {
    cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  },
  course: {
    cls: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
  },
  user: {
    cls: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  },
  grading: {
    cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  },
  fraud: { cls: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300" },
  email: {
    cls: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  },
  system: {
    cls: "bg-slate-100 text-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
  },
};

// Solo guardamos clases CSS; los labels se resuelven con t("audit.severities.<key>").
const SEVERITY_CONFIG: Record<string, { iconCls: string; rowCls: string }> = {
  info: { iconCls: "text-muted-foreground", rowCls: "" },
  warning: {
    iconCls: "text-amber-600 dark:text-amber-400",
    rowCls: "bg-amber-50/50 dark:bg-amber-950/20",
  },
  error: {
    iconCls: "text-red-600 dark:text-red-400",
    rowCls: "bg-red-50/50 dark:bg-red-950/20",
  },
  critical: {
    iconCls: "text-red-700 dark:text-red-300 font-bold",
    rowCls: "bg-red-100/70 dark:bg-red-900/30",
  },
};

const SEVERITY_ICONS: Record<string, React.ReactNode> = {
  info: <Info className="h-3.5 w-3.5" />,
  warning: <AlertTriangle className="h-3.5 w-3.5" />,
  error: <AlertCircle className="h-3.5 w-3.5" />,
  critical: <ShieldAlert className="h-3.5 w-3.5" />,
};

// Estilos del badge de rol. Cubrimos variantes con/sin mayúscula
// porque el trigger DB persiste 'sistema' minúscula pero las edge
// functions usan 'Sistema'. Igual con Anónimo (login fallido).
const ROLE_CLS: Record<string, string> = {
  Admin: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  Docente: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  Estudiante: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  Sistema: "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400",
  sistema: "bg-slate-100 text-slate-600 dark:bg-slate-800/50 dark:text-slate-400",
  Anónimo: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300",
};

const PAGE_SIZE = 100;

// ─── Componente principal ──────────────────────────────────────────────────────

export function AuditLogsView({ mode }: { mode: "admin" | "teacher" }) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const offsetRef = useRef(0);

  // Filtros
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [severity, setSeverity] = useState("all");
  // Filtro por rol del actor. "Sistema" cubre tanto los eventos que el
  // trigger DB marca con actor_role='sistema' (ej. flagged_suspicious)
  // como los del helper de edge functions con fallback 'Sistema'.
  const [roleFilter, setRoleFilter] = useState("all");
  // Grupo de acciones — filtra server-side por prefijo/sufijo de action.
  // Mapeamos cada opción a un patrón ILIKE en el handler de carga. Útil
  // para enfocarse rápido en "actualizaciones de entregas en progreso"
  // sin tener que escribir el action exacto en la búsqueda.
  const [actionGroup, setActionGroup] = useState("all");
  const [courseFilter, setCourseFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  // Datos de soporte
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);

  // Dialog detalle
  const [detail, setDetail] = useState<AuditLog | null>(null);
  const [detailJsonOpen, setDetailJsonOpen] = useState(false);

  // ── Carga cursos (solo admin necesita el selector) ────────────────────────
  useEffect(() => {
    if (mode !== "admin") return;
    supabase
      .from("courses")
      .select("id, name")
      .order("name")
      .then(({ data }) => setCourses(data ?? []));
  }, [mode]);

  // ── Función de carga principal ────────────────────────────────────────────
  const load = useCallback(
    async (reset: boolean) => {
      if (reset) {
        setLoading(true);
        offsetRef.current = 0;
      } else {
        setLoadingMore(true);
      }

      try {
        let q = db
          .from("audit_logs")
          .select("*", { count: "exact" })
          .order("created_at", { ascending: false })
          .range(offsetRef.current, offsetRef.current + PAGE_SIZE - 1);

        if (category !== "all") q = q.eq("category", category);
        if (severity !== "all") q = q.eq("severity", severity);
        if (roleFilter !== "all") q = q.eq("actor_role", roleFilter);
        if (mode === "admin" && courseFilter !== "all") q = q.eq("course_id", courseFilter);
        if (dateFrom) q = q.gte("created_at", new Date(dateFrom).toISOString());
        if (dateTo) {
          const to = new Date(dateTo);
          to.setDate(to.getDate() + 1);
          q = q.lt("created_at", to.toISOString());
        }
        // Grupos de acción — patrones ILIKE. Mantener en sync con las
        // opciones del Select de abajo.
        const actionGroupPatterns: Record<string, string | null> = {
          all: null,
          submissions: "submission.%",
          updates_in_progress: "%updated_in_progress",
          grading: "%grade%",
          login: "user.log%",
          ai: "ai%",
          email: "email.%",
        };
        const pat = actionGroupPatterns[actionGroup];
        if (pat) q = q.ilike("action", pat);

        const { data, error, count } = await q;
        if (error) throw error;

        const rows = (data ?? []) as AuditLog[];
        if (reset) {
          setLogs(rows);
        } else {
          setLogs((prev) => [...prev, ...rows]);
        }
        setTotal(count ?? null);
        setHasMore(rows.length === PAGE_SIZE);
        offsetRef.current += rows.length;
      } catch (err: any) {
        toast.error("Error cargando auditoría: " + (err?.message ?? err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [category, severity, roleFilter, courseFilter, dateFrom, dateTo, actionGroup, mode],
  ); // search es client-side

  // Reload cuando cambian filtros de servidor
  useEffect(() => {
    void load(true);
  }, [load]);

  // ── Filtro de búsqueda client-side ────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return logs;
    const q = search.toLowerCase();
    return logs.filter(
      (l) =>
        l.actor_email?.toLowerCase().includes(q) ||
        l.entity_name?.toLowerCase().includes(q) ||
        l.course_name?.toLowerCase().includes(q) ||
        ACTION_LABELS[l.action]?.toLowerCase().includes(q) ||
        l.action.toLowerCase().includes(q),
    );
  }, [logs, search]);

  // ── Filtros activos ───────────────────────────────────────────────────────
  const hasFilters =
    search ||
    category !== "all" ||
    severity !== "all" ||
    roleFilter !== "all" ||
    actionGroup !== "all" ||
    (mode === "admin" && courseFilter !== "all") ||
    dateFrom ||
    dateTo;

  const clearFilters = () => {
    setSearch("");
    setCategory("all");
    setSeverity("all");
    setRoleFilter("all");
    setActionGroup("all");
    setCourseFilter("all");
    setDateFrom("");
    setDateTo("");
  };

  // ── Export CSV ────────────────────────────────────────────────────────────
  const exportCsv = () => {
    if (!filtered.length) return;
    const csv = toCSV(
      filtered.map((l) => ({
        fecha: formatDateTime(l.created_at),
        actor: l.actor_email ?? "",
        rol: l.actor_role ?? "",
        accion: ACTION_LABELS[l.action] ?? l.action,
        categoria: CATEGORY_CONFIG[l.category] ? t(`audit.categories.${l.category}`) : l.category,
        nivel: SEVERITY_CONFIG[l.severity] ? t(`audit.severities.${l.severity}`) : l.severity,
        entidad: l.entity_name ?? "",
        tipo_entidad: l.entity_type ?? "",
        curso: l.course_name ?? "",
        detalles: JSON.stringify(l.metadata),
      })),
    );
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auditoria_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 sm:p-6 max-w-screen-xl mx-auto space-y-4">
      <PageHeader
        title={t("audit.title")}
        subtitle={mode === "admin" ? t("audit.subtitleAdmin") : t("audit.subtitleTeacher")}
        icon={<Shield className="h-6 w-6" />}
        actions={
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
            <Download className="h-4 w-4 mr-2" />
            {t("audit.exportCsv")}
          </Button>
        }
      />

      {/* ── Filtros ── */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-wrap gap-2 items-end">
            {/* Búsqueda */}
            <div className="relative flex-1 min-w-48">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder={t("audit.filters.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9"
              />
            </div>

            {/* Categoría */}
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-40 h-9">
                <SelectValue placeholder={t("audit.filters.categoryPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("audit.filters.categoryAll")}</SelectItem>
                {Object.keys(CATEGORY_CONFIG).map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`audit.categories.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Tipo de evento (grupo de acción) — patrones ILIKE
                server-side. Útil para enfocarse rápido sin tener que
                conocer cada action key. */}
            <Select value={actionGroup} onValueChange={setActionGroup}>
              <SelectTrigger className="w-48 h-9">
                <SelectValue placeholder={t("audit.filters.actionGroupPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("audit.filters.actionGroupAll")}</SelectItem>
                <SelectItem value="submissions">
                  {t("audit.filters.actionGroupSubmissions")}
                </SelectItem>
                <SelectItem value="updates_in_progress">
                  {t("audit.filters.actionGroupUpdatesInProgress")}
                </SelectItem>
                <SelectItem value="grading">{t("audit.filters.actionGroupGrading")}</SelectItem>
                <SelectItem value="login">{t("audit.filters.actionGroupLogin")}</SelectItem>
                <SelectItem value="ai">{t("audit.filters.actionGroupAi")}</SelectItem>
                <SelectItem value="email">{t("audit.filters.actionGroupEmail")}</SelectItem>
              </SelectContent>
            </Select>

            {/* Nivel */}
            <Select value={severity} onValueChange={setSeverity}>
              <SelectTrigger className="w-36 h-9">
                <SelectValue placeholder={t("audit.filters.severityPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("audit.filters.severityAll")}</SelectItem>
                {Object.keys(SEVERITY_CONFIG).map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`audit.severities.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Rol del actor — filtra eventos por quién los ejecutó.
                Los valores aquí deben coincidir EXACTAMENTE con lo que
                el trigger DB y los helpers de edge functions persisten
                en `actor_role` (Admin, Docente, Estudiante, Sistema,
                Anónimo). El admin también necesita ver "Sistema"
                (triggers internos como flagged_suspicious). */}
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="w-36 h-9">
                <SelectValue placeholder={t("audit.filters.rolePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("audit.filters.roleAll")}</SelectItem>
                <SelectItem value="Admin">{t("roles.Admin")}</SelectItem>
                <SelectItem value="Docente">{t("roles.Docente")}</SelectItem>
                <SelectItem value="Estudiante">{t("roles.Estudiante")}</SelectItem>
                <SelectItem value="Sistema">{t("audit.filters.roleSystem")}</SelectItem>
                <SelectItem value="Anónimo">{t("audit.filters.roleAnonymous")}</SelectItem>
              </SelectContent>
            </Select>

            {/* Curso (solo admin) */}
            {mode === "admin" && (
              <Select value={courseFilter} onValueChange={setCourseFilter}>
                <SelectTrigger className="w-44 h-9">
                  <SelectValue placeholder={t("audit.filters.coursePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("audit.filters.courseAll")}</SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Rango de fechas */}
            <div className="flex items-center gap-1">
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-9 w-36 text-sm"
                title={t("audit.filters.from")}
              />
              <span className="text-muted-foreground text-xs">–</span>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-9 w-36 text-sm"
                title={t("audit.filters.to")}
              />
            </div>

            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-9 text-muted-foreground"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {t("audit.filters.clear")}
              </Button>
            )}
          </div>

          {total !== null && (
            <p className="text-xs text-muted-foreground mt-2">
              {t("audit.totalEvents", { count: total })}
              {filtered.length !== logs.length &&
                ` · ${t("audit.visibleWithSearch", { count: filtered.length })}`}
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Tabla ── */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-36">{t("common.date")}</TableHead>
                  <TableHead className="w-48">{t("common.actor")}</TableHead>
                  <TableHead>{t("common.action")}</TableHead>
                  <TableHead className="w-32">{t("common.category")}</TableHead>
                  <TableHead className="w-40">{t("common.entity")}</TableHead>
                  {mode === "admin" && <TableHead className="w-40">{t("common.course")}</TableHead>}
                  <TableHead className="w-28">{t("common.level")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableSkeleton cols={mode === "admin" ? 8 : 7} rows={10} />
                ) : filtered.length === 0 ? (
                  <TableEmpty colSpan={mode === "admin" ? 8 : 7} text={t("audit.noEvents")} />
                ) : (
                  filtered.map((log) => {
                    const sev = SEVERITY_CONFIG[log.severity] ?? SEVERITY_CONFIG.info;
                    const cat = CATEGORY_CONFIG[log.category];
                    return (
                      <TableRow
                        key={log.id}
                        className={`cursor-pointer hover:bg-muted/40 ${sev.rowCls}`}
                        onClick={() => {
                          setDetail(log);
                          setDetailJsonOpen(false);
                        }}
                      >
                        {/* Fecha */}
                        <TableCell className="whitespace-nowrap">
                          <DateCell value={log.created_at} variant="datetime" />
                        </TableCell>

                        {/* Actor */}
                        <TableCell>
                          <div className="flex flex-col gap-0.5 min-w-0">
                            <span
                              className="text-sm truncate max-w-44"
                              title={log.actor_email ?? t("audit.system")}
                            >
                              {log.actor_email ?? (
                                <span className="italic text-muted-foreground">
                                  {t("audit.system")}
                                </span>
                              )}
                            </span>
                            {log.actor_role && (
                              <Badge
                                variant="outline"
                                className={`self-start text-[10px] py-0 ${ROLE_CLS[log.actor_role] ?? ROLE_CLS.sistema}`}
                              >
                                {log.actor_role}
                              </Badge>
                            )}
                          </div>
                        </TableCell>

                        {/* Acción */}
                        <TableCell className="text-sm">
                          {ACTION_LABELS[log.action] ?? log.action}
                        </TableCell>

                        {/* Categoría */}
                        <TableCell>
                          {cat && (
                            <Badge variant="outline" className={`text-[10px] ${cat.cls}`}>
                              {t(`audit.categories.${log.category}`)}
                            </Badge>
                          )}
                        </TableCell>

                        {/* Entidad */}
                        <TableCell>
                          <span
                            className="text-sm truncate block max-w-36"
                            title={log.entity_name ?? ""}
                          >
                            {log.entity_name ?? "—"}
                          </span>
                        </TableCell>

                        {/* Curso (admin only) */}
                        {mode === "admin" && (
                          <TableCell>
                            <span
                              className="text-sm truncate block max-w-36 text-muted-foreground"
                              title={log.course_name ?? ""}
                            >
                              {log.course_name ?? "—"}
                            </span>
                          </TableCell>
                        )}

                        {/* Nivel */}
                        <TableCell>
                          <span
                            className={`inline-flex items-center gap-1 text-xs font-medium ${sev.iconCls}`}
                          >
                            {SEVERITY_ICONS[log.severity]}
                            {t(`audit.severities.${log.severity}`, { defaultValue: log.severity })}
                          </span>
                        </TableCell>

                        {/* Detalle icon */}
                        <TableCell>
                          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>

          {/* Cargar más */}
          {hasMore && !loading && (
            <div className="p-4 border-t flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => load(false)}
                disabled={loadingMore}
              >
                {loadingMore ? <Spinner size="xs" className="mr-2" /> : null}
                {t("audit.loadMore", { count: PAGE_SIZE })}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Dialog de detalle ── */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detail && SEVERITY_ICONS[detail.severity]}
              <span>{detail ? (ACTION_LABELS[detail.action] ?? detail.action) : ""}</span>
            </DialogTitle>
          </DialogHeader>

          {detail && (
            <div className="space-y-4 text-sm">
              {/* Cabecera del evento */}
              <div className="grid grid-cols-2 gap-x-4 gap-y-2">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("common.date")}</p>
                  <DateCell value={detail.created_at} variant="datetime" />
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("common.level")}</p>
                  <span
                    className={`inline-flex items-center gap-1 font-medium ${SEVERITY_CONFIG[detail.severity]?.iconCls}`}
                  >
                    {SEVERITY_ICONS[detail.severity]}
                    {t(`audit.severities.${detail.severity}`, { defaultValue: detail.severity })}
                  </span>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("common.actor")}</p>
                  <p>
                    {detail.actor_email ?? (
                      <span className="italic text-muted-foreground">{t("audit.system")}</span>
                    )}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("common.role")}</p>
                  {detail.actor_role ? (
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${ROLE_CLS[detail.actor_role] ?? ROLE_CLS.sistema}`}
                    >
                      {detail.actor_role}
                    </Badge>
                  ) : (
                    "—"
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("common.category")}</p>
                  {CATEGORY_CONFIG[detail.category] ? (
                    <Badge
                      variant="outline"
                      className={`text-[10px] ${CATEGORY_CONFIG[detail.category].cls}`}
                    >
                      {t(`audit.categories.${detail.category}`)}
                    </Badge>
                  ) : (
                    detail.category
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">{t("audit.rawAction")}</p>
                  <code className="text-xs bg-muted px-1 py-0.5 rounded">{detail.action}</code>
                </div>
                {detail.entity_name && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{t("common.entity")}</p>
                    <p>{detail.entity_name}</p>
                  </div>
                )}
                {detail.entity_id && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{t("audit.entityId")}</p>
                    <code className="text-xs text-muted-foreground break-all">
                      {detail.entity_id}
                    </code>
                  </div>
                )}
                {detail.course_name && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-0.5">{t("common.course")}</p>
                    <p>{detail.course_name}</p>
                  </div>
                )}
              </div>

              {/* JSON detalles */}
              {Object.keys(detail.metadata ?? {}).length > 0 && (
                <div className="border rounded-md overflow-hidden">
                  <button
                    className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted/40 transition-colors"
                    onClick={() => setDetailJsonOpen((o) => !o)}
                  >
                    <span>{t("audit.moreDetails")}</span>
                    {detailJsonOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </button>
                  {detailJsonOpen && (
                    <pre className="text-xs bg-muted/30 p-3 overflow-auto max-h-48 whitespace-pre-wrap break-all border-t">
                      {JSON.stringify(detail.metadata, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

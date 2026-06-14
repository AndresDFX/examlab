/**
 * AuditLogsView — vista compartida Admin/Docente del registro de auditoría.
 * mode='admin'   → carga todos los eventos, muestra filtro por curso.
 * mode='teacher' → RLS filtra automáticamente a los cursos del docente.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
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
  SortableHead,
} from "@/components/ui/table";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { DateCell } from "@/components/ui/date-cell";
import { usePagination } from "@/hooks/use-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { DataPagination } from "@/components/ui/data-pagination";
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
  FileText,
  FileSpreadsheet,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatDateTime } from "@/shared/lib/format";
import { toCSV, downloadCSV } from "@/shared/lib/csv";
import { toXLSX, downloadXLSX } from "@/shared/lib/xlsx";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

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

// Set of known action keys — used to decide whether to try t() lookup or
// fall back to the raw slug. We keep only the set of keys so the component
// can call t(`audit.actionLabels.${action}`) and fall back gracefully.
const ACTION_LABEL_KEYS = new Set<string>([
  "exam.created", "exam.updated", "exam.deleted", "exam.bulk_deleted",
  "exam.published", "exam.closed", "exam.duplicated",
  "workshop.created", "workshop.updated", "workshop.deleted", "workshop.bulk_deleted",
  "project.created", "project.updated", "project.deleted", "project.bulk_deleted",
  "course.created", "course.updated", "course.deleted",
  "program.created", "program.updated", "program.deleted", "program.toggled",
  "period.created", "period.updated", "period.closed", "period.reopened", "period.deleted",
  "subject.created", "subject.updated", "subject.deleted",
  "acta.generated", "acta.deleted",
  "enrollment.added", "enrollment.removed", "enrollment.bulk_added",
  "submission.exam.started", "submission.exam.submitted", "submission.exam.graded",
  "submission.exam.grade_updated", "submission.exam.flagged_suspicious",
  "exam_started", "exam_submitted", "exam_suspended", "exam_fullscreen_denied",
  "submission.workshop.submitted", "submission.workshop.graded",
  "submission.workshop.updated_in_progress",
  "submission.project.submitted", "submission.project.graded",
  "submission.project.updated_in_progress",
  "grade.manual_override", "grade.manual_cleared",
  "grading.ai_triggered", "grading.grade_override", "grading.defense_saved",
  "grading.manual_save",
  "ai.grading_started", "ai.grading_failed", "ai.questions_generation_failed",
  "ai_grading.completed", "ai_questions.generated", "ai_plagiarism.detected",
  "ai.grading_retry_run", "ai.grading_retry_run_failed",
  "ai_grading.job_enqueued", "ai_grading.job_completed", "ai_grading.job_failed",
  "ai_grading.job_discarded_cancelled", "ai_grading.job_cancelled",
  "ai_grading.job_processed_manual", "ai_grading.job_requeued",
  "ai_grading.jobs_cancelled_bulk",
  "code.executed", "code.compile_error", "code.execute_failed", "code_execution_error",
  "fraud.plagiarism_run", "fraud.plagiarism_detection_started",
  "fraud.plagiarism_detected", "fraud.plagiarism_detection_failed",
  "fraud.manual_flag", "fraud.warnings_cleared_all",
  "attendance.checkin_opened", "attendance.checkin_closed",
  "attendance.pending_marked_absent",
  "content.generated", "content.generation_failed", "content.regeneration_failed",
  "edge_secrets.set", "edge_secrets.unset", "edge_secrets.error",
  "ai_model.activated", "ai_prompt.updated", "ai_prompt.restored_default",
  "ai_prompt.course_override_saved", "ai_prompt.course_override_removed",
  "branding.created", "branding.updated",
  "user.created", "user.updated", "user.deleted", "user.bulk_deleted",
  "user.bulk_imported", "user.role_added", "user.role_removed", "user.roles_updated",
  "user.password_changed", "user.password_change_failed",
  "user.password_reset_by_admin", "user.password_reset_failed",
  "user.email_change_requested", "user.email_changed",
  "user.logged_out", "user.login_failed", "user.login_success", "user.navigated",
  "app.render_error", "app.runtime_error", "app.unhandled_rejection",
  "calendar.connected", "calendar.connect_failed", "calendar.disconnected",
  "calendar.synced", "calendar.sync_failed", "calendar.calendar_missing",
  "email.dispatched", "email.delivered", "email.skipped", "email.failed",
  "ai_grading.batch_dryrun", "ai_grading.batch_applied",
  "app_settings.updated", "audit_retention.updated", "email_settings.updated",
  "code_execution.provider_changed",
  "certificate_settings.updated", "certificate_settings.course_override_saved",
  "certificate_settings.course_override_removed",
  "broadcast.sent", "broadcast.email_failed", "broadcast.email_skipped",
  "broadcast.error",
  "java_gui.screenshot_executed", "java_gui.screenshot_failed",
  "java_gui.screenshot_error",
  "python_gui.screenshot_executed", "python_gui.screenshot_failed",
  "python_gui.screenshot_error",
  "workshop.submission_reopened", "project.submission_reopened",
  "system.diagnostic.warnings_detected", "system.diagnostic.db_failed",
  "system.diagnostic.edge_function_failed",
  "ai_queue.processed", "ai_queue.job_failed", "ai_override.activated",
]);

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
  // Configuración institucional: programas, periodos, asignaturas y actas
  // oficiales. Color violeta para diferenciarlo del 'course' (acciones
  // sobre instancias) y de 'system' (config genérica).
  academic: {
    cls: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
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

  // Resolves a human-readable label for an audit action. Falls back to the
  // raw slug if no translation key exists (forward-compat with new events).
  const actionLabel = (action: string) =>
    ACTION_LABEL_KEYS.has(action)
      ? t(`audit.actionLabels.${action}`, { defaultValue: action })
      : action;
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
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
  // Filtro tenant — solo SuperAdmin lo ve. RLS para Admin/Docente ya
  // acota los logs a su tenant. Para SuperAdmin (cross-tenant) ofrecemos
  // un Select que aplica `.eq('tenant_id', X)` a la query principal.
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  // Solo true cuando actúa como SuperAdmin (no por solo tener el rol).
  // Ver comentario en app.admin.users.
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const [tenantFilter, setTenantFilter] = useState("all");
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);

  // Datos de soporte
  const [courses, setCourses] = useState<{ id: string; name: string }[]>([]);

  // Cargar tenants si SuperAdmin (para el Select de instituciones).
  useEffect(() => {
    if (!isSuperAdminCaller) return;
    let cancelled = false;
    void (async () => {
      const { data } = await db
        .from("tenants")
        .select("id, slug, name")
        .is("deleted_at", null)
        .order("name");
      if (cancelled) return;
      setTenants((data ?? []) as Array<{ id: string; slug: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSuperAdminCaller]);

  // Dialog detalle
  const [detail, setDetail] = useState<AuditLog | null>(null);
  const [detailJsonOpen, setDetailJsonOpen] = useState(false);

  // ── Carga cursos (solo admin necesita el selector) ────────────────────────
  useEffect(() => {
    if (mode !== "admin") return;
    supabase
      .from("courses")
      .select("id, name")
      .is("deleted_at", null) // no incluir cursos en papelera en el dropdown
      .order("name")
      .then(({ data }) => setCourses(data ?? []));
  }, [mode]);

  // ── Función de carga principal ────────────────────────────────────────────
  const load = useCallback(
    async (reset: boolean) => {
      if (reset) {
        setLoading(true);
        setLoadError(null);
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
        if (isSuperAdminCaller && tenantFilter !== "all") q = q.eq("tenant_id", tenantFilter);
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
        if (reset) {
          setLoadError(friendlyError(err, "Error cargando auditoría."));
        } else {
          toast.error(
            i18n.t("toast.modules_admin_AuditLogsView.loadAuditError", {
              defaultValue: "Error cargando auditoría: {{detail}}",
              detail: friendlyError(err),
            }),
          );
        }
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [
      category,
      severity,
      roleFilter,
      courseFilter,
      dateFrom,
      dateTo,
      actionGroup,
      mode,
      isSuperAdminCaller,
      tenantFilter,
    ],
  ); // search es client-side

  // Reload cuando cambian filtros de servidor o se reintenta
  useEffect(() => {
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, retryNonce]);

  // ── Filtro de búsqueda client-side ────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!search.trim()) return logs;
    const q = search.toLowerCase();
    return logs.filter(
      (l) =>
        l.actor_email?.toLowerCase().includes(q) ||
        l.entity_name?.toLowerCase().includes(q) ||
        l.course_name?.toLowerCase().includes(q) ||
        actionLabel(l.action)?.toLowerCase().includes(q) ||
        l.action.toLowerCase().includes(q),
    );
  }, [logs, search]);

  // ── Orden por columna (client-side, entre filtro y paginación) ───────────
  // Los accessors devuelven el MISMO valor visible en cada columna para que
  // el orden alfabético/cronológico coincida con lo que el usuario lee
  // (acción/categoría/nivel se ordenan por su label traducido).
  const sort = useTableSort(filtered, {
    columns: {
      created_at: (l) => l.created_at,
      actor: (l) => l.actor_email,
      action: (l) => actionLabel(l.action),
      category: (l) =>
        CATEGORY_CONFIG[l.category] ? t(`audit.categories.${l.category}`) : l.category,
      entity: (l) => l.entity_name,
      course: (l) => l.course_name,
      severity: (l) =>
        SEVERITY_CONFIG[l.severity] ? t(`audit.severities.${l.severity}`) : l.severity,
    },
    defaultSort: { key: "created_at", dir: "desc" },
    storageKey: "examlab_sort:audit_logs",
  });

  // Paginación client-side sobre la lista ya filtrada por search y ordenada.
  // Los demás filtros (category/severity/etc.) son server-side y resetean
  // el offset en `load(reset=true)`; aquí solo necesitamos resetear a
  // página 1 cuando cambia el search (que filtra in-memory), el set base de
  // logs (length) o el orden activo.
  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:audit_logs",
    resetKey: `${search}|${logs.length}|${sort.resetKey}`,
  });

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

  // ── Export CSV / Excel ────────────────────────────────────────────────────
  const exportAudit = (format: "csv" | "xlsx" = "csv") => {
    if (!filtered.length) return;
    const rows = filtered.map((l) => ({
      fecha: formatDateTime(l.created_at),
      actor: l.actor_email ?? "",
      rol: l.actor_role ?? "",
      accion: actionLabel(l.action),
      categoria: CATEGORY_CONFIG[l.category] ? t(`audit.categories.${l.category}`) : l.category,
      nivel: SEVERITY_CONFIG[l.severity] ? t(`audit.severities.${l.severity}`) : l.severity,
      entidad: l.entity_name ?? "",
      tipo_entidad: l.entity_type ?? "",
      curso: l.course_name ?? "",
      detalles: JSON.stringify(l.metadata),
    }));
    const fileBase = `auditoria_${new Date().toISOString().slice(0, 10)}`;
    if (format === "xlsx") {
      downloadXLSX(`${fileBase}.xlsx`, toXLSX(rows));
      return;
    }
    downloadCSV(`${fileBase}.csv`, toCSV(rows));
  };

  // ─────────────────────────────────────────────────────────────────────────

  return (
    // Wrapper sin padding/max-width propios — el contenedor padre
    // (AppLayout o la tab de /app/admin/audit-logs) ya provee el
    // padding y centrado estándar. Antes tenía `p-4 sm:p-6
    // max-w-screen-xl mx-auto` que duplicaba el padding cuando se
    // renderea adentro de Tabs y dejaba el grid más ancho que el
    // resto de los módulos admin.
    <div className="space-y-5">
      <PageHeader
        title={t("audit.title")}
        subtitle={mode === "admin" ? t("audit.subtitleAdmin") : t("audit.subtitleTeacher")}
        icon={<Shield className="h-6 w-6" />}
        actions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={!filtered.length}>
                <Download className="h-4 w-4 mr-2" />
                {t("audit.exportLabel", { defaultValue: "Exportar" })}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => exportAudit("csv")}>
                <FileText className="h-4 w-4 mr-2" />
                CSV
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportAudit("xlsx")}>
                <FileSpreadsheet className="h-4 w-4 mr-2" />
                Excel
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {/* ── Filtros ──
          Reorganización (UX): 2 filas con propósito claro.
            • Fila 1 — BÚSQUEDA prominente (flex-1) + contador a la
              derecha. Antes el contador flotaba en la fila 2 al final;
              moverlo arriba lo destaca como métrica del set actual.
            • Fila 2 — TODOS los filtros agrupados con separadores
              verticales sutiles para que el ojo lea "dónde / qué /
              cuándo" sin tener que leer cada label:
                  [Institución] [Curso]  │  [Categoría] [Evento]
                  [Nivel] [Rol]  │  [Desde – Hasta]  [Limpiar]
              El separador `│` (`<div className="w-px h-5 bg-border" />`)
              solo aparece en sm+ para no fragmentar la fila en mobile.
          Antes los filtros ocupaban 2 filas crowded sin agrupamiento
          visual; ahora son una sola wrap row donde cada bloque se lee
          como una unidad. */}
      <Card>
        <CardContent className="p-4 space-y-3">
          {/* Fila 1 — búsqueda + contador */}
          <div className="flex flex-wrap gap-3 items-center">
            <div className="relative flex-1 min-w-[220px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground pointer-events-none" />
              <Input
                placeholder={t("audit.filters.searchPlaceholder")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-8 h-9"
              />
            </div>
            {total !== null && (
              <p className="text-xs text-muted-foreground tabular-nums shrink-0">
                {t("audit.totalEvents", { count: total })}
                {filtered.length !== logs.length &&
                  ` · ${t("audit.visibleWithSearch", { count: filtered.length })}`}
              </p>
            )}
          </div>

          {/* Fila 2 — todos los filtros agrupados con separadores. */}
          <div className="flex flex-wrap gap-2 items-center">
            {/* ── Grupo "dónde" — scope: institución + curso ── */}
            {isSuperAdminCaller && tenants.length > 0 && (
              <Select value={tenantFilter} onValueChange={setTenantFilter}>
                <SelectTrigger className="w-44 h-9">
                  <SelectValue placeholder={t("tenant.filterTenantPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
                  {/* `tn` evita shadow del `t` de useTranslation. */}
                  {tenants.map((tn) => (
                    <SelectItem key={tn.id} value={tn.id}>
                      {tn.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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

            {/* Separador sutil entre "dónde" y "qué". Oculto en mobile
                (se vería suelto en la cuarta fila después del wrap). */}
            <div className="hidden sm:block w-px h-5 bg-border mx-1" aria-hidden />

            {/* ── Grupo "qué" — categoría / evento / nivel / rol ── */}
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

            <Select value={actionGroup} onValueChange={setActionGroup}>
              <SelectTrigger className="w-44 h-9">
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

            {/* Rol del actor — valores deben coincidir con los que el
                trigger DB y los edges persisten en `actor_role` (Admin,
                Docente, Estudiante, Sistema, Anónimo). */}
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

            {/* Separador entre "qué" y "cuándo". */}
            <div className="hidden sm:block w-px h-5 bg-border mx-1" aria-hidden />

            {/* ── Grupo "cuándo" — rango de fechas + Limpiar ──
                Reemplazado <Input type="date"> nativo por DatePicker propio
                (Popover + Calendar de react-day-picker). Motivos:
                  - El nativo rendea con look del browser (fondo claro propio,
                    glifo de calendario inconsistente) y rompía la coherencia
                    con los Selects de al lado.
                  - El nativo no respeta dark mode bien en algunos browsers.
                  - El DatePicker propio usa Button outline que matchea
                    visualmente con los SelectTrigger del resto de los filtros. */}
            <DatePicker
              value={dateFrom}
              onChange={setDateFrom}
              placeholder={t("audit.filters.from")}
              className="h-9 w-40"
            />
            <span className="text-muted-foreground text-xs">–</span>
            <DatePicker
              value={dateTo}
              onChange={setDateTo}
              placeholder={t("audit.filters.to")}
              className="h-9 w-40"
            />

            {hasFilters && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFilters}
                className="h-9 ml-auto text-muted-foreground"
              >
                <X className="h-3.5 w-3.5 mr-1" />
                {t("audit.filters.clear")}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Tabla ── */}
      <Card>
        <CardContent className="p-0">
          {loadError ? (
            <ErrorState
              message={t("audit.loadError")}
              hint={loadError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : (
            <div className="overflow-x-auto">
              <Table resizable>
                <TableHeader>
                  <TableRow>
                    <SortableHead sortKey="created_at" sort={sort} className="w-36">
                      {t("common.date")}
                    </SortableHead>
                    <SortableHead sortKey="actor" sort={sort} className="w-48">
                      {t("common.actor")}
                    </SortableHead>
                    <SortableHead sortKey="action" sort={sort}>
                      {t("common.action")}
                    </SortableHead>
                    <SortableHead sortKey="category" sort={sort} className="w-32">
                      {t("common.category")}
                    </SortableHead>
                    <SortableHead sortKey="entity" sort={sort} className="w-40">
                      {t("common.entity")}
                    </SortableHead>
                    {mode === "admin" && (
                      <SortableHead sortKey="course" sort={sort} className="w-40">
                        {t("common.course")}
                      </SortableHead>
                    )}
                    <SortableHead sortKey="severity" sort={sort} className="w-28">
                      {t("common.level")}
                    </SortableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loading ? (
                    <TableSkeleton cols={mode === "admin" ? 8 : 7} rows={10} />
                  ) : filtered.length === 0 ? (
                    <TableEmpty colSpan={mode === "admin" ? 8 : 7} text={t("audit.noEvents")} />
                  ) : (
                    pagination.paginatedItems.map((log) => {
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
                          <TableCell className="text-sm" truncate title={actionLabel(log.action)}>
                            {actionLabel(log.action)}
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
                              {t(`audit.severities.${log.severity}`, {
                                defaultValue: log.severity,
                              })}
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
          )}

          {/* Cargar más */}
          {!loadError && hasMore && !loading && (
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
          <DataPagination state={pagination} entityNamePlural={t("audit.entityNamePlural")} />
        </CardContent>
      </Card>

      {/* ── Dialog de detalle ── */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detail && SEVERITY_ICONS[detail.severity]}
              <span>{detail ? actionLabel(detail.action) : ""}</span>
            </DialogTitle>
          </DialogHeader>

          {detail && (
            <div className="space-y-4 text-sm">
              {/* Cabecera del evento */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
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

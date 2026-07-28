/**
 * Docente — informes parametrizables.
 *
 * Una sola pantalla con:
 *   - Lista de plantillas disponibles: globales (Admin) + overrides
 *     propios + privadas propias. Cada fila trae origen (badge),
 *     scope, y acciones según el tipo.
 *   - Botón "Nueva privada" → editor en blanco.
 *   - Por fila:
 *       · Generar → modal de selector curso/alumno → preview HTML en
 *         iframe → botón "Imprimir / Guardar como PDF".
 *       · Personalizar (solo en globales sin override del curso elegido) →
 *         abre editor pre-rellenado para crear override.
 *       · Editar / Eliminar (solo en propias / overrides propios).
 */
import { createFileRoute } from "@tanstack/react-router";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ModuleGuard } from "@/shared/components/ModuleGuard";
import { friendlyError } from "@/shared/lib/db-errors";
import { useTableSort } from "@/hooks/use-table-sort";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  FileBarChart,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Play,
  Printer,
  GitBranch,
  FileText,
  FileType,
  Globe,
  Lock,
  Upload,
  History,
} from "lucide-react";
import { StatCard } from "@/components/ui/stat-card";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  TemplateEditor,
  composeTemplateHtml,
  emptyDraft,
  draftEqual,
  type TemplateDraft,
} from "@/modules/reports/TemplateEditor";
import {
  renderTemplate,
  buildAiReportPrompt,
  buildSampleReportContext,
  reportCatalogForScope,
  type TemplateContext,
} from "@/modules/reports/template-engine";
import { useTenant } from "@/modules/tenants/use-tenant";
import { buildReportContext, buildReportContextFromActa } from "@/modules/reports/report-context";
import { parseDocxBundle, extractPlaceholders } from "@/modules/reports/docx-import";
import { ActasManager } from "@/modules/reports/ActasManager";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { DateCell } from "@/components/ui/date-cell";
import { downloadReportAsWord, printReportHtml, fileStamp } from "@/modules/reports/report-download";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

// Sentinel para "sin curso" en el Select de asociación de plantillas
// privadas — Radix Select no admite SelectItem con value="".
const NONE_COURSE = "__none__";

/**
 * Cede un frame al navegador para que PINTE el estado "Preparando archivo…"
 * antes de que `htmlToDocxBlob` / `printReportHtml` (síncronos) bloqueen el
 * hilo principal. Sin esto el spinner se seteaba en el state pero nunca
 * llegaba a la pantalla en informes grandes (imágenes del .docx).
 */
function yieldToPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "undefined") {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}

export const Route = createFileRoute("/app/teacher/reports")({ component: TeacherReports });

type Template = {
  id: string;
  name: string;
  description: string | null;
  scope: "estudiante" | "curso";
  body_html: string;
  header_html: string | null;
  footer_html: string | null;
  css: string | null;
  page_orientation: "portrait" | "landscape";
  page_size: "A4" | "letter";
  owner_id: string | null;
  course_id: string | null;
  parent_id: string | null;
  updated_at: string | null;
};

type Course = { id: string; name: string };
type Student = { id: string; full_name: string; institutional_email: string };

// Informe GENERADO persistido (historial). Es un snapshot del HTML compuesto
// + metadatos de qué plantilla/curso/estudiante/periodo lo originó.
type GeneratedReport = {
  id: string;
  template_name: string;
  scope: "estudiante" | "curso";
  course_id: string;
  course_name: string | null;
  student_name: string | null;
  periodo: string | null;
  html: string;
  created_at: string;
};

type Origin = "global" | "override" | "privada";

function originOf(t: Template): Origin {
  if (t.owner_id != null) return "privada";
  if (t.course_id != null && t.parent_id != null) return "override";
  return "global";
}

function originBadge(origin: Origin, courseName?: string) {
  if (origin === "global") {
    return <Badge variant="secondary" className="text-xs">{i18n.t("hc_routesAppTeacherReports.badgeGlobal")}</Badge>;
  }
  if (origin === "override") {
    return (
      <Badge
        variant="outline"
        className="text-xs border-violet-300 text-violet-700 dark:border-violet-500/50 dark:text-violet-300"
      >
        {i18n.t("hc_routesAppTeacherReports.badgeCustom")}{courseName ? ` · ${courseName}` : ""}
      </Badge>
    );
  }
  return <Badge variant="outline" className="text-xs">{i18n.t("hc_routesAppTeacherReports.badgePrivate")}</Badge>;
}

function TeacherReports() {
  return (
    <ModuleGuard module="reports">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<"all" | Origin>("all");

  // Tab activa: "plantillas" (gestionar blueprints) | "informes" (historial de
  // informes generados + actas). Separación de conceptos Plantilla ≠ Informe.
  const [tab, setTab] = useState<"plantillas" | "informes">("plantillas");

  // Historial de informes generados (tab "Informes generados").
  const [genReports, setGenReports] = useState<GeneratedReport[]>([]);
  const [genReportsLoading, setGenReportsLoading] = useState(true);
  const [genReportsError, setGenReportsError] = useState<string | null>(null);
  // Acciones de fila (duplicar / eliminar plantilla, re-descargar o borrar
  // un informe del historial): sin esto el docente clickeaba 3 veces
  // "Duplicar" y terminaba con 3 copias.
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [histBusyId, setHistBusyId] = useState<string | null>(null);
  // Re-descargar del historial se dispara desde un menú que se CIERRA: no
  // queda ningún botón donde poner el Spinner → overlay.
  const [histPreparing, setHistPreparing] = useState(false);
  // Importar .docx: parseo del ZIP OOXML en el navegador, puede tardar.
  const [docxImporting, setDocxImporting] = useState(false);
  // Descarga del informe generado. Word arma el OOXML en el hilo principal
  // y PDF abre el diálogo de impresión — ambos merecen feedback.
  const [genDownload, setGenDownload] = useState<"word" | "pdf" | null>(null);
  // Id del informe ya persistido para el preview actual — evita duplicar la
  // fila si el docente descarga Word Y PDF de la misma generación. Se resetea
  // al generar un preview nuevo.
  const [genSavedId, setGenSavedId] = useState<string | null>(null);

  // Editor state (compartido entre nueva privada / override / editar)
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft());
  const [original, setOriginal] = useState<TemplateDraft>(emptyDraft());
  const [editorMode, setEditorMode] =
    useState<"new_private" | "new_override" | "edit_private" | "edit_override">("new_private");
  const [editorCourseId, setEditorCourseId] = useState<string>("");
  const [editorParentId, setEditorParentId] = useState<string | null>(null);
  const [editorTemplateId, setEditorTemplateId] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);

  // Generador state
  const [genOpen, setGenOpen] = useState(false);
  const [genTemplate, setGenTemplate] = useState<Template | null>(null);
  const [genCourseId, setGenCourseId] = useState<string>("");
  const [genStudentId, setGenStudentId] = useState<string>("");
  const [genPeriodo, setGenPeriodo] = useState<string>("");
  const [genStudents, setGenStudents] = useState<Student[]>([]);
  const [genLoadingStudents, setGenLoadingStudents] = useState(false);
  const [genHtml, setGenHtml] = useState<string | null>(null);
  const [genBuilding, setGenBuilding] = useState(false);
  // Si el docente abrió el generador desde "Imprimir acta" en
  // ActasManager, este id apunta al snapshot inmutable. Cuando está
  // presente, handleGenerate lee del snapshot en vez de datos vivos.
  const [genActaId, setGenActaId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Importar .docx → cargar como plantilla privada editable inline.
  const docxInputRef = useRef<HTMLInputElement>(null);

  // Marca del tenant para RENDERIZAR la vista previa (logo + nombre reales);
  // el resto de variables se rellenan con datos de muestra.
  const { tenant } = useTenant();
  const previewContext = useMemo(
    () =>
      buildSampleReportContext(
        tenant
          ? {
              institucion: {
                nombre: tenant.name,
                ...(tenant.logo_url ? { logo: tenant.logo_url } : {}),
              },
            }
          : undefined,
      ),
    [tenant],
  );

  // `isCancelled` opcional: cuando el effect lo pasa, evitamos setState
  // después de que el componente se desmontó (convención del repo).
  const load = async (isCancelled?: () => boolean) => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    const [{ data: ts, error: tErr }, { data: cs, error: cErr }] = await Promise.all([
      db
        .from("report_templates")
        .select(
          "id, name, description, scope, body_html, header_html, footer_html, css, page_orientation, page_size, owner_id, course_id, parent_id, updated_at",
        )
        .order("name"),
      db.from("courses").select("id, name").is("deleted_at", null).order("name"),
    ]);
    if (isCancelled?.()) return;
    if (tErr) {
      setLoadError(friendlyError(tErr, "No pudimos cargar las plantillas."));
      setLoading(false);
      return;
    }
    if (cErr) {
      setLoadError(friendlyError(cErr, "No pudimos cargar tus cursos."));
      setLoading(false);
      return;
    }
    setTemplates((ts ?? []) as Template[]);
    setCourses((cs ?? []) as Course[]);
    setLoading(false);
  };

  // Historial de informes generados. Si la tabla no existe en este entorno
  // (migración 20260975 sin Publish) o la RLS rechaza, mostramos ErrorState
  // con "Reintentar" en el área del historial — antes fallaba en silencio y
  // parecía "todavía no generaste informes".
  const loadGenReports = async (isCancelled?: () => boolean) => {
    if (!user) return;
    setGenReportsLoading(true);
    setGenReportsError(null);
    const { data, error } = await db
      .from("generated_reports")
      .select("id, template_name, scope, course_id, course_name, student_name, periodo, html, created_at")
      .order("created_at", { ascending: false })
      .limit(200);
    if (isCancelled?.()) return;
    if (error) {
      setGenReportsError(
        friendlyError(
          error,
          i18n.t("hc_routesAppTeacherReports.genLoadError", {
            defaultValue: "No pudimos cargar el historial de informes generados.",
          }),
        ),
      );
      setGenReports([]);
    } else {
      setGenReports((data ?? []) as GeneratedReport[]);
    }
    setGenReportsLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    void load(isCancelled);
    void loadGenReports(isCancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  const courseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of courses) m.set(c.id, c.name);
    return m;
  }, [courses]);

  const filtered = useMemo(() => {
    let result = templates;
    if (originFilter !== "all") {
      result = result.filter((t) => originOf(t) === originFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [templates, search, originFilter]);

  // Flujo obligatorio del design system: filtrar → ORDENAR → paginar.
  // Los accessors de `origin` y `scope` devuelven las etiquetas traducidas
  // para que el orden coincida con lo que muestran los badges de la columna.
  const sort = useTableSort(filtered, {
    columns: {
      name: (tpl) => tpl.name,
      origin: (tpl) => {
        const o = originOf(tpl);
        if (o === "global") return t("hc_routesAppTeacherReports.filterGlobal");
        if (o === "override") return t("hc_routesAppTeacherReports.filterCustom");
        return t("hc_routesAppTeacherReports.filterPrivate");
      },
      scope: (tpl) =>
        tpl.scope === "curso"
          ? t("hc_routesAppTeacherReports.scopeCourse")
          : t("hc_routesAppTeacherReports.scopeStudent"),
      description: (tpl) => tpl.description ?? "",
      updated_at: (tpl) => tpl.updated_at,
    },
    defaultSort: { key: "name", dir: "asc" },
    storageKey: "examlab_sort:teacher_reports_templates",
  });

  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_reports_templates",
    resetKey: `${search}|${originFilter}|${sort.resetKey}`,
  });

  // Stats compactas — patrón 4-card compartido con el resto de los
  // módulos. Distinguen los tres orígenes de plantilla:
  //   - Globales: gestionadas por Admin, visibles a todos los docentes.
  //   - Personalizadas: globales con override por curso (propias).
  //   - Privadas: creadas por el docente, no comparte con nadie.
  const reportStats = useMemo(() => {
    let global = 0;
    let override = 0;
    let priv = 0;
    for (const t of templates) {
      const o = originOf(t);
      if (o === "global") global += 1;
      else if (o === "override") override += 1;
      else priv += 1;
    }
    return { total: templates.length, global, override, priv };
  }, [templates]);

  // ── Editor handlers ──────────────────────────────────────────────

  const openNewPrivate = () => {
    const d = emptyDraft();
    setDraft(d);
    setOriginal(d);
    setEditorMode("new_private");
    setEditorCourseId("");
    setEditorParentId(null);
    setEditorTemplateId(null);
    setEditorOpen(true);
  };

  const openOverride = (t: Template) => {
    if (originOf(t) !== "global") return;
    const d: TemplateDraft = {
      name: i18n.t("hc_routesAppTeacherReports.customizedNameSuffix", { name: t.name }),
      description: t.description ?? "",
      scope: t.scope,
      body_html: t.body_html,
      header_html: t.header_html ?? "",
      footer_html: t.footer_html ?? "",
      css: t.css ?? "",
      page_orientation: t.page_orientation,
      page_size: t.page_size,
    };
    setDraft(d);
    setOriginal(d);
    setEditorMode("new_override");
    setEditorCourseId(courses[0]?.id ?? "");
    setEditorParentId(t.id);
    setEditorTemplateId(null);
    setEditorOpen(true);
  };

  const openEdit = (t: Template) => {
    const d: TemplateDraft = {
      name: t.name,
      description: t.description ?? "",
      scope: t.scope,
      body_html: t.body_html,
      header_html: t.header_html ?? "",
      footer_html: t.footer_html ?? "",
      css: t.css ?? "",
      page_orientation: t.page_orientation,
      page_size: t.page_size,
    };
    setDraft(d);
    setOriginal(d);
    const o = originOf(t);
    setEditorMode(o === "override" ? "edit_override" : "edit_private");
    setEditorCourseId(t.course_id ?? "");
    setEditorParentId(t.parent_id);
    setEditorTemplateId(t.id);
    setEditorOpen(true);
  };

  const closeEditor = async () => {
    if (!draftEqual(draft, original)) {
      const ok = await confirm({
        title: t("hc_routesAppTeacherReports.discardChangesTitle"),
        description: t("hc_routesAppTeacherReports.discardChangesDesc"),
        confirmLabel: t("hc_routesAppTeacherReports.discardConfirm"),
        tone: "warning",
      });
      if (!ok) return;
    }
    setEditorOpen(false);
  };

  // Garantiza un nombre de plantilla ÚNICO (auto-sufija "(2)", "(3)"… si choca
  // con otra plantilla ya existente). El usuario pidió nombres únicos.
  const uniqueTemplateName = (desired: string, excludeId: string | null): string => {
    const taken = new Set(
      templates.filter((tpl) => tpl.id !== excludeId).map((tpl) => tpl.name.trim().toLowerCase()),
    );
    const baseName = desired.trim() || i18n.t("hc_routesAppTeacherReports.importedDocName", { defaultValue: "Plantilla" });
    if (!taken.has(baseName.toLowerCase())) return baseName;
    for (let i = 2; i < 999; i++) {
      const cand = `${baseName} (${i})`;
      if (!taken.has(cand.toLowerCase())) return cand;
    }
    return `${baseName} (${templates.length + 1})`;
  };

  const handleSave = async () => {
    if (!user) return;
    if (editorSaving) return; // anti doble-submit
    if (!draft.name.trim()) {
      toast.error(i18n.t("toast.routes_app_teacher_reports.nameRequired", { defaultValue: "El nombre es obligatorio" }));
      return;
    }
    if (!draft.body_html.trim()) {
      toast.error(i18n.t("toast.routes_app_teacher_reports.bodyEmpty", { defaultValue: "El cuerpo no puede estar vacío" }));
      return;
    }
    if (
      (editorMode === "new_override" || editorMode === "edit_override") &&
      !editorCourseId
    ) {
      toast.error(i18n.t("toast.routes_app_teacher_reports.selectCourseForOverride", { defaultValue: "Selecciona el curso para la personalización" }));
      return;
    }

    setEditorSaving(true);
    const finalName = uniqueTemplateName(draft.name.trim(), editorTemplateId);
    if (finalName !== draft.name.trim()) {
      toast.info(
        i18n.t("toast.routes_app_teacher_reports.nameAdjusted", {
          defaultValue: 'Ya existía una plantilla con ese nombre; se guardó como "{{name}}".',
          name: finalName,
        }),
      );
    }
    const base = {
      name: finalName,
      description: draft.description.trim() || null,
      scope: draft.scope,
      body_html: draft.body_html,
      header_html: draft.header_html || null,
      footer_html: draft.footer_html || null,
      css: draft.css || null,
      page_orientation: draft.page_orientation,
      page_size: draft.page_size,
      updated_by: user.id,
    };

    let payload: Record<string, unknown>;
    if (editorMode === "new_private" || editorMode === "edit_private") {
      payload = {
        ...base,
        owner_id: user.id,
        // Asociación OPCIONAL a un curso: si el docente eligió uno, queda
        // ligada (el generador la pre-selecciona y se agrupa por curso); si
        // no, queda reutilizable en cualquier curso (course_id NULL).
        course_id: editorCourseId || null,
        parent_id: null,
      };
    } else {
      payload = {
        ...base,
        owner_id: null,
        course_id: editorCourseId,
        parent_id: editorParentId,
      };
    }

    try {
      const { error } = editorTemplateId
        ? await db.from("report_templates").update(payload).eq("id", editorTemplateId)
        : await db.from("report_templates").insert({ ...payload, created_by: user.id });
      if (error) {
        toast.error(friendlyError(
            error,
            t("toast.routes_app_teacher_reports.saveTemplateError", {
              defaultValue: "No se pudo guardar la plantilla",
            }),
          ));
        return;
      }
      toast.success(
        editorTemplateId
          ? i18n.t("toast.routes_app_teacher_reports.templateUpdated", { defaultValue: "Plantilla actualizada" })
          : i18n.t("toast.routes_app_teacher_reports.templateCreated", { defaultValue: "Plantilla creada" }),
      );
      setEditorOpen(false);
      void load();
    } catch (e) {
      // Sin este catch, un fallo de red dejaba el botón "Guardando…" para
      // siempre y el docente no sabía si se guardó.
      toast.error(friendlyError(
          e,
          t("toast.routes_app_teacher_reports.saveTemplateError", {
            defaultValue: "No se pudo guardar la plantilla",
          }),
        ));
    } finally {
      setEditorSaving(false);
    }
  };

  const handleDelete = async (tpl: Template) => {
    if (originOf(tpl) === "global") return; // no puede borrar globales
    if (rowBusyId) return; // anti doble-submit
    const ok = await confirm({
      title: t("hc_routesAppTeacherReports.deleteTemplateTitle", { name: tpl.name }),
      description: t("hc_routesAppTeacherReports.deleteTemplateDesc"),
      confirmLabel: t("hc_routesAppTeacherReports.deleteConfirm"),
      tone: "destructive",
    });
    if (!ok) return;
    setRowBusyId(tpl.id);
    try {
      const { error } = await db.from("report_templates").delete().eq("id", tpl.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(i18n.t("toast.routes_app_teacher_reports.templateDeleted", { defaultValue: "Plantilla eliminada" }));
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setRowBusyId(null);
    }
  };

  const handleDuplicate = async (t: Template) => {
    if (!user) return;
    if (rowBusyId) return; // anti doble-submit: duplicar 2 veces crea 2 copias
    // Duplicar siempre como privada propia — no tiene sentido duplicar
    // una global como global (eso es solo Admin).
    const payload = {
      name: i18n.t("hc_routesAppTeacherReports.copyNameSuffix", { name: t.name }),
      description: t.description,
      scope: t.scope,
      body_html: t.body_html,
      header_html: t.header_html,
      footer_html: t.footer_html,
      css: t.css,
      page_orientation: t.page_orientation,
      page_size: t.page_size,
      owner_id: user.id,
      course_id: null,
      parent_id: null,
      created_by: user.id,
      updated_by: user.id,
    };
    setRowBusyId(t.id);
    try {
      const { error } = await db.from("report_templates").insert(payload);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(i18n.t("toast.routes_app_teacher_reports.templateDuplicated", { defaultValue: "Plantilla duplicada como privada" }));
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setRowBusyId(null);
    }
  };

  // ── Importar .docx ────────────────────────────────────────────────

  // Un .docx es un ZIP OOXML. parseDocxToText (fflate) extrae el texto del
  // cuerpo; lo cargamos como body de una nueva plantilla PRIVADA que el
  // docente edita inline (mismo editor/textarea) e inserta {{variables}}.
  const handleDocxFile = async (file: File) => {
    if (!user) return;
    if (docxImporting) return; // anti doble-submit
    setDocxImporting(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Convertimos a HTML preservando formato básico (párrafos, encabezados,
      // negrita/itálica, tablas), CABECERA/PIE e IMÁGENES (logo) embebidas —
      // así el Word cargado se ve completo en el editor/preview y al exportar,
      // y el docente solo agrega los {{placeholders}}.
      const { bodyHtml, headerHtml, footerHtml } = parseDocxBundle(bytes);
      if (!bodyHtml.trim() && !headerHtml.trim() && !footerHtml.trim()) {
        toast.error(
          i18n.t("toast.routes_app_teacher_reports.docxEmpty", {
            defaultValue: "El documento no contiene texto que importar.",
          }),
        );
        return;
      }
      const baseName = file.name.replace(/\.docx$/i, "").trim() || i18n.t("hc_routesAppTeacherReports.importedDocName");
      // Nombre ÚNICO también al IMPORTAR: si ya existe una plantilla con ese
      // nombre, se crea una NUEVA con sufijo (no se entra en modo edición de la
      // existente — esto es siempre una plantilla privada nueva).
      const d: TemplateDraft = {
        ...emptyDraft(),
        name: uniqueTemplateName(baseName, null),
        description: i18n.t("toast.routes_app_teacher_reports.docxImportedDesc", {
          defaultValue: "Importado de un Word (.docx)",
        }),
        // HTML con formato preservado; el docente edita inline e inserta las
        // {{variables}} del catálogo (la "lógica" del informe).
        body_html: bodyHtml,
        header_html: headerHtml,
        footer_html: footerHtml,
      };
      setDraft(d);
      setOriginal(emptyDraft());
      setEditorMode("new_private");
      setEditorCourseId("");
      setEditorParentId(null);
      setEditorTemplateId(null);
      setEditorOpen(true);

      const placeholders = extractPlaceholders(`${bodyHtml}\n${headerHtml}\n${footerHtml}`);
      toast.success(
        placeholders.length > 0
          ? i18n.t("toast.routes_app_teacher_reports.docxImportedWithVars", {
              defaultValue: "Documento importado. Se detectaron {{count}} variable(s): {{vars}}",
              count: placeholders.length,
              vars: placeholders.join(", "),
            })
          : i18n.t("toast.routes_app_teacher_reports.docxImported", {
              defaultValue: "Documento importado. Edítalo e inserta variables del panel derecho.",
            }),
      );
    } catch (e) {
      // `parseDocxBundle` lanza mensajes de dominio ya en español ("El archivo
      // supera el tamaño máximo…"): los pasamos por friendlyError (traduce el
      // ruido de red/permisos y deja pasar los nuestros) y solo caemos al
      // texto genérico cuando el error no trae mensaje.
      const detail = e instanceof Error ? e.message.trim() : "";
      toast.error(
        detail
          ? friendlyError(e)
          : i18n.t("toast.routes_app_teacher_reports.docxImportError", {
              defaultValue: "No se pudo importar el documento.",
            }),
      );
    } finally {
      setDocxImporting(false);
    }
  };

  const onDocxInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset para permitir re-importar el mismo archivo.
    e.target.value = "";
    if (file) void handleDocxFile(file);
  };

  // ── Generación IA INLINE (insertar en el cursor) ──────────────────
  //
  // Callback que TemplateEditor invoca cuando el docente abre "Generación IA"
  // desde el panel de variables (situando antes el cursor en el cuerpo). Arma
  // el prompt con datos REALES del curso y lo manda al edge `ai-generate-report`
  // (la API key vive como secret). Devuelve el HTML generado para que el editor
  // lo inserte EXACTAMENTE donde está el cursor. Si el edge falla, cae al
  // fallback de copiar el prompt al portapapeles y devuelve null.
  const aiGenerate = async ({
    instruction,
    courseId,
    studentId,
  }: {
    instruction: string;
    courseId: string;
    studentId?: string;
  }): Promise<string | null> => {
    let system = "";
    let userMsg = "";
    try {
      const ctx = await buildReportContext({ courseId, studentId: studentId || undefined });
      // draftText vacío a propósito: la generación es de un FRAGMENTO para
      // insertar en el cursor, no una reescritura del informe entero. Mandar
      // el body completo (que puede traer imágenes embebidas del .docx) era la
      // causa del error `prompt_too_large` (>200K chars en el edge).
      ({ system, user: userMsg } = buildAiReportPrompt({
        draftText: "",
        instruction,
        ctx,
        // Variables que la IA puede usar = las del scope del informe (curso vs
        // estudiante), igual que el panel derecho.
        catalog: reportCatalogForScope(draft.scope),
      }));
    } catch (e) {
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.routes_app_teacher_reports.aiGenerateError", {
            defaultValue: "No se pudo preparar la generación con IA.",
          }),
        ),
      );
      return null;
    }

    // 1) Intento principal: el edge corre la IA y devuelve el contenido.
    try {
      const { data, error } = await db.functions.invoke("ai-generate-report", {
        body: { system, user: userMsg, courseId },
      });
      const content = typeof data?.content === "string" ? data.content.trim() : "";
      if (!error && content) {
        toast.success(
          i18n.t("toast.routes_app_teacher_reports.aiGenerated", {
            defaultValue: "Contenido generado e insertado donde tenías el cursor.",
          }),
        );
        return content;
      }
      if (error) console.warn("[reports][ai-generate-report]", error);
    } catch (e) {
      console.warn("[reports][ai-generate-report] invoke failed", e);
    }

    // 2) Fallback: copiar el prompt al portapapeles para usarlo en una IA
    //    externa (degrada con gracia si la IA no está configurada/saturada).
    const prompt = `### SYSTEM\n${system}\n\n### USER\n${userMsg}`;
    let copied = false;
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
    } catch {
      copied = false;
    }
    toast.warning(
      copied
        ? i18n.t("toast.routes_app_teacher_reports.aiFallbackCopied", {
            defaultValue:
              "No se pudo generar con la IA de la plataforma. Copiamos el prompt (con los datos del curso) al portapapeles — pégalo en tu IA y trae el resultado al editor.",
          })
        : i18n.t("toast.routes_app_teacher_reports.aiFallbackReady", {
            defaultValue:
              "No se pudo generar con la IA de la plataforma. El prompt quedó en la consola del navegador.",
          }),
      { duration: 12000 },
    );
    if (!copied) {
      // eslint-disable-next-line no-console
      console.info("[reports][ai-prompt]\n", prompt);
    }
    return null;
  };

  // ── Vista previa con datos REALES (no mock) ───────────────────────
  // El editor previsualiza con datos de un curso (y un estudiante, en scope
  // 'estudiante') que el docente elige. buildReportContext trae los datos
  // reales (notas, asistencia, lista de estudiantes). Si falla (curso sin
  // alumnos, etc.), devolvemos null → el editor cae al contexto de muestra.
  const loadPreviewContext = async ({
    courseId,
    studentId,
  }: {
    courseId: string;
    studentId?: string;
  }): Promise<TemplateContext | null> => {
    try {
      return await buildReportContext({ courseId, studentId: studentId || undefined });
    } catch {
      return null;
    }
  };

  const loadCourseStudents = async (
    courseId: string,
  ): Promise<{ id: string; full_name: string }[]> => {
    // Los errores acá dejaban el selector de estudiantes vacío sin decir
    // nada: el docente creía que el curso no tenía matriculados.
    const { data: ens, error: ensErr } = await db
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    if (ensErr) {
      toast.error(friendlyError(ensErr, t("hc_routesAppTeacherReports.studentsLoadError", {
        defaultValue: "No pudimos cargar los estudiantes del curso.",
      })));
      return [];
    }
    const ids = (ens ?? []).map((e: { user_id: string }) => e.user_id);
    if (ids.length === 0) return [];
    const { data: profs, error: profsErr } = await db
      .from("profiles")
      .select("id, full_name")
      .in("id", ids)
      .order("full_name");
    if (profsErr) {
      toast.error(friendlyError(profsErr, t("hc_routesAppTeacherReports.studentsLoadError", {
        defaultValue: "No pudimos cargar los estudiantes del curso.",
      })));
      return [];
    }
    return (profs ?? []) as { id: string; full_name: string }[];
  };

  // ── Generador handlers ───────────────────────────────────────────

  const openGenerate = (t: Template) => {
    setGenTemplate(t);
    // Si el template tiene course_id fijo (override), usar ese
    const defaultCourse = t.course_id ?? courses[0]?.id ?? "";
    setGenCourseId(defaultCourse);
    setGenStudentId("");
    setGenPeriodo("");
    setGenStudents([]);
    setGenHtml(null);
    // Generación normal (no desde acta) — limpia el actaId para
    // forzar el path 'datos vivos'.
    setGenActaId(null);
    setGenOpen(true);
  };

  // Click en "Imprimir acta" desde ActasManager: busca la plantilla
  // seed "Acta de finalización del curso" y abre el generador con
  // el curso y periodo del acta pre-seleccionados.
  const handlePrintActa = (acta: {
    id: string;
    course_id: string;
    periodo_codigo: string | null;
  }) => {
    const actaTpl = templates.find(
      (t) => t.name === "Acta de finalización del curso" && t.owner_id == null && t.course_id == null,
    );
    if (!actaTpl) {
      toast.error(
        i18n.t("toast.routes_app_teacher_reports.actaTemplateNotFound", {
          defaultValue:
            "No se encontró la plantilla 'Acta de finalización del curso'. Pídele al admin que la publique.",
        }),
      );
      return;
    }
    setGenTemplate(actaTpl);
    setGenCourseId(acta.course_id);
    setGenStudentId("");
    setGenPeriodo(acta.periodo_codigo ?? "");
    setGenStudents([]);
    setGenHtml(null);
    // El actaId activa el path inmutable: handleGenerate leerá del
    // snapshot en lugar de gradebook en vivo. El docente puede
    // imprimir la misma acta mañana y obtener exactamente las mismas
    // notas, aunque haya editado el gradebook entre tanto.
    setGenActaId(acta.id);
    setGenOpen(true);
  };

  // Cargar alumnos del curso cuando cambia el curso seleccionado y
  // scope='estudiante' (no necesitamos lista de alumnos para scope='curso')
  useEffect(() => {
    if (!genOpen || !genTemplate || genTemplate.scope !== "estudiante" || !genCourseId) {
      setGenStudents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setGenLoadingStudents(true);
      const { data: enr, error: enrErr } = await db
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", genCourseId);
      if (cancelled) return;
      if (enrErr) {
        // Antes el fallo era invisible: el Select quedaba vacío y parecía
        // "curso sin estudiantes".
        toast.error(
          friendlyError(
            enrErr,
            t("hc_routesAppTeacherReports.studentsLoadError", {
              defaultValue: "No pudimos cargar los estudiantes del curso.",
            }),
          ),
        );
        setGenStudents([]);
        setGenLoadingStudents(false);
        return;
      }
      const ids = ((enr ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
      if (ids.length === 0) {
        setGenStudents([]);
        setGenLoadingStudents(false);
        return;
      }
      const { data: profs, error: profsErr } = await db
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", ids)
        .order("full_name");
      if (cancelled) return;
      if (profsErr) {
        toast.error(
          friendlyError(
            profsErr,
            t("hc_routesAppTeacherReports.studentsLoadError", {
              defaultValue: "No pudimos cargar los estudiantes del curso.",
            }),
          ),
        );
        setGenStudents([]);
        setGenLoadingStudents(false);
        return;
      }
      setGenStudents((profs ?? []) as Student[]);
      setGenLoadingStudents(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genOpen, genTemplate, genCourseId]);

  const handleGenerate = async () => {
    if (!genTemplate || !genCourseId) return;
    if (genBuilding) return; // anti doble-submit
    if (genTemplate.scope === "estudiante" && !genStudentId) {
      toast.error(i18n.t("toast.routes_app_teacher_reports.selectStudent", { defaultValue: "Selecciona un estudiante" }));
      return;
    }
    setGenBuilding(true);
    try {
      const ctx = genActaId
        ? await buildReportContextFromActa(genActaId)
        : await buildReportContext({
            courseId: genCourseId,
            studentId: genTemplate.scope === "estudiante" ? genStudentId : undefined,
            periodo: genPeriodo.trim() || undefined,
          });
      const renderedBody = renderTemplate(genTemplate.body_html, ctx);
      const renderedHeader = genTemplate.header_html
        ? renderTemplate(genTemplate.header_html, ctx)
        : "";
      const renderedFooter = genTemplate.footer_html
        ? renderTemplate(genTemplate.footer_html, ctx)
        : "";
      const html = composeTemplateHtml({
        body_html: renderedBody,
        header_html: renderedHeader,
        footer_html: renderedFooter,
        css: genTemplate.css ?? "",
        page_orientation: genTemplate.page_orientation,
        page_size: genTemplate.page_size,
      });
      setGenHtml(html);
      // Preview nuevo → el informe aún no se guardó como descargable.
      setGenSavedId(null);
    } catch (e) {
      toast.error(
        friendlyError(e, i18n.t("toast.routes_app_teacher_reports.generateReportError", { defaultValue: "Error al generar el informe" })),
      );
    } finally {
      // `finally` y no una línea suelta: si algo lanza fuera del catch, el
      // botón no puede quedarse en "Generando…" para siempre.
      setGenBuilding(false);
    }
  };

  // Metadatos del informe generado (para nombre de archivo + persistencia).
  const genMeta = () => {
    const studentName =
      genTemplate?.scope === "estudiante"
        ? (genStudents.find((s) => s.id === genStudentId)?.full_name ?? null)
        : null;
    return {
      templateName: genTemplate?.name ?? "Informe",
      courseName: courseNameById.get(genCourseId) ?? null,
      studentName,
      periodo: genPeriodo.trim() || null,
    };
  };

  // Persiste el informe generado en el historial (una sola vez por preview).
  // Best-effort: si la tabla no existe / RLS rechaza, no bloquea la descarga
  // — pero AVISAMOS, porque si no el docente cree que quedó en el historial.
  const persistGeneration = async () => {
    if (!genHtml || !genTemplate || !genCourseId || genSavedId) return;
    const meta = genMeta();
    const { data, error } = await db
      .from("generated_reports")
      .insert({
        template_id: genTemplate.id,
        template_name: genTemplate.name,
        scope: genTemplate.scope,
        course_id: genCourseId,
        course_name: meta.courseName,
        student_id: genTemplate.scope === "estudiante" ? genStudentId || null : null,
        student_name: meta.studentName,
        periodo: meta.periodo,
        acta_id: genActaId,
        html: genHtml,
        page_orientation: genTemplate.page_orientation,
        page_size: genTemplate.page_size,
      })
      .select("id")
      .single();
    if (error || !data) {
      toast.warning(
        i18n.t("toast.routes_app_teacher_reports.persistFailed", {
          defaultValue:
            "El archivo se descargó, pero no pudimos guardarlo en “Informes generados”.",
        }),
      );
      return;
    }
    setGenSavedId(data.id as string);
    void loadGenReports();
  };

  const handleDownloadWord = async () => {
    if (!genHtml) return;
    if (genDownload) return; // anti doble-submit
    setGenDownload("word");
    try {
      // Armar el OOXML corre en el hilo principal: con informes grandes
      // (imágenes del .docx) tarda y antes no había ningún indicador.
      await yieldToPaint();
      downloadReportAsWord(genHtml, { ...genMeta(), stamp: fileStamp(new Date()) });
      await persistGeneration();
    } catch (e) {
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.routes_app_teacher_reports.downloadWordError", {
            defaultValue: "No se pudo generar el archivo Word.",
          }),
        ),
      );
    } finally {
      setGenDownload(null);
    }
  };

  const handleDownloadPdf = async () => {
    if (!genHtml) return;
    if (genDownload) return; // anti doble-submit
    setGenDownload("pdf");
    try {
      await yieldToPaint();
      printReportHtml(genHtml);
      await persistGeneration();
    } catch (e) {
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.routes_app_teacher_reports.downloadPdfError", {
            defaultValue: "No se pudo preparar el PDF para imprimir.",
          }),
        ),
      );
    } finally {
      setGenDownload(null);
    }
  };

  // ── Historial: re-descarga / eliminación de informes generados ──
  // Ambas re-descargas son síncronas pero pueden tardar (HTML grande) y
  // pueden lanzar: sin el try/catch el fallo era invisible (nada pasaba al
  // hacer click). `histBusyId` bloquea el menú de esa fila mientras corre.
  const reDownloadWord = async (r: GeneratedReport) => {
    if (histBusyId) return;
    setHistBusyId(r.id);
    setHistPreparing(true);
    try {
      await yieldToPaint();
      downloadReportAsWord(r.html, {
        templateName: r.template_name,
        courseName: r.course_name,
        studentName: r.student_name,
        periodo: r.periodo,
        stamp: fileStamp(new Date(r.created_at)),
      });
    } catch (e) {
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.routes_app_teacher_reports.downloadWordError", {
            defaultValue: "No se pudo generar el archivo Word.",
          }),
        ),
      );
    } finally {
      setHistBusyId(null);
      setHistPreparing(false);
    }
  };
  const reDownloadPdf = async (r: GeneratedReport) => {
    if (histBusyId) return;
    setHistBusyId(r.id);
    setHistPreparing(true);
    try {
      await yieldToPaint();
      printReportHtml(r.html);
    } catch (e) {
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.routes_app_teacher_reports.downloadPdfError", {
            defaultValue: "No se pudo preparar el PDF para imprimir.",
          }),
        ),
      );
    } finally {
      setHistBusyId(null);
      setHistPreparing(false);
    }
  };
  const deleteGenReport = async (r: GeneratedReport) => {
    if (histBusyId) return; // anti doble-submit
    const ok = await confirm({
      title: i18n.t("hc_routesAppTeacherReports.genDeleteTitle", { defaultValue: "Eliminar informe generado" }),
      description: i18n.t("hc_routesAppTeacherReports.genDeleteDesc", {
        defaultValue: "Se quitará del historial. Esta acción no se puede deshacer.",
      }),
      confirmLabel: i18n.t("hc_routesAppTeacherReports.actionDelete", { defaultValue: "Eliminar" }),
      tone: "destructive",
    });
    if (!ok) return;
    setHistBusyId(r.id);
    try {
      const { error } = await db.from("generated_reports").delete().eq("id", r.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setGenReports((prev) => prev.filter((x) => x.id !== r.id));
      // Antes no había confirmación de éxito: la fila desaparecía y listo.
      toast.success(
        i18n.t("toast.routes_app_teacher_reports.genReportDeleted", {
          defaultValue: "Informe eliminado del historial",
        }),
      );
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setHistBusyId(null);
    }
  };

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      {/* Re-descarga desde el historial: el menú ya se cerró, así que el
          feedback tiene que ser un overlay. */}
      {histPreparing && (
        <LoadingOverlay
          title={t("hc_routesAppTeacherReports.preparingFile", {
            defaultValue: "Preparando archivo…",
          })}
          subtitle={t("hc_routesAppTeacherReports.preparingFileHint", {
            defaultValue: "Puede tomar unos segundos con informes extensos.",
          })}
        />
      )}
      <PageHeader
        icon={<FileBarChart className="h-6 w-6 text-pink-500" />}
        title={t("hc_routesAppTeacherReports.pageTitle")}
        subtitle={loading ? undefined : t("hc_routesAppTeacherReports.templatesAvailable", { count: templates.length })}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => docxInputRef.current?.click()}
              disabled={docxImporting}
            >
              {docxImporting ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Upload className="h-4 w-4 mr-1" />
              )}
              {docxImporting
                ? t("hc_routesAppTeacherReports.importingWord", {
                    defaultValue: "Importando…",
                  })
                : t("hc_routesAppTeacherReports.uploadWord")}
            </Button>
            <Button onClick={openNewPrivate}>
              <Plus className="h-4 w-4 mr-1" />
              {t("hc_routesAppTeacherReports.newTemplate")}
            </Button>
          </div>
        }
      />

      {/* Input oculto para importar .docx (se dispara desde el botón). */}
      <input
        ref={docxInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={onDocxInputChange}
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="plantillas">
            <FileText className="h-4 w-4 mr-1.5" />
            {t("hc_routesAppTeacherReports.tabTemplates", { defaultValue: "Plantillas" })}
          </TabsTrigger>
          <TabsTrigger value="informes">
            <History className="h-4 w-4 mr-1.5" />
            {t("hc_routesAppTeacherReports.tabGenerated", { defaultValue: "Informes generados" })}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="plantillas" className="space-y-5 mt-4">
          {/* Stats 4-card — patrón compartido (Videos, Cursos, Pizarras, etc.).
              Aparece SIEMPRE — un 0 es informativo, no ruido. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard icon={FileText} label={t("hc_routesAppTeacherReports.statTotal")} value={reportStats.total} />
            <StatCard icon={Globe} label={t("hc_routesAppTeacherReports.statGlobal")} value={reportStats.global} />
            <StatCard
              icon={GitBranch}
              label={t("hc_routesAppTeacherReports.statCustom")}
              value={reportStats.override}
              tone={reportStats.override > 0 ? "success" : "default"}
            />
            <StatCard icon={Lock} label={t("hc_routesAppTeacherReports.statPrivate")} value={reportStats.priv} />
          </div>

          <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("hc_routesAppTeacherReports.searchPlaceholder")}
              />
            </div>
            <Select
              value={originFilter}
              onValueChange={(v) => setOriginFilter(v as typeof originFilter)}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("hc_routesAppTeacherReports.filterAllOrigins")}</SelectItem>
                <SelectItem value="global">{t("hc_routesAppTeacherReports.filterGlobal")}</SelectItem>
                <SelectItem value="override">{t("hc_routesAppTeacherReports.filterCustom")}</SelectItem>
                <SelectItem value="privada">{t("hc_routesAppTeacherReports.filterPrivate")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            {loading ? (
              /* TableSkeleton emite <tr>: suelto en un <div> el navegador lo
                 descarta y la pantalla quedaba VACÍA mientras cargaba. */
              <Table fixed>
                <TableBody>
                  <TableSkeleton cols={6} rows={5} />
                </TableBody>
              </Table>
            ) : loadError ? (
              <ErrorState
                message={t("hc_routesAppTeacherReports.loadErrorMessage")}
                hint={loadError}
                onRetry={() => setRetryNonce((n) => n + 1)}
              />
            ) : (
              <Table fixed resizable>
                <TableHeader>
                  <TableRow>
                    <SortableHead sortKey="name" sort={sort} className="min-w-[180px]">
                      {t("hc_routesAppTeacherReports.colName")}
                    </SortableHead>
                    <SortableHead
                      sortKey="origin"
                      sort={sort}
                      className="hidden sm:table-cell w-40"
                    >
                      {t("hc_routesAppTeacherReports.colOrigin")}
                    </SortableHead>
                    <SortableHead sortKey="scope" sort={sort} className="w-28">
                      {t("hc_routesAppTeacherReports.colType")}
                    </SortableHead>
                    <SortableHead
                      sortKey="description"
                      sort={sort}
                      className="hidden md:table-cell w-[280px]"
                    >
                      {t("hc_routesAppTeacherReports.colDescription")}
                    </SortableHead>
                    <SortableHead
                      sortKey="updated_at"
                      sort={sort}
                      className="hidden lg:table-cell w-40"
                    >
                      {t("hc_routesAppTeacherReports.colUpdated", { defaultValue: "Actualizada" })}
                    </SortableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sort.sorted.length === 0 ? (
                    (() => {
                      // Distinguir "aún no hay plantillas" de "los filtros no
                      // dejan pasar ninguna".
                      const noMatch =
                        (!!search.trim() || originFilter !== "all") && templates.length > 0;
                      return (
                        <TableEmpty
                          colSpan={6}
                          text={
                            noMatch
                              ? t("common.noResults")
                              : t("hc_routesAppTeacherReports.emptyTitle")
                          }
                          hint={
                            noMatch
                              ? t("common.tryClearFilter")
                              : t("hc_routesAppTeacherReports.emptyHint")
                          }
                        />
                      );
                    })()
                  ) : (
                    pagination.paginatedItems.map((tpl) => {
                      const origin = originOf(tpl);
                      return (
                        <TableRow key={tpl.id}>
                          <TableCell className="font-medium">
                            <div className="truncate" title={tpl.name}>
                              {tpl.name}
                            </div>
                          </TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {originBadge(
                              origin,
                              tpl.course_id ? courseNameById.get(tpl.course_id) : undefined,
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {tpl.scope === "curso" ? t("hc_routesAppTeacherReports.scopeCourse") : t("hc_routesAppTeacherReports.scopeStudent")}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                            <div className="truncate" title={tpl.description ?? undefined}>
                              {tpl.description ?? "—"}
                            </div>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <DateCell value={tpl.updated_at} variant="datetime" />
                          </TableCell>
                          <TableCell className="text-right">
                            <RowActionsMenu
                              actions={[
                                {
                                  label: t("hc_routesAppTeacherReports.actionGenerate"),
                                  icon: Play,
                                  onClick: () => openGenerate(tpl),
                                },
                                origin === "global" && {
                                  label: t("hc_routesAppTeacherReports.actionCustomize"),
                                  icon: GitBranch,
                                  onClick: () => openOverride(tpl),
                                  separatorBefore: true,
                                },
                                origin !== "global" && {
                                  label: t("hc_routesAppTeacherReports.actionEdit"),
                                  icon: Pencil,
                                  onClick: () => openEdit(tpl),
                                  separatorBefore: true,
                                },
                                {
                                  label: t("hc_routesAppTeacherReports.actionDuplicate"),
                                  icon: Copy,
                                  disabled: !!rowBusyId,
                                  onClick: () => void handleDuplicate(tpl),
                                },
                                origin !== "global" && {
                                  label: t("hc_routesAppTeacherReports.actionDelete"),
                                  icon: Trash2,
                                  tone: "destructive",
                                  separatorBefore: true,
                                  disabled: !!rowBusyId,
                                  onClick: () => void handleDelete(tpl),
                                },
                              ]}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            )}
          </div>
          {!loading && !loadError && sort.sorted.length > 0 && (
            <DataPagination
              state={pagination}
              entityNamePlural={t("hc_routesAppTeacherReports.entityPlural", {
                defaultValue: "plantillas",
              })}
            />
          )}
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="informes" className="space-y-5 mt-4">
          {/* Actas oficiales (snapshots inmutables) — son un tipo especial de
              informe generado, viven en su propio flujo (course_actas). */}
          <ActasManager onPrintActa={handlePrintActa} />

          {/* Historial de informes generados (descargables) */}
          <Card>
            <CardContent className="p-4 space-y-3">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <History className="h-4 w-4 text-pink-500" />
                  {t("hc_routesAppTeacherReports.genHistoryTitle", { defaultValue: "Informes generados" })}
                </h3>
                <p className="text-[11px] text-muted-foreground">
                  {t("hc_routesAppTeacherReports.genHistoryHint", {
                    defaultValue:
                      "Cada Word/PDF que generaste desde una plantilla. Volvé a descargarlo cuando quieras.",
                  })}
                </p>
              </div>
              <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
                {genReportsLoading ? (
                  /* TableSkeleton son <tr>: necesita ir dentro de una tabla. */
                  <Table fixed>
                    <TableBody>
                      <TableSkeleton cols={5} rows={4} />
                    </TableBody>
                  </Table>
                ) : genReportsError ? (
                  <ErrorState
                    message={t("hc_routesAppTeacherReports.genLoadErrorTitle", {
                      defaultValue: "No pudimos cargar el historial",
                    })}
                    hint={genReportsError}
                    onRetry={() => void loadGenReports()}
                  />
                ) : (
                  <Table fixed>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-[160px]">{t("hc_routesAppTeacherReports.genColTemplate", { defaultValue: "Plantilla" })}</TableHead>
                        <TableHead className="hidden sm:table-cell">{t("hc_routesAppTeacherReports.genColCourse", { defaultValue: "Curso" })}</TableHead>
                        <TableHead className="hidden md:table-cell">{t("hc_routesAppTeacherReports.genColTarget", { defaultValue: "Estudiante / Periodo" })}</TableHead>
                        <TableHead className="hidden lg:table-cell w-40">{t("hc_routesAppTeacherReports.genColDate", { defaultValue: "Generado" })}</TableHead>
                        <TableHead className="w-10" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {genReports.length === 0 ? (
                        <TableEmpty
                          colSpan={5}
                          text={t("hc_routesAppTeacherReports.genEmptyTitle", { defaultValue: "Aún no generaste informes" })}
                          hint={t("hc_routesAppTeacherReports.genEmptyHint", {
                            defaultValue: "Generá uno desde una plantilla (tab “Plantillas” → Generar).",
                          })}
                        />
                      ) : (
                        genReports.map((r) => (
                          <TableRow key={r.id}>
                            <TableCell className="font-medium">
                              <div className="truncate" title={r.template_name}>{r.template_name}</div>
                            </TableCell>
                            <TableCell className="hidden sm:table-cell text-sm text-muted-foreground">
                              <div className="truncate" title={r.course_name ?? undefined}>{r.course_name ?? "—"}</div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                              <div className="truncate">
                                {r.student_name ? r.student_name : r.scope === "estudiante" ? "—" : t("hc_routesAppTeacherReports.scopeCourse")}
                                {r.periodo ? ` · ${r.periodo}` : ""}
                              </div>
                            </TableCell>
                            <TableCell className="hidden lg:table-cell">
                              <DateCell value={r.created_at} variant="datetime" />
                            </TableCell>
                            <TableCell className="text-right">
                              <RowActionsMenu
                                actions={[
                                  {
                                    label: t("hc_routesAppTeacherReports.downloadWord", { defaultValue: "Descargar Word" }),
                                    icon: FileType,
                                    disabled: !!histBusyId,
                                    onClick: () => void reDownloadWord(r),
                                  },
                                  {
                                    label: t("hc_routesAppTeacherReports.downloadPdf", { defaultValue: "Descargar PDF" }),
                                    icon: Printer,
                                    disabled: !!histBusyId,
                                    onClick: () => void reDownloadPdf(r),
                                  },
                                  {
                                    label: t("hc_routesAppTeacherReports.actionDelete", { defaultValue: "Eliminar" }),
                                    icon: Trash2,
                                    tone: "destructive",
                                    separatorBefore: true,
                                    disabled: !!histBusyId,
                                    onClick: () => void deleteGenReport(r),
                                  },
                                ]}
                              />
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ── Dialog: Editor ── */}
      <Dialog open={editorOpen} onOpenChange={(o) => !o && void closeEditor()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editorMode === "new_private" && t("hc_routesAppTeacherReports.editorTitleNewPrivate")}
              {editorMode === "new_override" && t("hc_routesAppTeacherReports.editorTitleNewOverride")}
              {editorMode === "edit_private" && t("hc_routesAppTeacherReports.editorTitleEditPrivate")}
              {editorMode === "edit_override" && t("hc_routesAppTeacherReports.editorTitleEditOverride")}
            </DialogTitle>
            {editorMode.startsWith("new_override") && (
              <DialogDescription>
                {t("hc_routesAppTeacherReports.editorOverrideDesc")}
              </DialogDescription>
            )}
          </DialogHeader>

          {editorMode === "new_override" || editorMode === "edit_override" ? (
            <div className="space-y-1">
              <Label required>{t("hc_routesAppTeacherReports.courseLabel")}</Label>
              <Select value={editorCourseId} onValueChange={setEditorCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("hc_routesAppTeacherReports.overrideCoursePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            // Plantilla privada: asociación a curso OPCIONAL. Si se elige un
            // curso, el generador lo pre-selecciona y la plantilla queda
            // ligada a él; "Sin curso" la deja reutilizable en cualquiera.
            <div className="space-y-1">
              <Label>{t("hc_routesAppTeacherReports.associatedCourseLabel")}</Label>
              <Select
                value={editorCourseId || NONE_COURSE}
                onValueChange={(v) => setEditorCourseId(v === NONE_COURSE ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_COURSE}>
                    {t("hc_routesAppTeacherReports.noCourseOption")}
                  </SelectItem>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {t("hc_routesAppTeacherReports.associatedCourseHint")}
              </p>
            </div>
          )}

          <TemplateEditor
            value={draft}
            onChange={setDraft}
            previewContext={previewContext}
            onAiGenerate={aiGenerate}
            courses={courses}
            loadPreviewContext={loadPreviewContext}
            loadCourseStudents={loadCourseStudents}
          />

          <DialogFooter>
            <Button variant="outline" onClick={() => void closeEditor()} disabled={editorSaving}>
              {t("hc_routesAppTeacherReports.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={editorSaving}>
              {editorSaving && <Spinner size="sm" className="mr-2" />}
              {editorSaving ? t("hc_routesAppTeacherReports.saving") : t("hc_routesAppTeacherReports.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Generador ── */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-6xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("hc_routesAppTeacherReports.genDialogTitle", { name: genTemplate?.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {genTemplate?.scope === "curso"
                ? t("hc_routesAppTeacherReports.genDescCourse")
                : t("hc_routesAppTeacherReports.genDescStudent")}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label required>{t("hc_routesAppTeacherReports.courseLabel")}</Label>
              <Select
                value={genCourseId}
                onValueChange={(v) => {
                  setGenCourseId(v);
                  setGenStudentId("");
                  setGenHtml(null);
                }}
                disabled={!!genTemplate?.course_id}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("hc_routesAppTeacherReports.selectCoursePlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {genTemplate?.scope === "estudiante" && (
              <div className="space-y-1">
                <Label required>{t("hc_routesAppTeacherReports.studentLabel")}</Label>
                <Select
                  value={genStudentId}
                  onValueChange={(v) => {
                    setGenStudentId(v);
                    setGenHtml(null);
                  }}
                  disabled={!genCourseId || genLoadingStudents}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={genLoadingStudents ? t("hc_routesAppTeacherReports.loading") : t("hc_routesAppTeacherReports.selectStudentPlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {genStudents.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <Label>{t("hc_routesAppTeacherReports.periodLabel")}</Label>
              <Input
                value={genPeriodo}
                onChange={(e) => {
                  setGenPeriodo(e.target.value);
                  // El periodo va al render — si cambia, el preview ya no
                  // corresponde a esa selección. Lo limpiamos para forzar
                  // al docente a regenerar antes de imprimir.
                  if (genHtml) setGenHtml(null);
                }}
                placeholder={t("hc_routesAppTeacherReports.periodPlaceholder")}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void handleGenerate()}
              disabled={
                genBuilding ||
                !genCourseId ||
                (genTemplate?.scope === "estudiante" && !genStudentId)
              }
            >
              {genBuilding ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              {genBuilding
                ? t("hc_routesAppTeacherReports.generating")
                : t("hc_routesAppTeacherReports.previewBtn", { defaultValue: "Vista previa" })}
            </Button>
            {genHtml && (
              <>
                <Button onClick={() => void handleDownloadWord()} disabled={!!genDownload}>
                  {genDownload === "word" ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <FileType className="h-4 w-4 mr-1" />
                  )}
                  {genDownload === "word"
                    ? t("hc_routesAppTeacherReports.preparingFile", {
                        defaultValue: "Preparando archivo…",
                      })
                    : t("hc_routesAppTeacherReports.downloadWord", { defaultValue: "Descargar Word" })}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void handleDownloadPdf()}
                  disabled={!!genDownload}
                >
                  {genDownload === "pdf" ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <Printer className="h-4 w-4 mr-1" />
                  )}
                  {genDownload === "pdf"
                    ? t("hc_routesAppTeacherReports.preparingFile", {
                        defaultValue: "Preparando archivo…",
                      })
                    : t("hc_routesAppTeacherReports.downloadPdf", { defaultValue: "Descargar PDF" })}
                </Button>
              </>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground -mt-1">
            {t("hc_routesAppTeacherReports.generateHint", {
              defaultValue:
                "Generá el archivo descargable (Word o PDF) con tus ajustes. Cada descarga queda en “Informes generados”.",
            })}
          </p>

          {genHtml && (
            <div className="border rounded-md overflow-hidden bg-white">
              <iframe
                ref={iframeRef}
                title={t("hc_routesAppTeacherReports.previewTitle")}
                srcDoc={genHtml}
                className="w-full h-[60dvh]"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

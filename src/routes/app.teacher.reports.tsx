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
import { useActiveRole } from "@/hooks/use-active-role";
import { fetchScopedCourses } from "@/modules/courses/course-scope";
import { CourseSelect } from "@/modules/courses/CourseSelect";
import { sortCoursesByPriority } from "@/modules/courses/course-status";
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
import { cn } from "@/shared/lib/utils";
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
import { SendToSignDialog } from "@/modules/reports/SendToSignDialog";
import { conEstilosDeDocumento } from "@/modules/reports/document-css";
import { renderizarRanuras, type FirmaDeInforme } from "@/modules/reports/signature-slots";
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
  PenLine,
  RefreshCw,
  Eye,
  EyeOff,
  Link2,
  Link2Off,
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
import {
  buildReportContext,
  buildReportContextFromActa,
  type FocoEvaluacion,
} from "@/modules/reports/report-context";
import { pidePlantillaEvaluacion } from "@/modules/reports/plantilla-lint";
import {
  baseMasNueva,
  contarCambios,
  diffPlantillas,
  soloCambios,
  type LineaDiff,
} from "@/modules/reports/plantilla-diff";
import type { FocoTipo } from "@/modules/reports/foco-evaluacion";
import { parseDocxBundle, extractPlaceholders } from "@/modules/reports/docx-import";
import { ActasManager } from "@/modules/reports/ActasManager";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Checkbox } from "@/components/ui/checkbox";
import { DateCell } from "@/components/ui/date-cell";
import { formatDateTime } from "@/shared/lib/format";
import { downloadReportAsWord, printReportHtml, fileStamp } from "@/modules/reports/report-download";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/**
 * Cede un frame al navegador para que PINTE el estado "Preparando archivo…"
 * antes de que `htmlToDocxBlob` / `printReportHtml` (síncronos) bloqueen el
 * hilo principal. Sin esto el spinner se seteaba en el state pero nunca
 * llegaba a la pantalla en informes grandes (imágenes del .docx).
 */
/**
 * Las diferencias entre la base y la copia del docente, en el cuerpo, la
 * cabecera y el pie.
 *
 * Se muestran SOLO las líneas que cambiaron con una de contexto: un diff completo
 * de una plantilla son cientos de líneas iguales y las tres que importan quedan
 * enterradas. El HTML se muestra como texto (es lo que el docente edita en la
 * pestaña HTML), no renderizado: renderizarlo esconde justo lo que cambió.
 */
function DiffPlantilla({ base, propia }: { base: Template; propia: Template }) {
  const { t } = useTranslation();
  const secciones = useMemo(
    () =>
      (
        [
          ["body", base.body_html, propia.body_html],
          ["header", base.header_html, propia.header_html],
          ["footer", base.footer_html, propia.footer_html],
          ["css", base.css, propia.css],
        ] as const
      )
        .map(([clave, b, p]) => {
          const completo = diffPlantillas(b, p);
          return {
            clave,
            lineas: soloCambios(completo, 1),
            cambios: contarCambios(completo),
          };
        })
        .filter((s) => s.lineas.length > 0),
    [base, propia],
  );

  const rotulo: Record<string, string> = {
    body: t("hc_modulesReportsTemplateEditor.tabBody"),
    header: t("hc_modulesReportsTemplateEditor.tabHeader"),
    footer: t("hc_modulesReportsTemplateEditor.tabFooter"),
    css: "CSS",
  };

  if (secciones.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("reportBase.diffEmpty", {
          defaultValue:
            "El contenido es el mismo. La base se actualizó, pero no cambió nada de lo que tu plantilla usa.",
        })}
      </p>
    );
  }

  const clase = (l: LineaDiff) =>
    l.tipo === "agregada"
      ? "text-emerald-700 dark:text-emerald-400 bg-emerald-500/10"
      : l.tipo === "quitada"
        ? "text-destructive bg-destructive/10"
        : "text-muted-foreground";

  return (
    <div className="space-y-3">
      {secciones.map((s) => (
        <div key={s.clave} className="space-y-1">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            {rotulo[s.clave]}
            <span className="ml-2 normal-case tabular-nums font-normal">
              {t("reportBase.diffCounts", {
                nuevas: s.cambios.agregadas,
                faltantes: s.cambios.quitadas,
                defaultValue: "{{nuevas}} tuyas · {{faltantes}} de la base",
              })}
            </span>
          </p>
          <div className="rounded-md border overflow-x-auto">
            {s.lineas.map((l, i) => (
              <div
                key={`${s.clave}-${i}`}
                className={cn("font-mono text-3xs whitespace-pre px-2 py-0.5", clase(l))}
              >
                {(l.tipo === "agregada" ? "+ " : l.tipo === "quitada" ? "- " : "  ") + l.texto}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

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

type Course = { id: string; name: string; status?: string | null };
type Student = { id: string; full_name: string; institutional_email: string };

// Informe GENERADO persistido (historial). Es un snapshot del HTML compuesto
// + metadatos de qué plantilla/curso/estudiante/periodo lo originó.
type GeneratedReport = {
  id: string;
  template_name: string;
  scope: "estudiante" | "curso";
  course_id: string;
  course_name: string | null;
  /** De quién es el informe, cuando es por estudiante. Lo usa "enviar a firmar". */
  student_id: string | null;
  student_name: string | null;
  periodo: string | null;
  html: string;
  created_at: string;
  /** Token del enlace publico del DOCUMENTO. Distinto del token por firmante. */
  public_token: string | null;
  public_enabled: boolean | null;
};

/** Una evaluación del curso, para elegir el foco del informe. */
type EvaluacionElegible = { tipo: FocoTipo; id: string; titulo: string };

/** Cómo se nombra cada clase de actividad en el selector. */
const ETIQUETA_FOCO: Record<FocoTipo, () => string> = {
  examen: () => i18n.t("hc_routesAppTeacherReports.focoTipoExamen", { defaultValue: "Examen" }),
  taller: () => i18n.t("hc_routesAppTeacherReports.focoTipoTaller", { defaultValue: "Taller" }),
  proyecto: () =>
    i18n.t("hc_routesAppTeacherReports.focoTipoProyecto", { defaultValue: "Proyecto" }),
};

/** Clave del Select del foco: el tipo y el id en un solo valor. */
function focoKey(f: { tipo: FocoTipo; id: string }): string {
  return `${f.tipo}:${f.id}`;
}
function parseFocoKey(k: string): FocoEvaluacion | null {
  const i = k.indexOf(":");
  if (i < 0) return null;
  const tipo = k.slice(0, i);
  const id = k.slice(i + 1);
  if (tipo !== "examen" && tipo !== "taller" && tipo !== "proyecto") return null;
  if (!id) return null;
  return { tipo, id };
}

/**
 * Plantillas base que el docente decidió dejar como están, por si la plataforma
 * las cambia. Vive en el navegador de cada uno: es una comodidad de lectura
 * ("ya lo vi"), no un dato del curso, y no vale una columna ni una migración.
 */
const CLAVE_IGNORADAS = "examlab_reportbase_vistas";

function leerIgnoradas(): Record<string, string> {
  try {
    const raw = localStorage.getItem(CLAVE_IGNORADAS);
    const obj = raw ? JSON.parse(raw) : null;
    return obj && typeof obj === "object" ? (obj as Record<string, string>) : {};
  } catch {
    return {};
  }
}

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
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
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

  /** Informe elegido para enviar a firmar. `null` = diálogo cerrado. */
  const [firmarInforme, setFirmarInforme] = useState<{
    id: string;
    courseId: string;
    nombre: string;
    /** Solo en un informe POR ESTUDIANTE: de quién es. */
    studentId: string | null;
  } | null>(null);
  /**
   * Plantillas base que el docente marcó como "ya lo vi", con la fecha de la base
   * en ese momento. Se lee POST-mount y nunca en el inicializador del estado: leer
   * `localStorage` en el primer render hace que el árbol difiera del pre-renderizado
   * (React #418).
   */
  const [baseVistas, setBaseVistas] = useState<Record<string, string>>({});
  useEffect(() => {
    setBaseVistas(leerIgnoradas());
  }, []);
  /** Plantilla personalizada abierta en el comparador. `null` = cerrado. */
  const [comparar, setComparar] = useState<{ propia: Template; base: Template } | null>(null);

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
  /**
   * Periodo RESUELTO del curso, no tecleado por el docente.
   *
   * Antes el diálogo pedía "Periodo" a mano y eso era pedirle un dato que la
   * plataforma ya tiene: el curso conoce su periodo (`period_id` → el código
   * del periodo académico, o `period` como texto). Un campo libre solo permitía
   * escribirlo distinto de como figura en el curso, y el documento salía
   * diciendo una cosa mientras el sistema decía otra. Se guarda lo que devolvió
   * el contexto para que el NOMBRE del archivo lo incluya.
   */
  const [genPeriodo, setGenPeriodo] = useState<string>("");
  const [genStudents, setGenStudents] = useState<Student[]>([]);
  const [genLoadingStudents, setGenLoadingStudents] = useState(false);
  /**
   * Quiénes quedan FUERA del informe de curso.
   *
   * Se guardan los EXCLUIDOS y no los incluidos: el informe habla del curso, así
   * que por defecto va todo el mundo. Con una lista de incluidos, quien se
   * matricule después de que el docente la armó quedaría afuera en silencio y el
   * documento diría "Total de estudiantes: 20" sobre un curso de 21.
   *
   * No se persiste: es una decisión de ESTA generación. Guardarla haría que un
   * informe generado meses después excluyera a alguien por un motivo que nadie
   * recuerda, sin nada en pantalla que lo explique.
   */
  const [genExcluidos, setGenExcluidos] = useState<Set<string>>(new Set());
  // Evaluación elegida (el "foco"): solo se pide cuando la plantilla habla de
  // una. La MISMA plantilla sirve para cualquier prueba; qué prueba es se decide
  // acá, al generar, no al redactarla.
  const [genEvaluaciones, setGenEvaluaciones] = useState<EvaluacionElegible[]>([]);
  const [genLoadingEvaluaciones, setGenLoadingEvaluaciones] = useState(false);
  const [genFocoKey, setGenFocoKey] = useState<string>("");
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
      // El docente ve SOLO los cursos que dicta (ver course-scope.ts).
      fetchScopedCourses<Course>(activeRole, roles, user.id, "id, name, status"),
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
      .select("id, template_name, scope, course_id, course_name, student_id, student_name, periodo, html, created_at, public_token, public_enabled")
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
  }, [user, activeRole, roles, retryNonce]);

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
    // El primero por PRIORIDAD y no el primero alfabetico: fetchScopedCourses
    // ordena solo por nombre, y hay docentes con todos sus cursos finalizados o
    // con uno activo que alfabeticamente cae ultimo. Preseleccionar un curso
    // cerrado obliga a corregirlo a mano en cada personalizacion.
    setEditorCourseId(sortCoursesByPriority(courses)[0]?.id ?? "");
    setEditorParentId(t.id);
    setEditorTemplateId(null);
    setEditorOpen(true);
  };

  // ── La plantilla base cambió ─────────────────────────────────────
  //
  // Una plantilla personalizada es una COPIA de la global. Cuando la plataforma
  // corrige la base —un dato mal puesto, una sección nueva—, la copia se queda
  // atrás y hoy nadie se enteraba: el docente sigue generando el documento viejo.
  const baseDe = (tpl: Template): Template | null =>
    tpl.parent_id ? (templates.find((x) => x.id === tpl.parent_id) ?? null) : null;

  /** ¿La base cambió después de esta copia, y el docente no lo marcó como visto? */
  const baseCambio = (tpl: Template): boolean => {
    const base = baseDe(tpl);
    if (!base) return false;
    if (!baseMasNueva(base.updated_at, tpl.updated_at)) return false;
    return baseVistas[tpl.id] !== (base.updated_at ?? "");
  };

  /** "Ya lo vi": deja de avisar hasta que la base vuelva a cambiar. */
  const ignorarCambioBase = (tpl: Template) => {
    const base = baseDe(tpl);
    if (!base) return;
    const siguiente = { ...baseVistas, [tpl.id]: base.updated_at ?? "" };
    setBaseVistas(siguiente);
    try {
      localStorage.setItem(CLAVE_IGNORADAS, JSON.stringify(siguiente));
    } catch {
      // Navegador sin almacenamiento (ventana privada): el aviso vuelve a
      // aparecer la próxima vez, que es preferible a romper la acción.
    }
  };

  /** Traer los cambios de la base: PISA lo que el docente editó. */
  const traerCambiosBase = async (tpl: Template) => {
    const base = baseDe(tpl);
    if (!base || rowBusyId) return;
    const ok = await confirm({
      title: t("reportBase.pullTitle", { defaultValue: "¿Traer los cambios de la base?" }),
      description: t("reportBase.pullDesc", {
        defaultValue:
          "El contenido de tu plantilla personalizada se reemplaza por el de la plantilla base. Lo que hayas escrito en ella se pierde. El nombre y el curso no cambian.",
      }),
      confirmLabel: t("reportBase.pullConfirm", { defaultValue: "Traer los cambios" }),
      tone: "warning",
    });
    if (!ok) return;
    setRowBusyId(tpl.id);
    const { error } = await db
      .from("report_templates")
      .update({
        body_html: base.body_html,
        header_html: base.header_html,
        footer_html: base.footer_html,
        css: base.css,
        page_orientation: base.page_orientation,
        page_size: base.page_size,
        scope: base.scope,
      })
      .eq("id", tpl.id);
    setRowBusyId(null);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(t("reportBase.pullOk", { defaultValue: "Tu plantilla quedó igual a la base." }));
    await load();
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

    // ── Elegir el curso NO es personalizar ────────────────────────────────
    //
    // "Personalizar para un curso" abre este editor con una copia del contenido
    // de la plantilla global. Si el docente solo elige el curso y guarda, la copia
    // queda IDÉNTICA a la base y no aporta nada: se suma para siempre a la lista,
    // hay que mantenerla sincronizada cuando la plataforma corrija la global, y
    // duplica el nombre con "(personalizada)". Medido en producción: las 2
    // personalizadas que existían eran byte-idénticas a su global (10.259 y 12.848
    // caracteres, iguales al carácter).
    //
    // Lo que el docente quería era GENERAR el informe para su curso, así que se lo
    // abre directo. `editorCourseId` NO forma parte de `TemplateDraft` —el curso es
    // estado aparte—, y por eso `draftEqual` es verdadero justamente en este caso.
    //
    // Solo en `new_override`: sobre una personalizada que YA existe, guardar sin
    // cambios es un UPDATE inocuo, y borrarla sería una sorpresa desagradable.
    if (editorMode === "new_override" && draftEqual(draft, original)) {
      const global = templates.find((x) => x.id === editorParentId) ?? null;
      if (global) {
        const cursoElegido = editorCourseId;
        setEditorOpen(false);
        toast.info(
          i18n.t("toast.routes_app_teacher_reports.overrideSinCambios", {
            defaultValue:
              "No cambiaste el contenido, así que no se creó una plantilla nueva: se abre el generador para tu curso.",
          }),
        );
        openGenerate(global, cursoElegido);
        return;
      }
      // Sin la global a mano no se puede abrir el generador; se guarda como antes
      // antes que dejar al docente sin salida.
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

  const openGenerate = (t: Template, cursoPreferido?: string) => {
    setGenTemplate(t);
    // Si el template tiene course_id fijo (override), usar ese. `cursoPreferido`
    // es para cuando se llega acá desde "personalizar sin cambiar nada": el curso
    // que el docente ya eligió no se le puede pedir dos veces.
    const defaultCourse =
      t.course_id ?? cursoPreferido ?? sortCoursesByPriority(courses)[0]?.id ?? "";
    setGenCourseId(defaultCourse);
    setGenStudentId("");
    setGenPeriodo("");
    setGenStudents([]);
    setGenHtml(null);
    setGenFocoKey("");
    setGenEvaluaciones([]);
    setGenExcluidos(new Set());
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
    // También en scope 'curso': la lista alimenta la caja de "estudiantes
    // incluidos". Antes solo se cargaba en scope 'estudiante', donde es el Select
    // del destinatario.
    if (!genOpen || !genTemplate || !genCourseId) {
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

  /**
   * ¿Esta plantilla habla de una evaluación concreta?
   *
   * Se deduce del cuerpo —igual que `tieneRanuras` deduce si el documento se
   * puede firmar— y no de una columna: así no hay una bandera que pueda quedar en
   * desacuerdo con la plantilla que el docente acaba de editar.
   */
  const genNecesitaFoco = useMemo(
    () =>
      !!genTemplate &&
      pidePlantillaEvaluacion(
        genTemplate.body_html,
        genTemplate.header_html,
        genTemplate.footer_html,
      ),
    [genTemplate],
  );

  // Evaluaciones del curso para elegir el foco. Se excluyen las de la papelera y
  // los borradores: un borrador no tiene entregas y su peso todavía no cuenta
  // para la nota, así que el informe saldría vacío y con la nota en "—".
  useEffect(() => {
    if (!genOpen || !genNecesitaFoco || !genCourseId) {
      setGenEvaluaciones([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setGenLoadingEvaluaciones(true);
      const noBorrador = (s: string | null | undefined) => (s ?? "published") !== "draft";
      const [ex, wc, pc] = await Promise.all([
        db
          .from("exams")
          .select("id, title, status, parent_exam_id")
          .eq("course_id", genCourseId)
          .is("deleted_at", null),
        db
          .from("workshop_courses")
          .select("workshop:workshops(id, title, status, deleted_at)")
          .eq("course_id", genCourseId),
        db
          .from("project_courses")
          .select("project:projects(id, title, status, deleted_at)")
          .eq("course_id", genCourseId),
      ]);
      if (cancelled) return;
      const errores = [ex.error, wc.error, pc.error].filter(Boolean);
      if (errores.length > 0) {
        toast.error(
          friendlyError(
            errores[0],
            t("hc_routesAppTeacherReports.focoLoadError", {
              defaultValue: "No pudimos cargar las evaluaciones del curso.",
            }),
          ),
        );
        setGenEvaluaciones([]);
        setGenLoadingEvaluaciones(false);
        return;
      }
      const lista: EvaluacionElegible[] = [];
      for (const e of (ex.data ?? []) as Array<{
        id: string;
        title: string;
        status: string | null;
        parent_exam_id: string | null;
      }>) {
        // Las recuperaciones se cuentan dentro del examen original (así lo hace
        // el libro de notas), así que no se ofrecen por separado.
        if (e.parent_exam_id) continue;
        if (!noBorrador(e.status)) continue;
        lista.push({ tipo: "examen", id: e.id, titulo: e.title });
      }
      for (const r of (wc.data ?? []) as Array<{
        workshop: { id: string; title: string; status: string | null; deleted_at: string | null } | null;
      }>) {
        const w = r.workshop;
        if (!w || w.deleted_at || !noBorrador(w.status)) continue;
        lista.push({ tipo: "taller", id: w.id, titulo: w.title });
      }
      for (const r of (pc.data ?? []) as Array<{
        project: { id: string; title: string; status: string | null; deleted_at: string | null } | null;
      }>) {
        const p2 = r.project;
        if (!p2 || p2.deleted_at || !noBorrador(p2.status)) continue;
        lista.push({ tipo: "proyecto", id: p2.id, titulo: p2.title });
      }
      setGenEvaluaciones(lista);
      setGenFocoKey((prev) => (lista.some((x) => focoKey(x) === prev) ? prev : ""));
      setGenLoadingEvaluaciones(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genOpen, genNecesitaFoco, genCourseId]);

  const handleGenerate = async () => {
    if (!genTemplate || !genCourseId) return;
    if (genBuilding) return; // anti doble-submit
    if (genTemplate.scope === "estudiante" && !genStudentId) {
      toast.error(i18n.t("toast.routes_app_teacher_reports.selectStudent", { defaultValue: "Selecciona un estudiante" }));
      return;
    }
    if (genNecesitaFoco && !parseFocoKey(genFocoKey)) {
      toast.error(
        i18n.t("toast.routes_app_teacher_reports.selectFoco", {
          defaultValue: "Elegí la evaluación de la que habla este informe",
        }),
      );
      return;
    }
    setGenBuilding(true);
    try {
      const ctx = genActaId
        ? await buildReportContextFromActa(genActaId)
        : await buildReportContext({
            courseId: genCourseId,
            studentId: genTemplate.scope === "estudiante" ? genStudentId : undefined,
            // Sin `periodo`: el contexto lo toma del curso.
            foco: genNecesitaFoco ? (parseFocoKey(genFocoKey) ?? undefined) : undefined,
            // Solo en scope 'curso': en un informe POR ESTUDIANTE el
            // destinatario ES el informe, y excluirlo dejaría un documento sin
            // nadie.
            excludeStudentIds:
              genTemplate.scope === "curso" && genExcluidos.size > 0
                ? [...genExcluidos]
                : undefined,
          });
      // Se guarda el resuelto para el nombre del archivo.
      if (typeof ctx.periodo === "string") setGenPeriodo(ctx.periodo);
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
  //
  // DEVUELVE el id: "Enviar a firmar" lo necesita inmediatamente después, y leer
  // `genSavedId` justo tras el await no sirve porque el setState de React todavía
  // no se aplicó.
  const persistGeneration = async (
    // El aviso de fallo cambia según quién llame: desde una descarga el archivo SÍ
    // se bajó, desde "Enviar a firmar" no se bajó nada y decir que sí confunde.
    mensajeFallo?: string,
  ): Promise<string | null> => {
    if (!genHtml || !genTemplate || !genCourseId) return null;
    if (genSavedId) return genSavedId;
    const meta = genMeta();
    const fila = {
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
    };
    // De qué evaluación habla el informe: sin esto, al re-descargarlo un mes
    // después no hay forma de saber de cuál era.
    const f = genNecesitaFoco ? parseFocoKey(genFocoKey) : null;
    let { data, error } = await db
      .from("generated_reports")
      .insert(f ? { ...fila, foco_tipo: f.tipo, foco_id: f.id } : fila)
      .select("id")
      .single();
    // Entorno donde la migración de esas dos columnas todavía no corrió: se
    // guarda el informe SIN la referencia en vez de perder la generación entera.
    // Es trazabilidad, no el documento.
    if (error && f && /foco_(tipo|id)/.test(String(error.message ?? ""))) {
      ({ data, error } = await db
        .from("generated_reports")
        .insert(fila)
        .select("id")
        .single());
    }
    if (error || !data) {
      toast.warning(
        mensajeFallo ??
          i18n.t("toast.routes_app_teacher_reports.persistFailed", {
            defaultValue:
              "El archivo se descargó, pero no pudimos guardarlo en “Informes generados”.",
          }),
      );
      return null;
    }
    setGenSavedId(data.id as string);
    void loadGenReports();
    return data.id as string;
  };

  // ── Enviar a firmar desde el diálogo de Generar ──────────────────────
  //
  // Firmar necesita un informe PERSISTIDO: lo que se firma es el snapshot de HTML,
  // y el hash de la firma se calcula sobre él. Así que esta acción primero guarda
  // el informe (o reusa el que ya se guardó en esta misma generación) y después
  // abre el diálogo de envío. Antes esto solo se podía hacer desde la pestaña
  // "Informes generados", o sea que había que generar, cambiar de pestaña y buscar
  // la fila — con el documento ya en pantalla.
  const [genSending, setGenSending] = useState(false);
  const handleSendToSign = async () => {
    if (!genHtml || !genTemplate || !genCourseId) return;
    setGenSending(true);
    try {
      const id = await persistGeneration(
        i18n.t("reportSign.persistFailed", {
          defaultValue:
            "No pudimos guardar el informe, así que todavía no se puede mandar a firmar.",
        }),
      );
      if (!id) return;
      setFirmarInforme({
        id,
        courseId: genCourseId,
        nombre: genTemplate.name,
        studentId: genTemplate.scope === "estudiante" ? genStudentId || null : null,
      });
    } finally {
      setGenSending(false);
    }
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
  /**
   * Trae las firmas PUESTAS del informe y las pinta sobre su snapshot.
   *
   * Sin esto, el docente descargaba el acuerdo y lo veía en blanco aunque el curso
   * entero hubiera firmado: el snapshot es inmutable a propósito y las firmas se
   * dibujan al mostrarlo. Es best-effort — si la consulta falla se descarga el
   * documento sin firmas, que es lo que pasaba antes, en vez de no descargar nada.
   */
  /**
   * Activa el enlace publico del DOCUMENTO y lo copia. Un solo enlace para pegar
   * en el grupo del curso.
   *
   * Es distinto del enlace por firmante que manda "Enviar a firmar": ese llega al
   * correo de cada uno y ES la credencial —quien lo tenga puede firmar en su
   * nombre—; este no identifica a nadie y solo deja LEER. Para firmar hay que
   * entrar con correo y contrasena, asi que la firma queda con sesion de verdad.
   */
  const compartirPublico = async (r: GeneratedReport) => {
    const { data, error } = await db.rpc("report_set_public", {
      _report_id: r.id,
      _enabled: true,
    });
    const res = data as { ok?: boolean; error?: string; token?: string | null } | null;
    if (error || !res?.ok || !res.token) {
      toast.error(friendlyError(error, i18n.t("publicDocument.shareError")));
      return;
    }
    const origen = typeof window !== "undefined" ? window.location.origin : "";
    const url = origen + "/documento/" + res.token;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(i18n.t("publicDocument.shareCopied"));
    } catch {
      // Si el portapapeles esta bloqueado, el enlace igual quedo activo: se
      // muestra para que se pueda copiar a mano.
      toast.success(url, { duration: 15000 });
    }
    void loadGenReports();
  };

  /** Corta el enlace publico. El que este circulando deja de abrir. */
  const cortarPublico = async (r: GeneratedReport) => {
    const ok = await confirm({
      title: i18n.t("publicDocument.revokeTitle"),
      description: i18n.t("publicDocument.revokeBody"),
      confirmLabel: i18n.t("publicDocument.revokeConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    const { data, error } = await db.rpc("report_set_public", {
      _report_id: r.id,
      _enabled: false,
    });
    const res = data as { ok?: boolean } | null;
    if (error || !res?.ok) {
      toast.error(friendlyError(error, i18n.t("publicDocument.shareError")));
      return;
    }
    toast.success(i18n.t("publicDocument.revoked"));
    void loadGenReports();
  };

  // El envoltorio va UNA sola vez acá y el cuerpo tiene sus tres salidas adentro:
  // así el día que se agregue un cuarto `return` no queda un camino que se baje o
  // se imprima sin la regla de corte de celdas.
  const conFirmas = async (r: GeneratedReport): Promise<string> =>
    conEstilosDeDocumento(await htmlConFirmas(r));

  const htmlConFirmas = async (r: GeneratedReport): Promise<string> => {
    try {
      const { data } = await db.rpc("report_signatures_of", { _report_id: r.id });
      const firmas = (Array.isArray(data) ? data : []) as FirmaDeInforme[];
      if (firmas.length === 0) return r.html;
      return renderizarRanuras(r.html, { firmas });
    } catch {
      return r.html;
    }
  };

  const reDownloadWord = async (r: GeneratedReport) => {
    if (histBusyId) return;
    setHistBusyId(r.id);
    setHistPreparing(true);
    try {
      await yieldToPaint();
      const html = await conFirmas(r);
      downloadReportAsWord(html, {
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
      printReportHtml(await conFirmas(r));
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
        icon={<FileBarChart className="h-6 w-6" />}
        title={t("hc_routesAppTeacherReports.pageTitle")}
        subtitle={loading ? undefined : t("hc_routesAppTeacherReports.templatesAvailable", { count: templates.length })}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
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
            <Button size="sm" onClick={openNewPrivate}>
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
                            {/* La base cambió después de esta copia. Va bajo el
                                nombre y no en una columna nueva: es un aviso
                                temporal, no un atributo de la plantilla. */}
                            {baseCambio(tpl) && (
                              <Badge
                                variant="outline"
                                className="mt-1 text-3xs border-warning/50 text-warning-on-subtle"
                              >
                                {t("reportBase.badge", {
                                  defaultValue: "La plantilla base cambió",
                                })}
                              </Badge>
                            )}
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
                                // Las tres acciones del aviso "la base cambió":
                                // ver qué cambió, traerlo (pisa la edición del
                                // docente) o dejar de avisar. Solo aparecen
                                // cuando hay algo que reconciliar.
                                baseCambio(tpl) && {
                                  label: t("reportBase.actionDiff", {
                                    defaultValue: "Ver qué cambió en la base",
                                  }),
                                  icon: Eye,
                                  separatorBefore: true,
                                  onClick: () => {
                                    const base = baseDe(tpl);
                                    if (base) setComparar({ propia: tpl, base });
                                  },
                                },
                                baseCambio(tpl) && {
                                  label: t("reportBase.actionPull", {
                                    defaultValue: "Traer los cambios de la base",
                                  }),
                                  icon: RefreshCw,
                                  disabled: !!rowBusyId,
                                  hint: t("reportBase.actionPullHint", {
                                    defaultValue: "Reemplaza tu contenido por el de la base.",
                                  }),
                                  onClick: () => void traerCambiosBase(tpl),
                                },
                                baseCambio(tpl) && {
                                  label: t("reportBase.actionIgnore", {
                                    defaultValue: "Dejar de avisarme",
                                  }),
                                  icon: EyeOff,
                                  onClick: () => ignorarCambioBase(tpl),
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
                <p className="text-2xs text-muted-foreground">
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
                              {/* En móvil las columnas Curso / Estudiante / Generado
                                  están ocultas (`hidden sm:table-cell`), así que dos
                                  informes de la misma plantilla se leen IGUALES y no
                                  hay forma de saber cuál es cuál. Acá va lo que los
                                  distingue, solo en el ancho donde falta. */}
                              <div className="sm:hidden text-2xs text-muted-foreground truncate">
                                {[r.course_name, r.student_name, formatDateTime(r.created_at)]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
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
                                  // Enviar a firmar necesita el curso (de ahí
                                  // sale quién puede firmar). Sirve igual para un
                                  // informe de curso y para el de un estudiante:
                                  // el flujo de firmas es la única forma en que
                                  // el estudiante ve un informe.
                                  ...(r.course_id
                                    ? [
                                        {
                                          label: t("reportSign.rowAction"),
                                          icon: PenLine,
                                          disabled: !!histBusyId,
                                          onClick: () =>
                                            setFirmarInforme({
                                              id: r.id,
                                              courseId: r.course_id,
                                              nombre: r.template_name,
                                              studentId: r.student_id,
                                            }),
                                        },
                                      ]
                                    : []),
                                  // El enlace publico del DOCUMENTO: uno solo
                                  // para el grupo del curso. Necesita curso por
                                  // lo mismo que firmar — de ahi salen los
                                  // firmantes.
                                  ...(r.course_id
                                    ? [
                                        {
                                          label: r.public_enabled
                                            ? t("publicDocument.shareAgain")
                                            : t("publicDocument.share"),
                                          icon: Link2,
                                          disabled: !!histBusyId,
                                          onClick: () => void compartirPublico(r),
                                        },
                                      ]
                                    : []),
                                  ...(r.public_enabled
                                    ? [
                                        {
                                          label: t("publicDocument.revoke"),
                                          icon: Link2Off,
                                          disabled: !!histBusyId,
                                          onClick: () => void cortarPublico(r),
                                        },
                                      ]
                                    : []),
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
              <CourseSelect
                courses={courses}
                value={editorCourseId}
                onChange={(v) => setEditorCourseId(v ?? "")}
                placeholder={t("hc_routesAppTeacherReports.overrideCoursePlaceholder")}
              />
            </div>
          ) : (
            // Plantilla privada: asociación a curso OPCIONAL. Si se elige un
            // curso, el generador lo pre-selecciona y la plantilla queda
            // ligada a él; "Sin curso" la deja reutilizable en cualquiera.
            <div className="space-y-1">
              <Label>{t("hc_routesAppTeacherReports.associatedCourseLabel")}</Label>
              {/* `editorCourseId || null` y no `editorCourseId`: CourseSelect
                  resuelve el valor con `??`, que NO atrapa el string vacío, así que
                  un "" dejaría el disparador en blanco en vez de mostrar
                  "Sin curso". */}
              <CourseSelect
                courses={courses}
                value={editorCourseId || null}
                onChange={(v) => setEditorCourseId(v ?? "")}
                includeAll
                allLabel={t("hc_routesAppTeacherReports.noCourseOption")}
              />
              <p className="text-2xs text-muted-foreground">
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
              <CourseSelect
                courses={courses}
                value={genCourseId}
                onChange={(v) => {
                  // El `if (!v)` protege el curso ya elegido: sin `includeAll` este
                  // selector no emite null, pero limpiarlo dejaría el generador sin
                  // curso y sin forma de volver.
                  if (!v) return;
                  setGenCourseId(v);
                  setGenStudentId("");
                  // Los excluidos son ids de OTRO curso: mantenerlos dejaría
                  // afuera a alguien que no se eligió.
                  setGenExcluidos(new Set());
                  // Sin esto el docente ve el HTML del curso anterior sobre el
                  // curso nuevo.
                  setGenHtml(null);
                }}
                disabled={!!genTemplate?.course_id}
                placeholder={t("hc_routesAppTeacherReports.selectCoursePlaceholder")}
              />
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

            {/* La evaluación de la que habla el informe. Solo aparece si la
                plantilla la usa: así la MISMA plantilla sirve para cualquier
                prueba y no hay que hacer una copia por parcial. */}
            {genNecesitaFoco && (
              <div className="space-y-1">
                <Label required>
                  {t("hc_routesAppTeacherReports.focoLabel", { defaultValue: "Evaluación" })}
                </Label>
                <Select
                  value={genFocoKey}
                  onValueChange={(v) => {
                    setGenFocoKey(v);
                    setGenHtml(null);
                  }}
                  disabled={!genCourseId || genLoadingEvaluaciones}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={
                        genLoadingEvaluaciones
                          ? t("hc_routesAppTeacherReports.loading")
                          : t("hc_routesAppTeacherReports.focoPlaceholder", {
                              defaultValue: "Elegí el examen, taller o proyecto",
                            })
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {genEvaluaciones.map((e) => (
                      <SelectItem key={focoKey(e)} value={focoKey(e)}>
                        {e.titulo} · {ETIQUETA_FOCO[e.tipo]()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!genLoadingEvaluaciones && genCourseId && genEvaluaciones.length === 0 && (
                  <p className="text-2xs text-muted-foreground">
                    {t("hc_routesAppTeacherReports.focoEmpty", {
                      defaultValue:
                        "Este curso todavía no tiene exámenes, talleres ni proyectos publicados.",
                    })}
                  </p>
                )}
              </div>
            )}

            {/* El campo "Periodo" se quitó: lo sabe el curso. Pedirlo a mano
                solo permitía escribirlo distinto de como figura en el sistema. */}
          </div>

          {/* Quiénes van en el informe.
              El caso real: el docente está matriculado en su propio curso para
              probarlo, y no tiene por qué figurar en el acta que firman sus
              estudiantes. Solo en scope 'curso': en un informe por estudiante el
              destinatario ES el informe. Y no cuando viene de un acta, donde la
              lista es la que quedó CONGELADA al cerrar el curso. */}
          {genTemplate?.scope === "curso" && !genActaId && genCourseId && genStudents.length > 0 && (
            <div className="rounded-md border p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium">
                  {t("hc_routesAppTeacherReports.includedStudents", {
                    defaultValue: "Estudiantes incluidos ({{n}} de {{total}})",
                    n: genStudents.length - genExcluidos.size,
                    total: genStudents.length,
                  })}
                </p>
                {genStudents.length > 1 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 text-2xs"
                    onClick={() => {
                      setGenExcluidos(
                        genExcluidos.size === 0
                          ? new Set(genStudents.map((x) => x.id))
                          : new Set(),
                      );
                      setGenHtml(null);
                    }}
                  >
                    {genExcluidos.size === 0 ? t("common.deselectAll") : t("common.selectAll")}
                  </Button>
                )}
              </div>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {genStudents.map((st) => (
                  <label
                    key={st.id}
                    className="flex items-center gap-2 rounded p-1 text-sm cursor-pointer hover:bg-accent"
                  >
                    <Checkbox
                      checked={!genExcluidos.has(st.id)}
                      onCheckedChange={(v) => {
                        setGenExcluidos((prev) => {
                          const next = new Set(prev);
                          if (v) next.delete(st.id);
                          else next.add(st.id);
                          return next;
                        });
                        // El HTML ya generado habla de otra lista de personas.
                        setGenHtml(null);
                      }}
                    />
                    <span className="truncate">{st.full_name}</span>
                  </label>
                ))}
              </div>
              {genExcluidos.size > 0 && (
                <p className="text-2xs text-muted-foreground">
                  {t("hc_routesAppTeacherReports.excludedHint", {
                    defaultValue:
                      "Los desmarcados no aparecen en el documento ni cuentan en los totales.",
                  })}
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => void handleGenerate()}
              disabled={
                genBuilding ||
                !genCourseId ||
                (genTemplate?.scope === "estudiante" && !genStudentId) ||
                (genNecesitaFoco && !genFocoKey)
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
                {/* También en un informe POR ESTUDIANTE: es el canal real de
                    entrega —el estudiante ve un informe solo por el flujo de
                    firmas— y ahora la firma puede ir en cualquier lugar del
                    documento, no solo dentro de la tabla del listado de curso.
                    Antes esto estaba limitado a los informes de curso y dejaba
                    afuera justo el caso de darle a cada uno su informe. */}
                <Button
                  variant="outline"
                  onClick={() => void handleSendToSign()}
                  disabled={!!genDownload || genSending}
                >
                  {genSending ? (
                    <Spinner size="sm" className="mr-1" />
                  ) : (
                    <PenLine className="h-4 w-4 mr-1" />
                  )}
                  {t("reportSign.rowAction")}
                </Button>
              </>
            )}
          </div>
          <p className="text-2xs text-muted-foreground -mt-1">
            {t("hc_routesAppTeacherReports.generateHint", {
              defaultValue:
                "Generá el archivo descargable (Word o PDF) con tus ajustes. Cada descarga queda en “Informes generados”.",
            })}
          </p>

          {genHtml && (
            <div className="border rounded-md overflow-hidden bg-white">
              {/* `sandbox` vacío: es HTML compuesto por una plantilla que el
                  docente edita, y esta vista previa no necesita interacción —a
                  diferencia del documento del estudiante, que sí y por eso lleva
                  `allow-same-origin` (ver `SignableDocument`)—. Los otros dos
                  iframes de HTML compuesto del repo (TemplateEditor y
                  SignatureBlockDialog) ya lo tenían; a este le faltaba. */}
              <iframe
                ref={iframeRef}
                title={t("hc_routesAppTeacherReports.previewTitle")}
                srcDoc={genHtml}
                sandbox=""
                className="w-full h-[60dvh]"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Dialog: qué cambió en la plantilla base ── */}
      <Dialog open={!!comparar} onOpenChange={(o) => !o && setComparar(null)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("reportBase.diffTitle", { defaultValue: "Qué cambió en la plantilla base" })}
            </DialogTitle>
            <DialogDescription>
              {t("reportBase.diffDesc", {
                defaultValue:
                  "En verde, lo que tiene tu plantilla personalizada. En rojo, lo que dice la base y a tu copia le falta.",
              })}
            </DialogDescription>
          </DialogHeader>
          {comparar && <DiffPlantilla base={comparar.base} propia={comparar.propia} />}
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" onClick={() => setComparar(null)}>
              {t("common.close")}
            </Button>
            <Button
              onClick={() => {
                const tpl = comparar?.propia;
                setComparar(null);
                if (tpl) void traerCambiosBase(tpl);
              }}
              disabled={!!rowBusyId}
            >
              <RefreshCw className="h-4 w-4 mr-1" />
              {t("reportBase.actionPull", { defaultValue: "Traer los cambios de la base" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SendToSignDialog
        reportId={firmarInforme?.id ?? null}
        courseId={firmarInforme?.courseId ?? null}
        reportName={firmarInforme?.nombre ?? ""}
        studentId={firmarInforme?.studentId ?? null}
        onOpenChange={(abierto) => {
          if (!abierto) setFirmarInforme(null);
        }}
      />
    </div>
  );
}

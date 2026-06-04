import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ListFilters } from "@/components/ui/list-filters";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { friendlyError } from "@/shared/lib/db-errors";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { RowAction } from "@/components/ui/row-action";
import { DateCell } from "@/components/ui/date-cell";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Plus,
  Download,
  FileText,
  Presentation,
  RefreshCw,
  Trash2,
  Eye,
  BookOpenCheck,
  BookOpen,
  ClipboardList,
  CheckSquare,
  CheckSquare as CheckSquareIcon,
  Hammer,
  Sparkles as SparklesIcon,
  CalendarRange,
  CalendarPlus,
  AlertCircle,
  Wand2,
  Pencil,
  MoreHorizontal,
  MessageSquareText,
  Send,
  EyeOff,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { MarkdownEditorDialog } from "@/modules/contents/MarkdownEditorDialog";
import { PptxViewerDialog } from "@/modules/contents/PptxViewerDialog";
import { RegenerateContentDialog } from "@/modules/contents/RegenerateContentDialog";
import { ContentPromptsOverridesDialog } from "@/modules/contents/ContentPromptsOverridesDialog";
import { GenerateSessionsDialog } from "@/modules/contents/GenerateSessionsDialog";
import {
  availableClassNumbers,
  classNumberFromFilename,
  extractClassTitle,
  extractClassTitleFromBucket,
  extractContentText,
  groupFilesByClass,
  type ContentFile,
} from "@/modules/contents/contents-extract";
import { Textarea } from "@/components/ui/textarea";
import { HelpHint } from "@/components/ui/help-hint";
import { buildPptxBlob, type PptxBrand } from "@/modules/contents/contents-pptx";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";

export const Route = createFileRoute("/app/teacher/contents")({ component: TeacherContents });

// El tipo `generated_contents` aún no está reflejado en los types
// generados de Supabase (se acaba de crear su migración). Usamos any
// localmente para mantener el contrato sin esperar a la regeneración.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ContentMode = "curso_completo" | "material_individual";
type ContentStatus = "queued" | "processing" | "done" | "failed";
type ContentModality = "teorica" | "practica" | "teorico_practica";
// Tags componibles para la generación: combina libremente teorico /
// practico / examen. Reemplaza el enum `modality` que solo permitía 3
// combinaciones. Mantenemos `modality` por compatibilidad con filas
// viejas (el edge function lo deriva de tags si falta).
type ContentTag = "teorico" | "practico" | "examen";
const TAG_TO_MODALITY = (tags: ContentTag[]): ContentModality => {
  const hasT = tags.includes("teorico");
  const hasP = tags.includes("practico");
  if (hasT && hasP) return "teorico_practica";
  if (hasP) return "practica";
  return "teorica"; // default si solo teorico, solo examen, o vacío
};

interface FileEntry {
  name: string;
  path: string;
  kind: "pptx-source" | "md" | "txt";
  body?: string;
}

interface GeneratedContent {
  id: string;
  teacher_id: string;
  course_id: string | null;
  mode: ContentMode;
  /** Nombre único humano (ej. "Semana 5 — Bucles"). Distinto de `topic`,
   *  que es lo que se le inyecta al prompt de IA. UNIQUE por docente. */
  display_name: string;
  topic: string;
  n_classes: number | null;
  duration_minutes: number | null;
  modality: ContentModality | null;
  /** Tags compositivos — fuente de verdad. `modality` se conserva por
   *  compatibilidad con filas pre-migración pero se deriva de tags. */
  tags: ContentTag[] | null;
  language: string;
  author: string | null;
  status: ContentStatus;
  files: FileEntry[];
  error: string | null;
  raw_output: string | null;
  /** Instrucciones libres del docente apiladas al user message del
   *  prompt. Se editan desde el dialog "Regenerar" sin necesidad de
   *  borrar/recrear el contenido. */
  instructions: string | null;
  /** Si false, el contenido queda como borrador del docente (los alumnos
   *  no lo ven aunque `status='done'`). Cuando se pone en true, el
   *  trigger de DB notifica + emaila al curso. */
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

interface CourseLite {
  id: string;
  name: string;
}

interface BrandConfig {
  university_name: string;
  primary_color: string;
  secondary_color: string;
  logo_url: string | null;
  author_default: string | null;
}

function statusVariant(s: ContentStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (s) {
    case "done":
      return "default";
    case "processing":
    case "queued":
      return "secondary";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

function TeacherContents() {
  const { user, roles } = useAuth();
  const activeRole = useActiveRole();
  // Admin / SuperAdmin actuando como tal: ven TODOS los contenidos del
  // tenant (RLS los acota a su institución). El Docente solo los suyos
  // — `teacher_id = user.id`. Cuando un usuario con múltiples roles
  // alterna al rol Docente, se aplica el filtro restrictivo.
  const isAdminLikeView =
    (activeRole === "Admin" || activeRole === "SuperAdmin") &&
    (roles.includes("Admin") || roles.includes("SuperAdmin"));
  // SuperAdmin "puro" (actuando como tal, sin override): habilita el
  // filtro UI extra por institución. Cuando el override está activo
  // (`/t/<slug>/...`) el SuperAdmin ya está acotado a UN tenant y este
  // filtro no aporta — la propia URL hace de filtro. Mismo patrón que
  // Cursos/Usuarios/Certificados.
  const isSuperAdminCaller = activeRole === "SuperAdmin" && roles.includes("SuperAdmin");
  const { t } = useTranslation();
  const confirm = useConfirm();
  const navigate = useNavigate();
  // Gate IA: la generación de contenidos consume cuota Gemini incluso
  // siendo asincrónica (cola interna distinta a ai_grading_queue).
  // Pedimos confirmación antes de crear el row + invocar la edge.
  const aiGate = useAiAuthorizationGate();

  const [items, setItems] = useState<GeneratedContent[]>([]);
  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  // Lista de instituciones — solo el SuperAdmin la usa. Con array de
  // ≤1 tenant, la RLS ya acota al de su perfil y no renderizamos el
  // filtro abajo.
  const [tenants, setTenants] = useState<Array<{ id: string; slug: string; name: string }>>([]);
  /** Filtro por institución (solo SuperAdmin). "all" = sin filtro. */
  const [tenantFilter, setTenantFilter] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  /** Filtro por curso. `null` = todos. Coincide con la convención del
   *  resto de grids docente (talleres, proyectos, exámenes) que usan
   *  `ListFilters`. Útil para que el docente vea qué material tiene
   *  asignado a un curso específico cuando administra varios. */
  const [courseFilter, setCourseFilter] = useState<string | null>(null);
  // Filtra por curso primero, luego por texto (display_name + topic +
  // autor + nombre del curso). Case-insensitive, includes. Los items
  // con `course_id = null` (sin curso) solo aparecen cuando el filtro
  // de curso es "Todos" — un filtro específico los excluye.
  const filteredItems = useMemo(() => {
    let arr = items;
    if (courseFilter) {
      arr = arr.filter((it) => it.course_id === courseFilter);
    }
    const q = search.trim().toLowerCase();
    if (!q) return arr;
    return arr.filter((it) => {
      const courseName = courses.find((c) => c.id === it.course_id)?.name?.toLowerCase() ?? "";
      return (
        it.display_name.toLowerCase().includes(q) ||
        it.topic.toLowerCase().includes(q) ||
        (it.author?.toLowerCase().includes(q) ?? false) ||
        courseName.includes(q)
      );
    });
  }, [items, courses, search, courseFilter]);
  const pagination = usePagination(filteredItems, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_contents",
    resetKey: `${search}|${courseFilter ?? ""}|${tenantFilter}`,
  });
  // Conteos de items derivados por contenido (sesiones programadas +
  // evaluaciones creadas con source_content_id). Lo poblamos junto al
  // load() principal y lo mostramos como badges debajo del topic en el
  // grid — así el docente ve de un vistazo cuánto trabajo derivó de
  // cada contenido sin abrir nada. Key = contentId.
  const [derived, setDerived] = useState<
    Record<string, { sessions: number; exams: number; workshops: number; projects: number }>
  >({});
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [rawForId, setRawForId] = useState<string | null>(null);
  // Cuando una generación queda en `status='failed'`, el campo `error`
  // de la fila contiene el mensaje completo. Lo abrimos en su propio
  // dialog para que el docente pueda copiar el texto y diagnosticar
  // (timeouts del gateway, VAPID/keys faltantes, prompts inválidos, etc.).
  const [errorForId, setErrorForId] = useState<string | null>(null);
  // Modal "Ver archivos por clase". Cuando una generación es
  // `curso_completo` con N clases, los archivos vienen con sufijo
  // `_CLASE_<N>` y los agrupamos por clase para que el docente pueda
  // navegar el material por sesión sin scrollear 24 botones.
  const [filesViewerFor, setFilesViewerFor] = useState<GeneratedContent | null>(null);
  // Estado del dialog "Crear evaluación con este contenido". Cuando
  // está poblado con un GeneratedContent, abrimos el formulario que
  // permite materializar Talleres/Exámenes/Proyectos con el contenido
  // como contexto de descripción.
  const [assessmentFor, setAssessmentFor] = useState<GeneratedContent | null>(null);
  // "Asignar a sesiones" abre un dialog con la lista de attendance_sessions
  // del curso donde el contenido vive, y deja al docente mapear cada
  // CLASE_N → sesión específica. Requiere que el contenido esté
  // asociado a un curso y que el curso tenga sesiones programadas.
  const [assignFor, setAssignFor] = useState<GeneratedContent | null>(null);
  // Target del dialog "Regenerar" — null = cerrado. Se setea desde el
  // menú de acciones (full) o desde FilesByClassDialog (per-class).
  // Permite al docente editar topic + instructions antes de relanzar.
  const [regenerateTarget, setRegenerateTarget] = useState<{
    contentId: string;
    /** Para mode='full' es el tema del curso (gen.topic). Para
     *  mode='class' es el tema EXTRAÍDO de los archivos de esa clase
     *  (extractClassTitle) — así el dialog deja editar el tema puntual
     *  sin pisar el tema general del curso. */
    topic: string;
    instructions: string | null;
    mode: "full" | "class";
    classNumber?: number;
  } | null>(null);
  // Editor de overrides de prompts POR CONTENIDO ESPECÍFICO. Cuando
  // está poblado con un id, se abre el dialog que permite sobrescribir
  // el system prompt orquestador y/o los 5 sub-prompts solo para este
  // contenido. La jerarquía resuelta en la edge function es:
  // override (este dialog) > global (módulo de Prompts) > fallback.
  const [promptOverridesFor, setPromptOverridesFor] = useState<string | null>(null);
  // "Programar sesiones del curso": genera N sesiones de attendance
  // a partir de fecha-inicio + días-de-la-semana, y les asigna cada
  // clase del contenido. Resuelve el caso del docente que no tiene
  // las sesiones del curso creadas todavía y no quería crearlas a
  // mano una por una en el módulo de Asistencia.
  const [generateFor, setGenerateFor] = useState<GeneratedContent | null>(null);
  // "Materializar curso": wizard que crea en lote las evaluaciones por
  // cada corte del curso (1 taller + 1 examen por corte; 1 proyecto en
  // el último corte). Acelera el flujo "abrir CreateAssessment N veces"
  // cuando el curso tiene varios cortes.
  const [materializeFor, setMaterializeFor] = useState<GeneratedContent | null>(null);

  // Form
  // `displayName` es el nombre único que el docente le pone a este
  // contenido específico (ej. "Semana 5 — Estructuras de control"). Es
  // distinto de `topic` (lo que se inyecta al prompt de IA, ej.
  // "introducción a Python"). Permite distinguir dos contenidos con el
  // mismo tema en el tablero / selectores. UNIQUE por docente vía DB.
  const [displayName, setDisplayName] = useState("");
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<ContentMode>("material_individual");
  const [nClasses, setNClasses] = useState<number>(8);
  // Duración por clase, en minutos. La IA lo usa como criterio de
  // extensión: <30 → material compacto, >120 → material extenso. Default
  // 60 (clase universitaria estándar).
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  // Tags compositivos: el docente elige qué tipos de archivo generar.
  //   teorico  → presentación + guía docente
  //   practico → taller práctico (+ ejercicio estudiante / solución)
  //   examen   → examen por sesión (oculto al estudiante)
  // Default: teorico + practico (equivalente al viejo "teorico_practica").
  const [tags, setTags] = useState<ContentTag[]>(["teorico", "practico"]);
  // `modality` se conserva derivado de tags para mantener compatibilidad
  // con el edge function y filas viejas. Lo recomputamos donde se persiste.
  const modality = TAG_TO_MODALITY(tags);
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [courseId, setCourseId] = useState<string>("");
  const [author, setAuthor] = useState("");
  // Instrucciones libres del docente que se apilan al user message del
  // edge function. NO modifican el system prompt — solo se inyectan
  // como bloque etiquetado al final del mensaje del usuario.
  const [instructions, setInstructions] = useState("");
  // Si true, el estudiante solo accede al contenido en/después de la
  // fecha de la sesión asignada. Default false = visible al asignarse.
  const [releaseAfterSessionDate, setReleaseAfterSessionDate] = useState(false);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);

    // SuperAdmin con filtro de institución activo: la tabla
    // `generated_contents` NO tiene `tenant_id` propia → resolvemos el
    // tenant vía `teacher_id → profiles.tenant_id`. Patrón 2-step de
    // CLAUDE.md: primero IDs de profiles del tenant, después
    // `.in("teacher_id", ids)`. Crítico: si el tenant no tiene
    // docentes, cortamos a corto-circuito antes de llamar a la tabla
    // — un `.in("teacher_id", [])` en PostgREST devuelve TODOS los
    // rows, no ninguno.
    let teacherIdsForTenant: string[] | null = null;
    if (isSuperAdminCaller && tenantFilter !== "all") {
      const { data: profsForTenant } = await db
        .from("profiles")
        .select("id")
        .eq("tenant_id", tenantFilter);
      teacherIdsForTenant = ((profsForTenant ?? []) as { id: string }[]).map((p) => p.id);
      if (teacherIdsForTenant.length === 0) {
        setItems([]);
        setDerived({});
        setLoading(false);
        return;
      }
    }

    // Admin/SuperAdmin: sin filtro por teacher_id → ven todos los
    // contenidos que la RLS de la institución les muestra (sirve para
    // auditar y gestionar lo que producen los docentes). Docente: solo
    // los suyos para no saturar el grid con material de colegas.
    let contentsQuery = db
      .from("generated_contents")
      .select("*")
      .order("created_at", { ascending: false });
    if (!isAdminLikeView) {
      contentsQuery = contentsQuery.eq("teacher_id", user.id);
    } else if (teacherIdsForTenant !== null) {
      contentsQuery = contentsQuery.in("teacher_id", teacherIdsForTenant);
    }

    const [{ data: gens, error: gensErr }, { data: brandRow }, { data: cs }, { data: tens }] =
      await Promise.all([
        contentsQuery,
        db.from("content_brand_config").select("*").maybeSingle(),
        // Cursos visibles para este usuario. Antes filtrábamos via
        // `course_teachers`, pero esa tabla no siempre tiene una fila
        // por docente (en orgs chicas o cuando los cursos los crea Admin
        // sin asignación explícita queda vacía). Ahora pedimos `courses`
        // directo y dejamos que la RLS de la tabla recorte.
        supabase.from("courses").select("id, name").order("name"),
        // Tenants — solo el SuperAdmin ve >1. Para Admin/Docente la RLS
        // recorta al suyo y el array queda en 1 → el Select abajo no se
        // renderiza (`tenants.length > 0` gate).
        isSuperAdminCaller
          ? db.from("tenants").select("id, slug, name").order("name")
          : Promise.resolve({ data: [] }),
      ]);
    // generated_contents es la query crítica — sin contenidos no hay
    // grid. brand y courses son secundarios (no bloquean el render).
    if (gensErr) {
      setLoadError(friendlyError(gensErr, "No pudimos cargar los contenidos."));
      setLoading(false);
      return;
    }
    setItems((gens ?? []) as GeneratedContent[]);
    setBrand((brandRow as BrandConfig) ?? null);
    setCourses((cs ?? []) as CourseLite[]);
    setTenants((tens ?? []) as Array<{ id: string; slug: string; name: string }>);

    // Conteos derivados — solo para los contenidos del docente actual.
    // Hacemos 4 queries en paralelo y agregamos en memoria. Los SELECTs
    // se filtran por los IDs cargados para evitar traer rows ajenos
    // (la RLS también lo recorta, pero filtrar reduce payload).
    const contentIds = (gens ?? []).map((g: { id: string }) => g.id);
    if (contentIds.length === 0) {
      setDerived({});
    } else {
      const [sess, ex, ws, pj] = await Promise.all([
        db.from("attendance_sessions").select("content_id").in("content_id", contentIds),
        db.from("exams").select("source_content_id").in("source_content_id", contentIds),
        db.from("workshops").select("source_content_id").in("source_content_id", contentIds),
        db.from("projects").select("source_content_id").in("source_content_id", contentIds),
      ]);
      const next: Record<
        string,
        { sessions: number; exams: number; workshops: number; projects: number }
      > = {};
      const ensure = (id: string) => {
        if (!next[id]) next[id] = { sessions: 0, exams: 0, workshops: 0, projects: 0 };
        return next[id];
      };
      for (const r of (sess.data ?? []) as { content_id: string | null }[]) {
        if (r.content_id) ensure(r.content_id).sessions += 1;
      }
      for (const r of (ex.data ?? []) as { source_content_id: string | null }[]) {
        if (r.source_content_id) ensure(r.source_content_id).exams += 1;
      }
      for (const r of (ws.data ?? []) as { source_content_id: string | null }[]) {
        if (r.source_content_id) ensure(r.source_content_id).workshops += 1;
      }
      for (const r of (pj.data ?? []) as { source_content_id: string | null }[]) {
        if (r.source_content_id) ensure(r.source_content_id).projects += 1;
      }
      setDerived(next);
    }
    setLoading(false);
    // isAdminLikeView en deps: si el usuario alterna entre rol Admin y
    // Docente con el role-switcher, queremos re-cargar con el filtro
    // correcto. `tenantFilter`/`isSuperAdminCaller` también — cambiar
    // de institución vuelve a disparar la query principal.
  }, [user, isAdminLikeView, isSuperAdminCaller, tenantFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling suave: si hay items en queued/processing, recargamos cada
  // 5s para reflejar el cambio de estado sin que el docente recargue
  // manualmente. Cuando todos están done/failed, paramos el polling.
  useEffect(() => {
    const hasPending = items.some((i) => i.status === "queued" || i.status === "processing");
    if (!hasPending) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [items, load]);

  const submitNew = async () => {
    if (!user) return;
    if (!topic.trim()) {
      toast.error(t("integrity.applyError"));
      return;
    }
    // Validamos display_name antes que el topic falle el DB: mismas
    // reglas que el helper `validateDisplayName` para feedback inmediato.
    const dn = displayName.trim();
    if (!dn) {
      toast.error("Indica un nombre único para este contenido.");
      return;
    }
    if (dn.length > 120) {
      toast.error("El nombre es demasiado largo (máx 120 caracteres).");
      return;
    }
    if (tags.length === 0) {
      toast.error(t("contents.tagsRequired"));
      return;
    }
    // Generación de contenidos con IA — NO tiene worker async. Pasamos
    // `allowQueue: false` para que el dialog del gate solo ofrezca
    // "Activar IA inmediata" o "Cancelar".
    const decision = await aiGate.ensureAuthorized({ allowQueue: false });
    if (decision === "cancel") return;
    if (decision === "proceed-async") {
      toast.error(
        "La generación con IA no soporta modo cola. Activá un código de IA inmediata para continuar.",
      );
      return;
    }
    setCreating(true);
    try {
      const insertPayload: Record<string, unknown> = {
        teacher_id: user.id,
        display_name: dn,
        topic: topic.trim(),
        mode,
        language,
        n_classes: mode === "curso_completo" ? nClasses : null,
        duration_minutes: durationMinutes,
        modality, // derivado de tags (compat con edge function + filas viejas)
        tags, // fuente de verdad (incluye "examen" si está activo)
        course_id: courseId || null,
        author: author.trim() || null,
        instructions: instructions.trim() || null,
        release_after_session_date: releaseAfterSessionDate,
        status: "queued",
      };
      const { data: created, error: insErr } = await db
        .from("generated_contents")
        .insert(insertPayload)
        .select("*")
        .maybeSingle();
      if (insErr || !created) {
        // 23505 = unique_violation en Postgres. Mensaje específico para
        // que el docente sepa que es por display_name duplicado.
        const code = (insErr as { code?: string } | null | undefined)?.code;
        if (code === "23505") {
          toast.error(`Ya tienes un contenido llamado "${dn}". Usa un nombre distinto.`);
          return;
        }
        throw new Error(insErr?.message ?? "insert failed");
      }

      // Disparamos la edge function fire-and-forget. El usuario verá
      // el estado en la lista (queued → processing → done/failed) vía
      // polling. Igual capturamos fallas inmediatas (red caída, edge
      // no desplegada, etc.) — sin esto la fila se queda en queued
      // para siempre y el docente no sabe por qué.
      void supabase.functions
        .invoke("generate-contents", { body: { id: created.id } })
        .then(async ({ error: invErr, data: invData }) => {
          if (invErr || (invData as { error?: string })?.error) {
            const detail = await extractEdgeError(invErr, invData);
            toast.error(
              friendlyError(invErr ?? new Error(detail || "No se pudo iniciar la generación")),
            );
          }
        });

      toast.success(t("contents.createdToast"));
      setDialogOpen(false);
      // Reset form
      setDisplayName("");
      setTopic("");
      setAuthor("");
      setInstructions("");
      setReleaseAfterSessionDate(false);
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (item: GeneratedContent) => {
    const ok = await confirm({
      title: t("contents.deleteTitle"),
      description: t("contents.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    // Borra los archivos del bucket (en el patrón <teacher>/<id>/*) y la fila.
    const paths = (item.files ?? []).map((f) => f.path).filter(Boolean);
    if (paths.length) {
      await supabase.storage.from("generated-contents").remove(paths);
    }
    const { error } = await db.from("generated_contents").delete().eq("id", item.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    toast.success(t("contents.deletedToast"));
  };

  /** Toggle de publicación del contenido. Al pasar a `is_published=true`
   *  el trigger de DB notifica + emaila a los alumnos del curso. Al
   *  pasar a false el material queda como borrador (los alumnos dejan
   *  de verlo). */
  const setPublished = async (item: GeneratedContent, next: boolean) => {
    const { error } = await db
      .from("generated_contents")
      .update({ is_published: next })
      .eq("id", item.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, is_published: next } : i)));
    toast.success(
      next
        ? "Contenido publicado. Los alumnos del curso recibirán notificación."
        : "Contenido despublicado. Los alumnos ya no lo ven.",
    );
  };

  /** Borra UN archivo individual del contenido. Útil cuando al docente
   *  no le gustó solo una parte (ej. la solución del ejercicio salió
   *  mal) y no quiere regenerar el contenido entero. Acciones:
   *   1. Confirma con el docente (acción destructiva).
   *   2. Borra el archivo del bucket.
   *   3. Re-escribe `files[]` en el JSONB sin esa entrada.
   *   4. Refresca la lista local.
   *
   *  La fila de `generated_contents` se mantiene — solo desaparece el
   *  archivo puntual. El docente puede volver a generarlo individualmente
   *  (regen de clase) si lo necesita.
   */
  const deleteFile = async (item: GeneratedContent, file: FileEntry) => {
    const ok = await confirm({
      title: t("contents.deleteFileTitle", { name: humanLabelForFile(file) }),
      description: t("contents.deleteFileBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    try {
      // 1. Storage — best-effort. Si falla seguimos para limpiar el
      // JSONB de todos modos (el archivo huérfano en storage es menos
      // grave que dejar la referencia colgada en el grid).
      const { error: stErr } = await supabase.storage
        .from("generated-contents")
        .remove([file.path]);
      if (stErr) console.warn("[contents] storage.remove failed:", stErr.message);

      // 2. JSONB — leer files actuales, filtrar el path, persistir.
      const { data: row, error: getErr } = await db
        .from("generated_contents")
        .select("files")
        .eq("id", item.id)
        .maybeSingle();
      if (getErr || !row) throw new Error(getErr?.message ?? "No se pudo cargar el contenido");
      const filesArr = Array.isArray(row.files) ? (row.files as FileEntry[]) : [];
      const nextFiles = filesArr.filter((f) => f.path !== file.path);
      const { error: updErr } = await db
        .from("generated_contents")
        .update({ files: nextFiles })
        .eq("id", item.id);
      if (updErr) throw new Error(updErr.message);

      // 3. State local — actualiza la fila in-place sin re-fetch.
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, files: nextFiles } : i)));
      // Si el dialog de archivos está abierto sobre este content, también
      // refrescamos su referencia para que la chip desaparezca al instante.
      setFilesViewerFor((cur) => (cur && cur.id === item.id ? { ...cur, files: nextFiles } : cur));
      toast.success(t("contents.deleteFileDone"));
    } catch (e) {
      toast.error(friendlyError(e));
    }
  };

  /** Abre el dialog "Regenerar" pre-cargando topic + instructions
   *  actuales para que el docente pueda ajustar antes de relanzar.
   *  Antes este botón ejecutaba directo — perdías la oportunidad de
   *  refinar el prompt sin borrar/recrear el contenido. */
  const openRegenerate = (item: GeneratedContent) => {
    setRegenerateTarget({
      contentId: item.id,
      topic: item.topic,
      instructions: item.instructions ?? null,
      mode: "full",
    });
  };

  /** Igual al anterior pero para UNA clase. El edge function mergea
   *  el output con las clases existentes (no las pierde). El topic
   *  pre-cargado es el de la CLASE específica (extraído de sus archivos),
   *  no el del curso entero — así el docente edita el tema puntual sin
   *  pisar el `topic` general del curso. Si la extracción falla
   *  (archivos sin título extraíble), caemos al topic del curso. */
  const openRegenerateClass = (item: GeneratedContent, classNumber: number) => {
    const files = (item.files ?? []) as ContentFile[];
    const classTitle = extractClassTitle(files, classNumber);
    setRegenerateTarget({
      contentId: item.id,
      topic: classTitle ?? item.topic,
      instructions: item.instructions ?? null,
      mode: "class",
      classNumber,
    });
  };

  /**
   * Descarga un archivo. Para `kind='md'` y `'txt'` viene como texto
   * plano del bucket — descargamos directo.
   * Para `pptx-source` leemos el body crudo (que la edge function dejó
   * almacenado como .pptx.txt) y lo convertimos a .pptx real con
   * pptxgenjs en el browser. Esto evita pesar el bundle inicial — el
   * import es lazy dentro de buildPptxBlob.
   */
  const download = async (item: GeneratedContent, file: FileEntry) => {
    setDownloadingId(`${item.id}:${file.path}`);
    try {
      const { data: blob, error } = await supabase.storage
        .from("generated-contents")
        .download(file.path);
      if (error || !blob) throw new Error(error?.message ?? "download failed");

      // Filename amigable: "Guía Docente Clase 1 - Tema.md" en vez de
      // "GUIA_DOCENTE_CLASE_1.MD". Tema viene del título extraído de los
      // headings del archivo (igual lógica que usa el grid).
      const classNum = classNumberFromFilename(file.name);
      const filesArr = (item.files as ContentFile[] | null) ?? [];
      const topic =
        (classNum != null ? extractClassTitle(filesArr, classNum) : null) ?? item.topic ?? null;
      const friendlyName = buildDownloadName(file, classNum, topic);

      if (file.kind === "pptx-source") {
        const raw = await blob.text();
        const pptxBrand: PptxBrand = {
          universityName: brand?.university_name ?? "",
          primaryColor: brand?.primary_color ?? "#1e40af",
          secondaryColor: brand?.secondary_color ?? "#64748b",
          logoUrl: brand?.logo_url ?? null,
          author: item.author ?? brand?.author_default ?? null,
        };
        const documentTitle = item.topic;
        const pptxBlob = await buildPptxBlob(raw, pptxBrand, documentTitle);
        const url = URL.createObjectURL(pptxBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = friendlyName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = friendlyName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const courseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of courses) m.set(c.id, c.name);
    return m;
  }, [courses]);

  const rawItem = items.find((i) => i.id === rawForId) ?? null;

  if (loadError) {
    return (
      <div className="space-y-5">
        <PageHeader
          title={t("contents.title")}
          icon={<Presentation className="h-6 w-6 text-pink-500" />}
        />
        <ErrorState
          message="No pudimos cargar los contenidos"
          hint={loadError}
          onRetry={() => void load()}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("contents.title")}
        subtitle={t("contents.subtitle")}
        icon={<Presentation className="h-6 w-6 text-pink-500" />}
        actions={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            {t("contents.newContent")}
          </Button>
        }
      />

      <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center">
        <div className="flex-1 min-w-0">
          <ListFilters
            search={search}
            onSearchChange={setSearch}
            searchPlaceholder="Buscar por nombre, tema o autor…"
            courseId={courseFilter}
            onCourseChange={setCourseFilter}
            courses={courses}
          />
        </div>
        {/* SuperAdmin cross-tenant: filtro por institución. Solo se
            renderiza cuando el usuario actúa como SuperAdmin Y hay >0
            tenants cargados (Admin común no llega a verlo). Aplica vía
            `teacher_id IN (profiles del tenant)` en `load()`. */}
        {isSuperAdminCaller && tenants.length > 0 && (
          <Select value={tenantFilter} onValueChange={setTenantFilter}>
            <SelectTrigger className="w-full sm:w-48 h-9 text-xs">
              <SelectValue placeholder={t("tenant.filterTenantPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("tenant.filterAllTenants")}</SelectItem>
              {tenants.map((tn) => (
                <SelectItem key={tn.id} value={tn.id}>
                  {tn.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : (
            // table-fixed: el topic/display_name puede ser largo —
            // trunca en su cell sin expandir la tabla.
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-[320px]">{t("contents.topicColumn")}</TableHead>
                  <TableHead className="w-32">{t("contents.modeColumn")}</TableHead>
                  <TableHead className="w-32">{t("common.course")}</TableHead>
                  <TableHead className="w-24">{t("common.status")}</TableHead>
                  <TableHead className="w-20">{t("contents.filesColumn")}</TableHead>
                  <TableHead className="w-32">{t("contents.createdColumn")}</TableHead>
                  <TableHead className="text-right w-20">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.length === 0 &&
                  (() => {
                    // Si la lista total está vacía → empty state normal
                    // de "crea tu primer contenido". Si hay items pero
                    // el filtro (texto o curso) los recortó a 0, mostramos
                    // un mensaje con la pista para ajustar el filtro.
                    const filterActive = search.trim() !== "" || courseFilter != null;
                    const noMatch = filterActive && items.length > 0;
                    return (
                      <TableEmpty
                        colSpan={7}
                        text={noMatch ? "Sin coincidencias" : t("contents.emptyTitle")}
                        hint={
                          noMatch
                            ? "Ajusta el buscador o el filtro de curso para ver más resultados."
                            : t("contents.emptyHint")
                        }
                        action={
                          noMatch ? undefined : (
                            <Button onClick={() => setDialogOpen(true)}>
                              <Plus className="h-4 w-4 mr-1" />
                              {t("contents.createFirst")}
                            </Button>
                          )
                        }
                      />
                    );
                  })()}
                {pagination.paginatedItems.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell className="max-w-xs">
                      {/* display_name como identificador humano principal.
                          topic queda como subtítulo en gris para conservar
                          el contexto del prompt cuando dos contenidos tienen
                          el mismo tema. Fallback al topic si la migración
                          aún no se aplicó (filas pre-display_name). */}
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div className="font-medium truncate" title={it.display_name ?? it.topic}>
                          {it.display_name ?? it.topic}
                        </div>
                        {!it.is_published && (
                          <Badge variant="secondary" className="text-[10px] shrink-0">
                            Borrador
                          </Badge>
                        )}
                      </div>
                      {it.display_name && it.display_name !== it.topic && (
                        <div
                          className="text-[11px] text-muted-foreground truncate"
                          title={it.topic}
                        >
                          {it.topic}
                        </div>
                      )}
                      {/* Conteos derivados: sesiones programadas +
                          evaluaciones creadas con este contenido como
                          source. Solo se muestran badges con count > 0
                          para no llenar de "0" la fila. Tooltip en cada
                          uno explica qué representa. */}
                      {(() => {
                        const d = derived[it.id];
                        if (!d) return null;
                        const total = d.sessions + d.exams + d.workshops + d.projects;
                        if (total === 0) return null;
                        return (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {d.sessions > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px] gap-1 px-1.5 py-0"
                                title={t("contents.derivedSessionsHint")}
                              >
                                <CalendarRange className="h-2.5 w-2.5" />
                                {t("contents.derivedSessions", { count: d.sessions })}
                              </Badge>
                            )}
                            {d.exams > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px] gap-1 px-1.5 py-0"
                                title={t("contents.derivedExamsHint")}
                              >
                                <BookOpenCheck className="h-2.5 w-2.5" />
                                {t("contents.derivedExams", { count: d.exams })}
                              </Badge>
                            )}
                            {d.workshops > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px] gap-1 px-1.5 py-0"
                                title={t("contents.derivedWorkshopsHint")}
                              >
                                <FileText className="h-2.5 w-2.5" />
                                {t("contents.derivedWorkshops", { count: d.workshops })}
                              </Badge>
                            )}
                            {d.projects > 0 && (
                              <Badge
                                variant="outline"
                                className="text-[10px] gap-1 px-1.5 py-0"
                                title={t("contents.derivedProjectsHint")}
                              >
                                <Presentation className="h-2.5 w-2.5" />
                                {t("contents.derivedProjects", { count: d.projects })}
                              </Badge>
                            )}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[11px]">
                        {it.mode === "curso_completo"
                          ? `${t("contents.modeFull")} (${it.n_classes})`
                          : t("contents.modeSingle")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {it.course_id
                        ? (courseNameById.get(it.course_id) ?? "—")
                        : t("contents.noCourse")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(it.status)} className="text-[11px]">
                        {it.status === "processing" && <Spinner size="xs" className="mr-1" />}
                        {t(
                          `contents.status${it.status.charAt(0).toUpperCase()}${it.status.slice(1)}`,
                        )}
                      </Badge>
                      {it.status === "failed" && it.error && (
                        <div
                          className="text-[10px] text-destructive mt-1 max-w-xs truncate"
                          title={it.error}
                        >
                          {t("contents.errorPrefix")}: {it.error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* Antes mostrábamos hasta 3 botones de descarga
                          inline + "+X archivos más" — saturaba la fila
                          en cursos completos (15-25 archivos). Ahora un
                          único botón ojo abre el modal "Ver archivos
                          por clase" donde el docente ve todo agrupado.
                          El conteo va en el badge para que se sepa
                          cuántos archivos hay sin necesidad de abrir. */}
                      {(it.files?.length ?? 0) === 0 ? (
                        <span className="text-xs text-muted-foreground">—</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-8 text-xs"
                          onClick={() => setFilesViewerFor(it)}
                          title={t("contents.viewFilesByClass")}
                        >
                          <Eye className="h-3.5 w-3.5 mr-1" />
                          <Badge
                            variant="secondary"
                            className="h-5 px-1.5 text-[10px] tabular-nums"
                          >
                            {it.files.length}
                          </Badge>
                        </Button>
                      )}
                    </TableCell>
                    <TableCell>
                      <DateCell value={it.created_at} variant="datetime" />
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActionsMenu
                        actions={[
                          // Ver archivos por clase — primer item del menú
                          // porque es la acción más usada cuando hay >3
                          // archivos. Para curso_completo agrupa por
                          // CLASE_N; para material_individual lista plano.
                          it.status === "done" && (it.files?.length ?? 0) > 0
                            ? {
                                label: t("contents.viewFilesByClass"),
                                icon: FileText,
                                onClick: () => setFilesViewerFor(it),
                              }
                            : null,
                          // "Crear evaluación" solo cuando el contenido
                          // está listo y tiene archivos extraíbles —
                          // sin eso no hay nada que pasar como contexto.
                          it.status === "done" && (it.files?.length ?? 0) > 0
                            ? {
                                label: t("contents.createAssessment"),
                                icon: BookOpenCheck,
                                onClick: () => setAssessmentFor(it),
                              }
                            : null,
                          // "Programar sesiones del curso": cuando el
                          // contenido tiene course_id, ofrecemos generar
                          // N sesiones de asistencia (con fecha calculada
                          // desde inicio + días de semana) y asignarles
                          // cada clase. Si el curso ya tenía sesiones,
                          // el dialog ofrece reusar o crear nuevas.
                          it.status === "done" && it.course_id
                            ? {
                                label: t("contents.generateSessions"),
                                icon: CalendarPlus,
                                onClick: () => setGenerateFor(it),
                              }
                            : null,
                          // "Materializar curso": batch de evaluaciones
                          // por corte. Solo disponible para curso_completo
                          // con course_id — para material_individual no
                          // tiene sentido, porque la idea es repartir
                          // clases entre cortes y solo hay 1 sesión.
                          it.status === "done" && it.course_id && it.mode === "curso_completo"
                            ? {
                                label: t("contents.materializeAction"),
                                icon: Wand2,
                                onClick: () => setMaterializeFor(it),
                              }
                            : null,
                          it.status === "done" && it.course_id
                            ? {
                                label: t("contents.assignToSessions"),
                                icon: CalendarRange,
                                onClick: () => setAssignFor(it),
                              }
                            : null,
                          // "Ver error completo" solo aparece cuando la
                          // generación falló. El campo `error` puede ser
                          // largo (HTML del gateway, stack trace, etc.)
                          // y la celda lo trunca; este dialog lo muestra
                          // íntegro y lo deja seleccionable para copiar.
                          it.status === "failed" && it.error
                            ? {
                                label: t("contents.viewError"),
                                icon: AlertCircle,
                                tone: "destructive",
                                onClick: () => setErrorForId(it.id),
                              }
                            : null,
                          it.raw_output
                            ? {
                                label: t("contents.viewRaw"),
                                icon: Eye,
                                onClick: () => setRawForId(it.id),
                              }
                            : null,
                          // Publicar / Despublicar para los alumnos.
                          // Solo cuando el contenido está listo (done) —
                          // antes de eso no hay nada que publicar. El
                          // trigger en DB se encarga de notificar + emailar
                          // al cambiar a `is_published=true`.
                          it.status === "done" && !it.is_published
                            ? {
                                label: "Publicar para los alumnos",
                                icon: Send,
                                onClick: () => void setPublished(it, true),
                              }
                            : null,
                          it.status === "done" && it.is_published
                            ? {
                                label: "Despublicar",
                                icon: EyeOff,
                                onClick: () => void setPublished(it, false),
                              }
                            : null,
                          // "Personalizar prompts" — abre el editor de
                          // overrides POR CONTENIDO. Aparece siempre (no
                          // depende de status) porque el docente puede
                          // querer ajustar los prompts ANTES de regenerar
                          // — incluso si la fila falló o aún no terminó.
                          {
                            label: "Personalizar prompts",
                            icon: MessageSquareText,
                            onClick: () => setPromptOverridesFor(it.id),
                          },
                          {
                            label: t("contents.regenerate"),
                            icon: RefreshCw,
                            onClick: () => openRegenerate(it),
                            disabled: it.status === "queued" || it.status === "processing",
                          },
                          {
                            label: t("common.delete"),
                            icon: Trash2,
                            tone: "destructive",
                            separatorBefore: true,
                            onClick: () => remove(it),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <DataPagination state={pagination} entityNamePlural="contenidos" />
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("contents.newContent")}</DialogTitle>
            <DialogDescription>{t("contents.queuedHint")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {/* Nombre único del contenido: lo que aparece en grids y
                selectores. Es DISTINTO del topic (tema del prompt) —
                permite distinguir dos contenidos del mismo tema. La DB
                exige unicidad por docente (case-insensitive). */}
            <div className="space-y-1.5">
              <Label required>
                Nombre del contenido
                <HelpHint>
                  Nombre único para identificar este contenido en el tablero y en los selectores.
                  Por ejemplo: "Semana 5 — Estructuras de control" o "Cohorte 2026-I · Algoritmos".
                  Es distinto del tema (lo que se le pide a la IA).
                </HelpHint>
              </Label>
              <Input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder='Ej. "Semana 5 — Bucles" o "Cohorte 2026-I · Algoritmos"'
                maxLength={120}
              />
            </div>
            <div className="space-y-1.5">
              <Label required>
                {t("contents.topic")}
                <HelpHint>{t("contents.topicHint")}</HelpHint>
              </Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("contents.topicPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                {t("contents.mode")}
                <HelpHint>{t("contents.modeHint")}</HelpHint>
              </Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(["material_individual", "curso_completo"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`text-left rounded-md border p-2.5 transition-colors ${
                      mode === m ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="font-medium text-sm">
                      {m === "curso_completo" ? t("contents.modeFull") : t("contents.modeSingle")}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {m === "curso_completo"
                        ? t("contents.modeFullDesc")
                        : t("contents.modeSingleDesc")}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {mode === "curso_completo" && (
                <div className="space-y-1.5">
                  <Label required>
                    {t("contents.nClasses")}
                    <HelpHint>{t("contents.nClassesHint")}</HelpHint>
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={40}
                    value={nClasses}
                    onChange={(e) => setNClasses(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label required>
                  {t("contents.duration")}
                  <HelpHint>{t("contents.durationHelper")}</HelpHint>
                </Label>
                <Input
                  type="number"
                  min={10}
                  max={480}
                  step={5}
                  value={durationMinutes}
                  onChange={(e) =>
                    setDurationMinutes(Math.max(10, Math.min(480, Number(e.target.value) || 60)))
                  }
                />
                <p className="text-[11px] text-muted-foreground">{t("contents.durationHelper")}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label required>
                {t("contents.tags")}
                <HelpHint>{t("contents.tagsHint")}</HelpHint>
              </Label>
              {/* Tags compositivos (multi-select). Cada uno determina
                  qué archivos genera la IA. Combina libremente teórico,
                  práctico y examen. Al menos un tag debe estar activo —
                  se valida abajo en `canSubmit`. */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(
                  [
                    {
                      key: "teorico" as ContentTag,
                      label: t("contents.tagTheory"),
                      desc: t("contents.tagTheoryDesc"),
                    },
                    {
                      key: "practico" as ContentTag,
                      label: t("contents.tagPractice"),
                      desc: t("contents.tagPracticeDesc"),
                    },
                    {
                      key: "examen" as ContentTag,
                      label: t("contents.tagExam"),
                      desc: t("contents.tagExamDesc"),
                    },
                  ] as const
                ).map((opt) => {
                  const active = tags.includes(opt.key);
                  return (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() =>
                        setTags((prev) =>
                          active ? prev.filter((x) => x !== opt.key) : [...prev, opt.key],
                        )
                      }
                      className={`text-left rounded-md border p-2 text-xs transition-colors ${
                        active
                          ? "border-primary bg-primary/10 ring-1 ring-primary/40"
                          : "border-border hover:bg-muted/40"
                      }`}
                      aria-pressed={active}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <div className="font-medium text-sm">{opt.label}</div>
                        {active && <CheckSquareIcon className="h-3.5 w-3.5 text-primary" />}
                      </div>
                      <div className="text-[10px] text-muted-foreground">{opt.desc}</div>
                    </button>
                  );
                })}
              </div>
              {tags.length === 0 && (
                <p className="text-[11px] text-destructive">{t("contents.tagsRequired")}</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("contents.courseOptional")}</Label>
                <Select
                  value={courseId || "none"}
                  onValueChange={(v) => setCourseId(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("contents.noCourse")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("contents.noCourse")}</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("contents.language")}</Label>
                <Select value={language} onValueChange={(v) => setLanguage(v as "es" | "en")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">Español</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t("contents.author")}</Label>
              <Input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder={t("contents.authorPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                {t("contents.instructions")}
                <HelpHint>{t("contents.instructionsHint")}</HelpHint>
              </Label>
              <Textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder={t("contents.instructionsPlaceholder")}
                className="min-h-[100px] text-xs"
              />
            </div>

            <div className="flex items-start justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-1 min-w-0">
                <Label htmlFor="release-after-session" className="text-sm font-medium">
                  Liberar al estudiante solo desde la fecha de sesión
                </Label>
                <p className="text-xs text-muted-foreground">
                  Si está activo, el estudiante verá el contenido únicamente cuando llegue la fecha
                  de la sesión a la que se asignó. Útil para evitar spoilers de talleres, ejercicios
                  o exámenes.
                </p>
              </div>
              <Switch
                id="release-after-session"
                checked={releaseAfterSessionDate}
                onCheckedChange={setReleaseAfterSessionDate}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitNew} disabled={creating || !topic.trim() || tags.length === 0}>
              {creating ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Download className="h-4 w-4 mr-1" />
              )}
              {creating ? t("contents.submitting") : t("contents.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Raw output dialog */}
      <Dialog open={rawForId != null} onOpenChange={(o) => !o && setRawForId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("contents.raw")}</DialogTitle>
            <DialogDescription>{rawItem?.topic}</DialogDescription>
          </DialogHeader>
          <pre className="text-[11px] whitespace-pre-wrap max-h-[60vh] overflow-y-auto bg-muted/30 p-3 rounded">
            {rawItem?.raw_output ?? ""}
          </pre>
        </DialogContent>
      </Dialog>

      {/* Error dialog: muestra el campo `error` íntegro de la fila
          para que el docente pueda copiarlo y diagnosticar fallos del
          edge function (timeouts, VAPID/keys faltantes, etc.). */}
      <Dialog open={errorForId != null} onOpenChange={(o) => !o && setErrorForId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              {t("contents.errorDialogTitle")}
            </DialogTitle>
            <DialogDescription>{items.find((i) => i.id === errorForId)?.topic}</DialogDescription>
          </DialogHeader>
          <pre className="text-[11px] whitespace-pre-wrap max-h-[60vh] overflow-y-auto bg-destructive/5 border border-destructive/30 p-3 rounded text-destructive-foreground/90 select-text">
            {items.find((i) => i.id === errorForId)?.error ?? ""}
          </pre>
          <p className="text-[11px] text-muted-foreground">{t("contents.errorDialogHint")}</p>
        </DialogContent>
      </Dialog>

      <AssignToSessionsDialog content={assignFor} onClose={() => setAssignFor(null)} />

      <GenerateSessionsDialog
        open={generateFor !== null}
        content={generateFor}
        courseId={generateFor?.course_id ?? ""}
        onClose={() => setGenerateFor(null)}
        onCreated={() => {
          setGenerateFor(null);
          void load();
        }}
      />

      <MaterializeCourseDialog
        content={materializeFor}
        onClose={() => setMaterializeFor(null)}
        onCreated={() => {
          setMaterializeFor(null);
          void load();
        }}
        // El wizard puede detectar que faltan sesiones programadas; en
        // ese caso ofrece un botón que cierra este dialog y abre
        // GenerateSessionsDialog sobre el mismo contenido. Usamos el
        // ref pasado como callback para encadenar los flujos sin que
        // el docente tenga que cerrar y reabrir el menú.
        onOpenSessionsDialog={() => {
          if (materializeFor) setGenerateFor(materializeFor);
        }}
      />

      <FilesByClassDialog
        content={filesViewerFor}
        brand={brand}
        downloadingPath={downloadingId}
        onDownload={(file) => filesViewerFor && void download(filesViewerFor, file)}
        onDeleteFile={(file) => filesViewerFor && void deleteFile(filesViewerFor, file)}
        onRegenerateClass={(classNumber) =>
          filesViewerFor && openRegenerateClass(filesViewerFor, classNumber)
        }
        onClose={() => setFilesViewerFor(null)}
      />

      <CreateAssessmentDialog
        content={assessmentFor}
        courses={courses}
        onClose={() => setAssessmentFor(null)}
        onCreated={(target, id) => {
          setAssessmentFor(null);
          // Navega al editor de la nueva evaluación. Para Exam hay
          // ruta dedicada por id; para Workshop y Project, el editor
          // vive como dialog dentro de la lista — pasamos `?edit=<id>`
          // y la ruta lo abre automáticamente, igual al pattern que
          // ya usaba `?workshop=<id>`/`?project=<id>` para grading.
          if (target === "exam") void navigate({ to: `/app/teacher/exams/${id}` });
          else if (target === "workshop")
            void navigate({ to: "/app/teacher/workshops", search: { edit: id } });
          else void navigate({ to: "/app/teacher/projects", search: { edit: id } });
          toast.success(t("contents.assessmentCreatedToast"));
        }}
      />

      {/* Dialog "Regenerar" — edita topic + instructions antes de
          relanzar, sin tener que borrar el contenido. Para regen total
          y por clase. */}
      <RegenerateContentDialog
        target={regenerateTarget}
        onClose={() => setRegenerateTarget(null)}
        onStarted={() => void load()}
      />

      {/* Dialog para personalizar los prompts (orquestador + sub-prompts)
          SOLO para este contenido. La jerarquía override > global > fallback
          la resuelve la edge function `generate-contents` al regenerar. */}
      <ContentPromptsOverridesDialog
        contentId={promptOverridesFor}
        onClose={() => setPromptOverridesFor(null)}
        onSaved={() => void load()}
      />
      <aiGate.GateDialog />
    </div>
  );
}

/**
 * Dialog que materializa una evaluación (Taller / Examen / Proyecto)
 * usando el contenido generado como descripción inicial. Después de
 * crear la fila base, navega al editor para que el docente dispare
 * los flujos existentes de "Generar preguntas con IA" — esos prompts
 * ya saben usar la descripción como contexto.
 */
type AssessmentTarget = "workshop" | "exam" | "project";

function CreateAssessmentDialog({
  content,
  courses,
  onClose,
  onCreated,
}: {
  content: GeneratedContent | null;
  courses: CourseLite[];
  onClose: () => void;
  onCreated: (target: AssessmentTarget, id: string) => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [target, setTarget] = useState<AssessmentTarget>("exam");
  const [courseId, setCourseId] = useState<string>("");
  // Multi-select de clases para curso_completo. `null` = todo el
  // contenido (full course); `Set<number>` = subconjunto de clases.
  // Antes solo se podía elegir UNA clase o "todo"; ahora el docente
  // selecciona N clases para crear, e.g. una evaluación de mitad de
  // semestre que cubre las clases 1–6.
  const [selectedClasses, setSelectedClasses] = useState<Set<number> | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  // Cortes del curso seleccionado (si tiene). Si el curso no tiene
  // cortes, el selector de alcance no aparece.
  const [courseCuts, setCourseCuts] = useState<Array<{ id: string; name: string }>>([]);
  // Scope: "course" = 1 evaluación para todo el curso (sin cut_id).
  //        "per_cut" = N evaluaciones, una por cada corte del curso.
  const [scope, setScope] = useState<"course" | "per_cut">("course");

  // Resetea el form cada vez que se abre con un contenido distinto.
  // Pre-elige el curso del propio contenido si vino con uno.
  useEffect(() => {
    if (!content) return;
    setTarget("exam");
    setCourseId(content.course_id ?? "");
    setTitle(content.topic);
    setScope("course");
    // Default: todo el contenido seleccionado. El docente puede
    // restringir a clases específicas con los checkboxes.
    setSelectedClasses(null);
  }, [content]);

  // Carga cortes del curso seleccionado. Sin cortes, el control de
  // alcance queda oculto y todo se inserta como curso completo (sin
  // cut_id). Si el docente cambia de curso, la lista se refresca.
  useEffect(() => {
    if (!courseId) {
      setCourseCuts([]);
      setScope("course");
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data } = await db
        .from("grade_cuts")
        .select("id, name, position")
        .eq("course_id", courseId)
        .order("position", { ascending: true });
      if (cancelled) return;
      setCourseCuts(
        ((data as Array<{ id: string; name: string }> | null) ?? []).map((c) => ({
          id: c.id,
          name: c.name,
        })),
      );
      // Al cambiar de curso, volvemos a "course" para no arrastrar
      // selección stale (un curso anterior tenía cortes, el nuevo no).
      setScope("course");
    })();
    return () => {
      cancelled = true;
    };
  }, [courseId]);

  const classes = useMemo(
    () => (content ? availableClassNumbers((content.files as ContentFile[]) ?? []) : []),
    [content],
  );

  if (!content) return null;

  const isFull = selectedClasses == null;
  const selectedArray = isFull ? [] : Array.from(selectedClasses).sort((a, b) => a - b);
  const noneSelected = !isFull && selectedArray.length === 0;

  const toggleClass = (n: number) => {
    setSelectedClasses((prev) => {
      // En modo "Todas" (prev=null) un click destilda SOLO la clase
      // tocada; el resto queda seleccionada. Es el comportamiento
      // intuitivo: si ya estaban todas marcadas, hacer click en una
      // significa "saca esa", no "deja solo esa".
      if (prev == null) {
        const next = new Set(classes);
        next.delete(n);
        return next;
      }
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  };
  const selectAll = () => setSelectedClasses(null);
  const selectNone = () => setSelectedClasses(new Set());

  const submit = async () => {
    if (!user) return;
    if (!courseId) {
      toast.error(t("contents.courseRequired"));
      return;
    }
    if (noneSelected) {
      toast.error(t("contents.classesRequired"));
      return;
    }
    if (scope === "per_cut" && courseCuts.length === 0) {
      toast.error(t("contents.scopePerCutNoCuts"));
      return;
    }
    setCreating(true);
    try {
      const description = extractContentText((content.files as ContentFile[]) ?? [], {
        classNumbers: isFull ? undefined : selectedArray,
      });
      // Título por defecto: si seleccionó UNA clase y no escribió
      // título, usamos "Tema — Clase N". Si seleccionó varias, "Tema
      // — Clases N, M, …". Si full, solo el tema.
      const fallbackTitle =
        isFull || selectedArray.length === 0
          ? content.topic
          : selectedArray.length === 1
            ? `${content.topic} — Clase ${selectedArray[0]}`
            : `${content.topic} — Clases ${selectedArray.join(", ")}`;
      const finalTitle = title.trim() || fallbackTitle;

      // Si el docente eligió "Por corte" → repetir el INSERT por cada
      // corte del curso, con cut_id seteado y título prefijado con el
      // nombre del corte ("Final de Corte 1: …"). Si es "course" →
      // 1 INSERT con cut_id null (comportamiento histórico).
      const cutTargets =
        scope === "per_cut" ? courseCuts : ([{ id: null as string | null, name: "" }] as const);
      let firstCreated: { kind: AssessmentTarget; id: string } | null = null;
      let createdCount = 0;
      for (const cut of cutTargets) {
        const insertTitle = cut.id ? `${cut.name}: ${finalTitle}` : finalTitle;
        const id = await insertAssessment(insertTitle, description, cut.id);
        if (id) {
          createdCount += 1;
          if (!firstCreated) firstCreated = { kind: target, id };
        }
      }
      if (createdCount === 0) {
        return; // ya se mostró el error en insertAssessment
      }
      if (scope === "per_cut") {
        toast.success(t("contents.scopePerCutCreatedToast", { count: createdCount }));
        // Al crear N evaluaciones no abrimos editor — eso forzaría N
        // pestañas. El docente las verá en sus grids respectivos.
        onCreated(target, firstCreated!.id);
      } else {
        onCreated(target, firstCreated!.id);
      }
      return;
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setCreating(false);
    }
  };

  /** INSERT helper compartido entre el modo "course" (1 fila) y
   *  "per_cut" (N filas). Devuelve el id creado o null si falló (con el
   *  toast ya mostrado). NO llama onCreated — eso es responsabilidad
   *  del caller, que decide qué hacer cuando se crearon N filas (no
   *  abrir el editor en bucle).
   *
   *  `source_content_id` se setea con backlink al contenido (la
   *  migración 20260510150000 lo agregó). Las 3 tablas tienen ON DELETE
   *  SET NULL: si después borran el contenido, las evaluaciones quedan
   *  intactas — solo se pierde el backlink.
   */
  const insertAssessment = async (
    insertTitle: string,
    description: string,
    cutId: string | null,
  ): Promise<string | null> => {
    if (!content || !user) return null;
    try {
      if (target === "exam") {
        const start = new Date();
        const end = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const { data, error } = await db
          .from("exams")
          .insert({
            course_id: courseId,
            title: insertTitle,
            description,
            start_time: start.toISOString(),
            end_time: end.toISOString(),
            time_limit_minutes: content.duration_minutes ?? 60,
            navigation_type: "libre",
            shuffle_enabled: false,
            created_by: user.id,
            source_content_id: content.id,
            cut_id: cutId,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(error?.message ?? "exam insert failed");
        return data.id as string;
      } else if (target === "workshop") {
        const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const { data, error } = await db
          .from("workshops")
          .insert({
            course_id: courseId,
            title: insertTitle,
            description,
            instructions: null,
            due_date: due.toISOString(),
            max_score: 100,
            status: "draft",
            created_by: user.id,
            source_content_id: content.id,
            cut_id: cutId,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(error?.message ?? "workshop insert failed");
        return data.id as string;
      } else {
        const { data, error } = await db
          .from("projects")
          .insert({
            course_id: courseId,
            title: insertTitle,
            description,
            max_score: 100,
            status: "draft",
            created_by: user.id,
            source_content_id: content.id,
            cut_id: cutId,
          })
          .select("id")
          .single();
        if (error || !data) throw new Error(error?.message ?? "project insert failed");
        return data.id as string;
      }
    } catch (e) {
      toast.error(friendlyError(e));
      return null;
    }
  };

  const previewText = extractContentText((content.files as ContentFile[]) ?? [], {
    classNumbers: isFull ? undefined : selectedArray,
    maxChars: 600,
  });

  return (
    <Dialog open={!!content} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("contents.createAssessmentTitle")}</DialogTitle>
          <DialogDescription>{t("contents.createAssessmentSubtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Tipo de evaluación */}
          <div className="space-y-1.5">
            <Label required>{t("contents.assessmentType")}</Label>
            {/* grid-cols-1 mobile-first → 3 col en sm+; antes era
                grid-cols-3 sin prefijo y los 3 botones quedaban
                apretados/ilegibles a 375px (cada uno tenía solo ~110px). */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {(
                [
                  { key: "workshop", label: t("contents.assessmentWorkshop") },
                  { key: "exam", label: t("contents.assessmentExam") },
                  { key: "project", label: t("contents.assessmentProject") },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setTarget(opt.key)}
                  className={`text-left rounded-md border p-2 text-xs transition-colors ${
                    target === opt.key
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium text-sm">{opt.label}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label required>{t("common.course")}</Label>
              <Select value={courseId} onValueChange={(v) => setCourseId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder={t("contents.courseRequired")} />
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
            <div className="space-y-1.5">
              <Label>{t("contents.assessmentTitle")}</Label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
          </div>

          {/* Selector de alcance por cortes — solo visible si el curso
              elegido tiene cortes definidos. "Curso completo" crea UNA
              evaluación (sin cut_id, comportamiento histórico).
              "Por corte" crea N evaluaciones, una por cada corte, con
              cut_id seteado y título prefijado con el nombre del corte
              ("Corte 1: …"). Útil para parciales finales por corte o
              para distribuir el peso de un examen entre cortes. */}
          {courseCuts.length > 0 && (
            <div className="space-y-1.5">
              <Label>{t("contents.scopeLabel")}</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setScope("course")}
                  className={`text-left rounded-md border p-2 text-xs transition-colors ${
                    scope === "course"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium text-sm">{t("contents.scopeWholeCourse")}</div>
                  <div className="text-[10px] text-muted-foreground">
                    {t("contents.scopeWholeCourseHint")}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setScope("per_cut")}
                  className={`text-left rounded-md border p-2 text-xs transition-colors ${
                    scope === "per_cut"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:bg-muted/40"
                  }`}
                >
                  <div className="font-medium text-sm">
                    {t("contents.scopePerCut", { count: courseCuts.length })}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {t("contents.scopePerCutHint")}
                  </div>
                </button>
              </div>
              {scope === "per_cut" && (
                <p className="text-[11px] text-muted-foreground">
                  {t("contents.scopePerCutPreview", {
                    names: courseCuts.map((c) => c.name).join(", "),
                  })}
                </p>
              )}
            </div>
          )}

          {/* Alcance: si el contenido es curso_completo, el docente
              elige una o varias clases (multi-select). El default es
              "Todas las clases" — si destildea todas o tilda algunas,
              la descripción inyectada se restringe a esas. Para
              material_individual no hay clases que filtrar. */}
          {classes.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("contents.noClassesDetected")}</p>
          ) : (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label>{t("contents.assessmentScope")}</Label>
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px]"
                    onClick={selectAll}
                  >
                    {t("contents.selectAllClasses")}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[11px]"
                    onClick={selectNone}
                  >
                    {t("contents.selectNoneClasses")}
                  </Button>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {isFull
                  ? t("contents.scopeFullHint")
                  : t("contents.classesSelectedSummary", {
                      count: selectedArray.length,
                      total: classes.length,
                    })}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 pt-1">
                {classes.map((n) => {
                  const checked = isFull || (selectedClasses?.has(n) ?? false);
                  const title = extractClassTitle((content.files as ContentFile[]) ?? [], n);
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() => toggleClass(n)}
                      className={`text-left rounded-md border p-2 text-xs transition-colors ${
                        checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 font-medium text-[12px]">
                        <input
                          type="checkbox"
                          checked={checked}
                          readOnly
                          className="h-3 w-3 accent-primary pointer-events-none"
                        />
                        {t("contents.classNumber")} {n}
                      </div>
                      {title && (
                        <div
                          className="text-[10px] text-muted-foreground mt-0.5 truncate"
                          title={title}
                        >
                          {title}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              {noneSelected && (
                <p className="text-[11px] text-destructive">{t("contents.classesRequired")}</p>
              )}
            </div>
          )}

          {/* Preview del texto que se inyectará como descripción.
              Sirve para que el docente vea el contexto que recibirá la
              IA al generar las preguntas, sin sorpresas. */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("contents.raw")}</Label>
            <Textarea
              value={previewText}
              readOnly
              className="font-mono text-[11px] min-h-[120px] max-h-[180px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={submit} disabled={creating || !courseId || noneSelected}>
            {creating ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <BookOpenCheck className="h-4 w-4 mr-1" />
            )}
            {creating ? t("contents.creatingAssessment") : t("contents.createAssessmentSubmit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────
// MaterializeCourseDialog
// Wizard que crea en lote las evaluaciones derivadas del contenido
// para CADA corte del curso. Acelera el flujo "abrir CreateAssessment
// 12 veces" cuando el curso tiene 4 cortes y se quiere taller+examen
// por cada uno + proyecto final.
//
// Reglas de propuesta:
//   - Pre-requisito: el curso tiene cortes Y las sesiones del contenido
//     ya están programadas. Si no, banner bloqueante con CTA al dialog
//     correspondiente.
//   - Para cada corte (orden por position):
//       * workshop_weight > 0 → propone 1 taller
//       * exam_weight     > 0 → propone 1 examen
//   - Para el ÚLTIMO corte (mayor position) con project_weight > 0:
//       * propone 1 proyecto
//   - Cada propuesta carga su rango de clases desde las sesiones
//     asignadas a este contenido cuya `session_date` cae en el rango
//     [cut.start_date, cut.end_date] del corte. Si el corte no tiene
//     sesiones en su rango, la propuesta se omite con nota visible.
//
// El docente ve cada propuesta como una fila con checkbox + título
// editable + chip con el rango de clases. Al confirmar, todas las
// marcadas se INSERT en una pasada y se setea `source_content_id`
// para que aparezcan en los conteos derivados del grid.
// ──────────────────────────────────────────────────────────────────────

interface CutRow {
  id: string;
  course_id: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  workshop_weight: number;
  exam_weight: number;
  project_weight: number;
  attendance_weight: number;
}

type ProposalType = "workshop" | "exam" | "project";

interface Proposal {
  key: string;
  cutId: string;
  cutName: string;
  type: ProposalType;
  title: string;
  weight: number;
  classNumbers: number[];
  /** Si true, la propuesta NO se puede activar (no hay clases en el
   *  rango del corte). El check queda fijo en off y se muestra una
   *  nota explicando por qué. */
  disabled: boolean;
}

function MaterializeCourseDialog({
  content,
  onClose,
  onCreated,
  onOpenSessionsDialog,
}: {
  content: GeneratedContent | null;
  onClose: () => void;
  onCreated: () => void;
  onOpenSessionsDialog: () => void;
}) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [cuts, setCuts] = useState<CutRow[]>([]);
  const [contentSessions, setContentSessions] = useState<
    { session_date: string; content_class_index: number | null }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  /** key → checked. Default ON para no-disabled, OFF para disabled. */
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  /** key → title editable por el docente. */
  const [titles, setTitles] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!content?.course_id) {
      setCuts([]);
      setContentSessions([]);
      return;
    }
    setLoading(true);
    void (async () => {
      const [{ data: cs }, { data: ss }] = await Promise.all([
        db
          .from("grade_cuts")
          .select(
            "id, course_id, name, position, start_date, end_date, weight, workshop_weight, exam_weight, project_weight, attendance_weight",
          )
          .eq("course_id", content.course_id)
          .order("position", { ascending: true }),
        db
          .from("attendance_sessions")
          .select("session_date, content_class_index")
          .eq("course_id", content.course_id)
          .eq("content_id", content.id),
      ]);
      setCuts((cs ?? []) as CutRow[]);
      setContentSessions(
        (ss ?? []) as { session_date: string; content_class_index: number | null }[],
      );
      setLoading(false);
    })();
  }, [content]);

  // Construye las propuestas a partir de cuts + sessions.
  const proposals = useMemo<Proposal[]>(() => {
    if (!content || cuts.length === 0) return [];
    const out: Proposal[] = [];
    const lastCutPos = Math.max(...cuts.map((c) => c.position));
    for (const cut of cuts) {
      // Clases que caen en [cut.start_date, cut.end_date]. Si el corte
      // no tiene fechas configuradas, no podemos filtrar — saltamos.
      let classNumbers: number[] = [];
      if (cut.start_date && cut.end_date) {
        const inRange = contentSessions.filter(
          (s) => s.session_date >= cut.start_date! && s.session_date <= cut.end_date!,
        );
        const setNs = new Set<number>();
        for (const s of inRange) {
          if (s.content_class_index && s.content_class_index > 0) {
            setNs.add(s.content_class_index);
          }
        }
        classNumbers = Array.from(setNs).sort((a, b) => a - b);
      }
      const disabled = classNumbers.length === 0;

      // Taller — bucket > 0.
      if (cut.workshop_weight > 0) {
        out.push({
          key: `${cut.id}:workshop`,
          cutId: cut.id,
          cutName: cut.name,
          type: "workshop",
          title: `${t("contents.assessmentWorkshop")} ${cut.name} — ${content.topic}`,
          weight: Number(cut.workshop_weight),
          classNumbers,
          disabled,
        });
      }
      // Examen — bucket > 0.
      if (cut.exam_weight > 0) {
        out.push({
          key: `${cut.id}:exam`,
          cutId: cut.id,
          cutName: cut.name,
          type: "exam",
          title: `${t("contents.assessmentExam")} ${cut.name} — ${content.topic}`,
          weight: Number(cut.exam_weight),
          classNumbers,
          disabled,
        });
      }
      // Proyecto — solo en el último corte con bucket > 0.
      if (cut.position === lastCutPos && cut.project_weight > 0) {
        out.push({
          key: `${cut.id}:project`,
          cutId: cut.id,
          cutName: cut.name,
          type: "project",
          title: `${t("contents.assessmentProject")} — ${content.topic}`,
          weight: Number(cut.project_weight),
          classNumbers,
          disabled,
        });
      }
    }
    return out;
  }, [content, cuts, contentSessions, t]);

  // Inicializa checked + titles cuando cambian las propuestas.
  useEffect(() => {
    const c: Record<string, boolean> = {};
    const ts: Record<string, string> = {};
    for (const p of proposals) {
      c[p.key] = !p.disabled;
      ts[p.key] = p.title;
    }
    setChecked(c);
    setTitles(ts);
  }, [proposals]);

  if (!content) return null;

  const hasSessions = contentSessions.length > 0;
  const hasCuts = cuts.length > 0;
  const checkedCount = proposals.filter((p) => checked[p.key] && !p.disabled).length;

  const submit = async () => {
    if (!user || !content.course_id) return;
    setCreating(true);
    try {
      const files = (content.files as ContentFile[]) ?? [];
      // Una sola pasada — los INSERTs van secuenciales para mantener
      // mensajes de error claros si alguno falla a mitad. La cantidad
      // típica (4 cortes × 2-3 evaluaciones = 8-12) no justifica
      // batchear en una sola query.
      let createdCount = 0;
      let firstId: { kind: ProposalType; id: string } | null = null;

      for (const p of proposals) {
        if (!checked[p.key] || p.disabled) continue;
        const desc = extractContentText(files, { classNumbers: p.classNumbers });
        const finalTitle = (titles[p.key] ?? p.title).trim() || p.title;

        if (p.type === "exam") {
          const start = new Date();
          const end = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
          const { data, error } = await db
            .from("exams")
            .insert({
              course_id: content.course_id,
              title: finalTitle,
              description: desc,
              start_time: start.toISOString(),
              end_time: end.toISOString(),
              time_limit_minutes: content.duration_minutes ?? 60,
              navigation_type: "libre",
              shuffle_enabled: false,
              created_by: user.id,
              source_content_id: content.id,
              cut_id: p.cutId,
              weight: p.weight,
            })
            .select("id")
            .single();
          if (error || !data) throw new Error(error?.message ?? "exam insert failed");
          createdCount += 1;
          if (!firstId) firstId = { kind: "exam", id: data.id };
        } else if (p.type === "workshop") {
          const due = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
          const { data, error } = await db
            .from("workshops")
            .insert({
              course_id: content.course_id,
              title: finalTitle,
              description: desc,
              instructions: null,
              due_date: due.toISOString(),
              max_score: 100,
              status: "draft",
              created_by: user.id,
              source_content_id: content.id,
              cut_id: p.cutId,
              weight: p.weight,
            })
            .select("id")
            .single();
          if (error || !data) throw new Error(error?.message ?? "workshop insert failed");
          createdCount += 1;
          if (!firstId) firstId = { kind: "workshop", id: data.id };
        } else {
          const { data, error } = await db
            .from("projects")
            .insert({
              course_id: content.course_id,
              title: finalTitle,
              description: desc,
              max_score: 100,
              status: "draft",
              created_by: user.id,
              source_content_id: content.id,
              cut_id: p.cutId,
              weight: p.weight,
            })
            .select("id")
            .single();
          if (error || !data) throw new Error(error?.message ?? "project insert failed");
          createdCount += 1;
          if (!firstId) firstId = { kind: "project", id: data.id };
        }
      }

      toast.success(t("contents.materializeCreatedToast", { count: createdCount }));
      onCreated();
      // Si solo se creó UNA evaluación, llevamos al docente a su editor
      // (mismo comportamiento que CreateAssessmentDialog). Si se crearon
      // varias, lo dejamos en el grid de Contenidos para que vea los
      // conteos derivados actualizados — abrir N pestañas sería ruido.
      if (createdCount === 1 && firstId) {
        if (firstId.kind === "exam") {
          void navigate({ to: `/app/teacher/exams/${firstId.id}` });
        } else if (firstId.kind === "workshop") {
          void navigate({ to: "/app/teacher/workshops", search: { edit: firstId.id } });
        } else {
          void navigate({ to: "/app/teacher/projects", search: { edit: firstId.id } });
        }
      }
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={!!content} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpenCheck className="h-5 w-5 text-primary" />
            {t("contents.materializeTitle")}
          </DialogTitle>
          <DialogDescription>{t("contents.materializeSubtitle")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : !hasCuts ? (
          // Pre-requisito 1: el curso tiene cortes. Sin ellos no
          // sabemos cómo dividir las evaluaciones.
          <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-4 text-xs space-y-2">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
              <AlertCircle className="h-4 w-4" />
              {t("contents.materializeNoCutsTitle")}
            </div>
            <p className="text-muted-foreground">{t("contents.materializeNoCutsBody")}</p>
          </div>
        ) : !hasSessions ? (
          // Pre-requisito 2: las sesiones del contenido están programadas.
          // Sin ellas no podemos derivar los rangos de clases por corte.
          <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-4 text-xs space-y-2">
            <div className="flex items-center gap-2 font-medium text-amber-700 dark:text-amber-300">
              <AlertCircle className="h-4 w-4" />
              {t("contents.materializeNoSessionsTitle")}
            </div>
            <p className="text-muted-foreground">{t("contents.materializeNoSessionsBody")}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onClose();
                onOpenSessionsDialog();
              }}
            >
              <CalendarPlus className="h-3.5 w-3.5 mr-1" />
              {t("contents.generateSessions")}
            </Button>
          </div>
        ) : proposals.length === 0 ? (
          <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
            {t("contents.materializeNoProposals")}
          </div>
        ) : (
          <div className="space-y-2 max-h-[55vh] overflow-y-auto">
            {proposals.map((p) => {
              const isChecked = !!checked[p.key];
              return (
                <div
                  key={p.key}
                  className={`rounded-md border p-3 space-y-2 ${
                    p.disabled
                      ? "opacity-60 bg-muted/20"
                      : isChecked
                        ? "border-primary/40 bg-primary/5"
                        : "border-border"
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      disabled={p.disabled}
                      onChange={(e) =>
                        setChecked((prev) => ({ ...prev, [p.key]: e.target.checked }))
                      }
                      className="mt-1 h-4 w-4 accent-primary"
                    />
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[10px]">
                          {p.type === "workshop"
                            ? t("contents.assessmentWorkshop")
                            : p.type === "exam"
                              ? t("contents.assessmentExam")
                              : t("contents.assessmentProject")}
                        </Badge>
                        <span className="text-[11px] text-muted-foreground">{p.cutName}</span>
                        <Badge variant="secondary" className="text-[10px]">
                          {t("contents.materializeWeight", { weight: p.weight })}
                        </Badge>
                        {p.classNumbers.length > 0 && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("contents.materializeClasses", {
                              classes: p.classNumbers.join(", "),
                            })}
                          </Badge>
                        )}
                      </div>
                      <Input
                        value={titles[p.key] ?? ""}
                        onChange={(e) =>
                          setTitles((prev) => ({ ...prev, [p.key]: e.target.value }))
                        }
                        disabled={p.disabled || !isChecked}
                        className="h-8 text-xs"
                        placeholder={p.title}
                      />
                      {p.disabled && (
                        <p className="text-[10px] text-amber-700 dark:text-amber-400">
                          {t("contents.materializeNoClassesInRange")}
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={creating || !hasCuts || !hasSessions || checkedCount === 0}
          >
            {creating ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <BookOpenCheck className="h-4 w-4 mr-1" />
            )}
            {creating
              ? t("contents.materializeCreating")
              : t("contents.materializeSubmit", { count: checkedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AttendanceSessionRow {
  id: string;
  session_date: string;
  title: string | null;
  content_id: string | null;
  content_class_index: number | null;
}

/**
 * Dialog "Asignar a sesiones": el docente mapea CADA clase del
 * contenido (curso_completo) o el contenido entero (material_individual)
 * a una sesión de asistencia del curso. La asignación persiste en
 * `attendance_sessions.content_id` + `content_class_index` y aparece
 * en el tablero del estudiante.
 *
 * Estrategia de UI:
 *   - Lista de sesiones del curso (ordenadas por session_date).
 *   - Por cada sesión, un Select con opciones:
 *       * "Sin contenido"
 *       * Para curso_completo: "Clase 1", "Clase 2", … (números de
 *         CLASE_N detectados en files[]).
 *       * Para material_individual: "Asignar este contenido"
 *   - Save persiste todos los cambios en una transacción lógica
 *     (loop de updates; bastante con el INSERT-or-UPDATE flow).
 *
 * Multi-asignación: una clase puede usarse en una sola sesión a la
 * vez (1:1). Si el docente asigna Clase 3 a Sesión X y la sesión Y
 * ya tenía Clase 3, NO bloqueamos — preferimos "última edición gana".
 * El estudiante puede tener material duplicado en dos sesiones, lo
 * cual es válido (clase de repaso, sesión adelantada, etc.).
 */
function AssignToSessionsDialog({
  content,
  onClose,
}: {
  content: GeneratedContent | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<AttendanceSessionRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // Map sesiónId → seleccionado: -1 = sin contenido / N = clase N.
  // Para material_individual, 0 = "asignado al contenido completo".
  const [draft, setDraft] = useState<Record<string, number>>({});

  const classes = useMemo(
    () => (content ? availableClassNumbers((content.files as ContentFile[]) ?? []) : []),
    [content],
  );
  const isCursoCompleto = content?.mode === "curso_completo";

  useEffect(() => {
    if (!content?.course_id) {
      setSessions([]);
      setDraft({});
      return;
    }
    setLoading(true);
    void (async () => {
      const { data } = await db
        .from("attendance_sessions")
        .select("id, session_date, title, content_id, content_class_index")
        .eq("course_id", content.course_id)
        .order("session_date", { ascending: true });
      const rows = (data ?? []) as AttendanceSessionRow[];
      setSessions(rows);
      // Pre-rellena el draft con la asignación actual: si la sesión
      // YA apunta a este contenido, conservamos su class_index. Si
      // apunta a otro contenido o a nada, queda en "sin contenido".
      const next: Record<string, number> = {};
      for (const s of rows) {
        if (s.content_id === content.id) {
          next[s.id] = s.content_class_index ?? 0;
        } else {
          next[s.id] = -1;
        }
      }
      setDraft(next);
      setLoading(false);
    })();
  }, [content]);

  if (!content) return null;

  const save = async () => {
    setSaving(true);
    try {
      // Recorre las sesiones y aplica solo los cambios respecto del
      // estado original. Esto evita escrituras innecesarias y reduce
      // el ruido en triggers/audit logs.
      const ops = sessions
        .map((s) => {
          const target = draft[s.id] ?? -1;
          const wasAssigned = s.content_id === content.id;
          const wasIndex = s.content_class_index ?? (wasAssigned ? 0 : -1);
          if (wasAssigned && target === wasIndex) return null;
          // -1 = limpiar asignación SOLO si actualmente apunta a este content
          if (target === -1 && !wasAssigned) return null;
          return {
            id: s.id,
            content_id: target === -1 ? null : content.id,
            content_class_index: target > 0 ? target : null,
          };
        })
        .filter(
          (x): x is { id: string; content_id: string | null; content_class_index: number | null } =>
            x != null,
        );

      for (const op of ops) {
        const { error } = await db
          .from("attendance_sessions")
          .update({ content_id: op.content_id, content_class_index: op.content_class_index })
          .eq("id", op.id);
        if (error) throw new Error(error.message);
      }
      toast.success(t("contents.assignSavedToast", { count: ops.length }));
      onClose();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!content} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("contents.assignDialogTitle")}</DialogTitle>
          <DialogDescription>{t("contents.assignDialogSubtitle")}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : sessions.length === 0 ? (
          <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
            {t("contents.assignNoSessions")}
          </div>
        ) : (
          <div className="space-y-2 max-h-[55vh] overflow-y-auto pr-2">
            {sessions.map((s) => {
              const value = draft[s.id] ?? -1;
              return (
                <div key={s.id} className="flex items-center gap-3 rounded-md border p-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium tabular-nums">{s.session_date}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {s.title || t("contents.assignSessionUntitled")}
                    </div>
                  </div>
                  <Select
                    value={String(value)}
                    onValueChange={(v) => setDraft((prev) => ({ ...prev, [s.id]: Number(v) }))}
                  >
                    <SelectTrigger className="w-44 h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="-1">{t("contents.assignNone")}</SelectItem>
                      {isCursoCompleto && classes.length > 0 ? (
                        classes.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {t("contents.classNumber")} {n}
                          </SelectItem>
                        ))
                      ) : (
                        <SelectItem value="0">{t("contents.assignWhole")}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || loading || sessions.length === 0}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <CalendarRange className="h-4 w-4 mr-1" />
            )}
            {saving ? t("contents.assignSaving") : t("contents.assignSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ──────────────────────────────────────────────────────────────────────
// FilesByClassDialog
// Modal que organiza los archivos generados por clase para que el
// docente pueda navegar curso_completo sin scrollear 24 botones planos.
// Para material_individual cae a una lista plana — no hay nada que
// agrupar.
// ──────────────────────────────────────────────────────────────────────

/** Etiqueta humana corta. Replica la del tablero del estudiante para
 *  mantener vocabulario consistente. Se usa ahora solo en tooltip
 *  (los botones del modal son icon-only para no ensanchar la columna).
 *  Orden de detección: SOLUCION antes que EJERCICIO genérico — porque
 *  el filename de la solución incluye ambos sufijos. */
function humanLabelForFile(f: FileEntry): string {
  if (f.kind === "pptx-source") return "Presentación";
  if (f.kind === "md") {
    const u = f.name.toUpperCase();
    if (u.includes("SOLUCION") || u.includes("SOLUTION")) return "Ejercicio (con solución)";
    if (u.includes("EJERCICIO")) return "Ejercicio (estudiante)";
    if (u.includes("GUIA")) return "Guía docente";
    if (u.includes("TALLER") || u.includes("PRACTICO")) return "Taller práctico";
    if (u.includes("INTRO")) return "Introducción";
    return "Material";
  }
  return f.name;
}

/** Construye el filename amigable que descarga el navegador. Reemplaza
 *  los códigos tipo `GUIA_DOCENTE_CLASE_1.MD` por algo legible:
 *  `Guía Docente Clase 1 - Tema.md`. Si el tema no se conoce, omite el
 *  sufijo. Preserva la extensión original (sin `.txt` de la fuente
 *  pptx — eso lo recorta la lógica de descarga aparte). */
function buildDownloadName(f: FileEntry, classNumber: number | null, topic: string | null): string {
  // Extensión: para pptx-source es ".pptx" (sin el .txt sufijo);
  // para los demás respetamos lo que diga el filename.
  const extMatch = f.name.match(/\.([a-zA-Z0-9]+)$/);
  let ext = extMatch ? `.${extMatch[1]}` : "";
  if (f.kind === "pptx-source") ext = ".pptx";
  // Sanitiza para filesystem (Windows + Linux + macOS son estrictos
  // con < > : " / \ | ? * + chars de control).
  const sanitize = (s: string) =>
    s
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const baseLabel = humanLabelForFile(f);
  const classBit = classNumber != null ? ` Clase ${classNumber}` : "";
  const topicBit = topic ? ` - ${topic}` : "";
  const composed = sanitize(`${baseLabel}${classBit}${topicBit}`).slice(0, 120);
  return composed ? `${composed}${ext}` : f.name.replace(/\.txt$/i, "");
}

/** Icono por tipo de archivo — usado en chips icon-only para que el
 *  docente distinga "Guía docente" de "Taller práctico" sin leer el
 *  label. La detección replica humanLabelForFile (mismo orden). */
function iconForFile(f: FileEntry): LucideIcon {
  if (f.kind === "pptx-source") return Presentation;
  if (f.kind === "md") {
    const u = f.name.toUpperCase();
    if (u.includes("SOLUCION") || u.includes("SOLUTION")) return CheckSquare;
    if (u.includes("EJERCICIO")) return ClipboardList;
    if (u.includes("GUIA")) return BookOpen;
    if (u.includes("TALLER") || u.includes("PRACTICO")) return Hammer;
    if (u.includes("INTRO")) return SparklesIcon;
  }
  return FileText;
}

// ──────────────────────────────────────────────────────────────────────
// GenerateSessionsDialog
// Genera N sesiones de attendance_sessions a partir del contenido
// (curso_completo o material_individual). El docente elige fecha de
// inicio + días de la semana; el dialog calcula las N fechas, muestra
// la vista previa con los títulos extraídos por clase, y al guardar:
//   - Si NO hay sesiones existentes en el curso: crea las N nuevas.
//   - Si SÍ hay: pregunta "Reusar las N primeras existentes" o "Crear
//     N nuevas igual" (con botones radio inline).
// La asignación de clase a sesión es 1:1 por orden cronológico:
// Clase 1 → primera sesión, Clase 2 → segunda, etc.
// ──────────────────────────────────────────────────────────────────────

/** Día de la semana en es-CO. Index = JS Date.getDay() (0=Dom..6=Sáb).
 *  Reordenamos visualmente para arrancar en Lun (índice 1) que es lo
 *  que esperaría un docente latinoamericano. */
// Helpers de fechas (WEEKDAYS_ES, computeSessionDates, toLocalIsoDate)
// y el componente GenerateSessionsDialog se movieron a módulos
// dedicados para reusarlos desde el tablero de asistencia.
// - Helpers: `src/lib/session-dates.ts`
// - Componente: `src/components/GenerateSessionsDialog.tsx`

function FilesByClassDialog({
  content,
  brand,
  downloadingPath,
  onDownload,
  onDeleteFile,
  onRegenerateClass,
  onClose,
}: {
  content: GeneratedContent | null;
  brand: BrandConfig | null;
  downloadingPath: string | null;
  onDownload: (file: FileEntry) => void;
  onDeleteFile: (file: FileEntry) => void;
  onRegenerateClass: (classNumber: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // brand actualmente no se usa en este componente (la marca se aplica
  // al construir el .pptx en el caller). Lo recibimos por si en futuro
  // queremos previsualizar logos por sección.
  void brand;

  // Sesiones de asistencia ya asignadas a este contenido (por
  // `attendance_sessions.content_id = content.id`). Indexamos por
  // `content_class_index` para mostrar "Sesión: <fecha> — <título>"
  // arriba de los archivos de cada clase. Si el contenido no tiene
  // course_id no consultamos.
  const [sessionsByClass, setSessionsByClass] = useState<
    Record<number, { date: string; title: string | null }>
  >({});
  // Archivo .md seleccionado para previsualizar inline (sin descargar).
  // El body viene del JSONB almacenado en generated_contents.files.
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  // Archivo .pptx-source seleccionado para visualizar/editar slide-by-slide.
  // Separado del preview .md porque usa otro componente (PptxViewerDialog).
  const [pptxPreviewFile, setPptxPreviewFile] = useState<FileEntry | null>(null);
  // Modo inicial al abrir cualquiera de los dos viewers — "edit" cuando
  // el docente pulsa el lápiz directamente desde la chip; "view" cuando
  // pulsa el icono de tipo (entra a vista previa con botón Editar).
  const [viewerInitialMode, setViewerInitialMode] = useState<"view" | "edit">("view");
  // Tras guardar ediciones en el viewer, refrescamos localmente el body
  // del file en content.files para que el siguiente "Vista previa" no
  // muestre stale data. El padre vuelve a llamar load() en parallelismo,
  // pero esto mantiene el dialog actual coherente.
  const [bodyOverrides, setBodyOverrides] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!content || !content.course_id) {
      setSessionsByClass({});
      return;
    }
    void (async () => {
      const { data } = await db
        .from("attendance_sessions")
        .select("session_date, title, content_class_index")
        .eq("course_id", content.course_id)
        .eq("content_id", content.id)
        .order("session_date", { ascending: true });
      const next: Record<number, { date: string; title: string | null }> = {};
      for (const r of (data ?? []) as Array<{
        session_date: string;
        title: string | null;
        content_class_index: number | null;
      }>) {
        // 0 = "asignación al contenido completo" (modo individual);
        // null = sin clase específica. En ambos casos guardamos bajo
        // index=0 para que material_individual también muestre la fecha
        // de la sesión asignada.
        const idx = r.content_class_index ?? 0;
        next[idx] = { date: r.session_date, title: r.title };
      }
      setSessionsByClass(next);
    })();
  }, [content]);

  if (!content) return null;

  const files = (content.files ?? []) as FileEntry[];
  const isCourse = content.mode === "curso_completo";
  const isProcessing = content.status === "processing";

  // Particiona archivos en intro + por clase. Con fallback de orden
  // cuando el modelo no respetó el sufijo `_CLASE_<N>`.
  const { intro, byClass } = groupFilesByClass(files as ContentFile[], content.n_classes);
  const classNumbers = Array.from(byClass.keys()).sort((a, b) => a - b);

  /** Render compacto de chip por material. 4 botones inline de 24x24px
   *  con iconos de 12px (h-3 w-3): tipo (vista previa) + editar +
   *  descargar + eliminar. Total ~96px por chip (vs 112px original).
   *  Las acciones quedan visibles sin clicks adicionales — el menú "..."
   *  se descartó porque el usuario prefiere ver las opciones directo. */
  const renderFileChip = (f: FileEntry) => {
    const path = `${content.id}:${f.path}`;
    const busy = downloadingPath === path;
    const isMdLike = f.kind === "md" || f.kind === "txt";
    const isPptx = f.kind === "pptx-source";
    const canPreview = (isMdLike || isPptx) && !!f.body;
    const TypeIcon = iconForFile(f);
    const label = humanLabelForFile(f);
    const effectiveBody = bodyOverrides[f.path] ?? f.body;
    const fileWithBody: FileEntry = { ...f, body: effectiveBody };

    const openViewer = (mode: "view" | "edit") => {
      setViewerInitialMode(mode);
      if (isPptx) setPptxPreviewFile(fileWithBody);
      else setPreviewFile(fileWithBody);
    };

    // Click directo en el icono del tipo: vista previa si es previewable;
    // descarga directa si no. Es la acción más usada.
    const primaryAction = canPreview ? () => openViewer("view") : () => onDownload(fileWithBody);
    const primaryHint = canPreview ? t("contents.previewHint") : t("contents.downloadHint");

    return (
      <div key={f.path} className="inline-flex rounded-md border overflow-hidden">
        <button
          type="button"
          disabled={busy}
          onClick={primaryAction}
          className="flex items-center justify-center w-6 h-6 hover:bg-muted/60 transition-colors disabled:opacity-60"
          title={`${label} — ${primaryHint}`}
          aria-label={`${label} — ${primaryHint}`}
        >
          {busy ? <Spinner size="xs" /> : <TypeIcon className="h-3 w-3" />}
        </button>
        {canPreview && (
          <button
            type="button"
            onClick={() => openViewer("edit")}
            className="flex items-center justify-center w-6 h-6 border-l text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors"
            title={`${label} — ${t("contents.editOnline")}`}
            aria-label={`${label} — ${t("contents.editOnline")}`}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {canPreview && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDownload(fileWithBody)}
            className="flex items-center justify-center w-6 h-6 border-l text-muted-foreground hover:bg-muted/60 hover:text-foreground transition-colors disabled:opacity-60"
            title={`${label} — ${t("contents.downloadHint")}`}
            aria-label={`${label} — ${t("contents.downloadHint")}`}
          >
            <Download className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onDeleteFile(f)}
          className="flex items-center justify-center w-6 h-6 border-l text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          title={`${label} — ${t("contents.deleteFileHint")}`}
          aria-label={`${label} — ${t("contents.deleteFileHint")}`}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  /** Render de un material como fila dentro del Popover de materiales
   *  del grid de clases. A diferencia de renderFileChip (que es solo
   *  iconos), aquí mostramos el nombre humano del material + las 3
   *  acciones a la derecha. Más legible cuando hay 4-5 materiales por
   *  clase. Click en el nombre = vista previa (o descarga). */
  const renderMaterialItem = (f: FileEntry) => {
    const path = `${content.id}:${f.path}`;
    const busy = downloadingPath === path;
    const isMdLike = f.kind === "md" || f.kind === "txt";
    const isPptx = f.kind === "pptx-source";
    const canPreview = (isMdLike || isPptx) && !!f.body;
    const TypeIcon = iconForFile(f);
    const label = humanLabelForFile(f);
    const effectiveBody = bodyOverrides[f.path] ?? f.body;
    const fileWithBody: FileEntry = { ...f, body: effectiveBody };

    const openViewer = (mode: "view" | "edit") => {
      setViewerInitialMode(mode);
      if (isPptx) setPptxPreviewFile(fileWithBody);
      else setPreviewFile(fileWithBody);
    };

    const primaryAction = canPreview ? () => openViewer("view") : () => onDownload(fileWithBody);
    const primaryHint = canPreview ? t("contents.previewHint") : t("contents.downloadHint");

    return (
      <div
        key={f.path}
        className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/50 transition-colors"
      >
        <button
          type="button"
          onClick={primaryAction}
          disabled={busy}
          className="flex flex-1 items-center gap-2 text-left text-xs disabled:opacity-60"
          title={`${label} — ${primaryHint}`}
        >
          {busy ? <Spinner size="xs" /> : <TypeIcon className="h-3.5 w-3.5 shrink-0" />}
          <span className="truncate">{label}</span>
        </button>
        {canPreview && (
          <button
            type="button"
            onClick={() => openViewer("edit")}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-colors"
            title={t("contents.editOnline")}
            aria-label={t("contents.editOnline")}
          >
            <Pencil className="h-3 w-3" />
          </button>
        )}
        {canPreview && (
          <button
            type="button"
            disabled={busy}
            onClick={() => onDownload(fileWithBody)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground transition-colors disabled:opacity-60"
            title={t("contents.downloadHint")}
            aria-label={t("contents.downloadHint")}
          >
            <Download className="h-3 w-3" />
          </button>
        )}
        <button
          type="button"
          onClick={() => onDeleteFile(f)}
          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          title={t("contents.deleteFileHint")}
          aria-label={t("contents.deleteFileHint")}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>
    );
  };

  return (
    <>
      <Dialog open={!!content} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-primary" />
              {content.topic}
            </DialogTitle>
            <DialogDescription>
              {isCourse
                ? t("contents.viewFilesByClassSubtitleCourse", {
                    count: classNumbers.length,
                  })
                : t("contents.viewFilesByClassSubtitleSingle")}
            </DialogDescription>
          </DialogHeader>

          {files.length === 0 ? (
            <div className="rounded-md border bg-muted/30 p-4 text-xs text-muted-foreground">
              {t("contents.viewFilesByClassEmpty")}
            </div>
          ) : (
            <div className="space-y-4">
              {/* En curso_completo, los archivos sueltos (intro) van como
                  un Card aparte arriba del grid. En material_individual los
                  pintamos directo como una fila del mismo grid (abajo) para
                  unificar el diseño visual. */}
              {isCourse && intro.length > 0 && (
                <Card>
                  <CardContent className="p-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                      <div className="text-sm font-medium">
                        {t("contents.viewFilesByClassIntro")}
                      </div>
                      <div className="flex flex-wrap gap-1.5">{intro.map(renderFileChip)}</div>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Grid: curso_completo muestra una fila por clase; material
                  individual muestra UNA fila con todos los archivos. */}
              {(classNumbers.length > 0 || (!isCourse && intro.length > 0)) && (
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12 text-center">#</TableHead>
                        <TableHead>{t("contents.classNumber")}</TableHead>
                        <TableHead className="hidden md:table-cell w-32">
                          {t("contents.classSessionCol")}
                        </TableHead>
                        <TableHead>{t("contents.classMaterialsCol")}</TableHead>
                        <TableHead className="w-12 text-right">
                          {t("contents.classActionsCol")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {/* Fila para material_individual: una sola fila con
                          TODOS los archivos como popover. La sesión puede
                          estar mapeada a content_class_index = 0 (o null). */}
                      {!isCourse && intro.length > 0 && (
                        <TableRow>
                          <TableCell className="text-center text-muted-foreground">—</TableCell>
                          <TableCell>
                            <div
                              className="text-sm font-medium truncate max-w-[320px]"
                              title={t("contents.viewFilesByClassMaterials")}
                            >
                              {t("contents.viewFilesByClassMaterials")}
                            </div>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            {sessionsByClass[0] ? (
                              <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-1 text-[11px]">
                                  <CalendarRange className="h-3 w-3 shrink-0 text-muted-foreground" />
                                  <DateCell value={sessionsByClass[0].date} variant="date" />
                                </div>
                                {sessionsByClass[0].title && (
                                  <span className="text-[11px] text-muted-foreground truncate max-w-[120px]">
                                    {sessionsByClass[0].title}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <Badge
                                variant="outline"
                                className="text-[10px] font-normal text-muted-foreground"
                                title={t("contents.classNoSessionHint")}
                              >
                                {t("contents.classNoSession")}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell>
                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2 text-xs"
                                  title={`Materiales (${intro.length})`}
                                >
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                  <span className="ml-1 tabular-nums text-[10px] text-muted-foreground">
                                    {intro.length}
                                  </span>
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent align="start" className="w-72 p-1">
                                <div className="space-y-0.5">{intro.map(renderMaterialItem)}</div>
                              </PopoverContent>
                            </Popover>
                          </TableCell>
                          {/* Acciones: no hay "regenerar clase" en modo individual */}
                          <TableCell className="text-right" />
                        </TableRow>
                      )}
                      {classNumbers.map((n) => {
                        const session = sessionsByClass[n];
                        const sectionFiles = byClass.get(n) ?? [];
                        // Preferimos el título extraído desde el bucket (funciona
                        // aún cuando los filenames no tienen sufijo CLASE_N — caso
                        // típico del fallback de groupFilesByClass).
                        const title =
                          extractClassTitleFromBucket(sectionFiles as ContentFile[]) ??
                          extractClassTitle(files as ContentFile[], n);
                        return (
                          <TableRow key={n}>
                            <TableCell className="text-center font-medium tabular-nums">
                              {n}
                            </TableCell>
                            <TableCell>
                              {/* Formato "Clase X: Tema" en una sola línea
                                  (con truncate para no romper el ancho
                                  del grid). Si no hay tema todavía, solo
                                  muestra "Clase X". */}
                              <div
                                className="text-sm font-medium truncate max-w-[320px]"
                                title={
                                  title ? `${t("contents.classNumber")} ${n}: ${title}` : undefined
                                }
                              >
                                {t("contents.classNumber")} {n}
                                {title ? `: ${title}` : ""}
                              </div>
                            </TableCell>
                            <TableCell className="hidden md:table-cell">
                              {session ? (
                                <div className="flex flex-col gap-0.5">
                                  <div className="flex items-center gap-1 text-[11px]">
                                    <CalendarRange className="h-3 w-3 shrink-0 text-muted-foreground" />
                                    <DateCell value={session.date} variant="date" />
                                  </div>
                                  {session.title && (
                                    <span className="text-[11px] text-muted-foreground truncate max-w-[120px]">
                                      {session.title}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] font-normal text-muted-foreground"
                                  title={t("contents.classNoSessionHint")}
                                >
                                  {t("contents.classNoSession")}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              {sectionFiles.length > 0 ? (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-xs"
                                      title={`Materiales (${sectionFiles.length})`}
                                    >
                                      <MoreHorizontal className="h-3.5 w-3.5" />
                                      <span className="ml-1 tabular-nums text-[10px] text-muted-foreground">
                                        {sectionFiles.length}
                                      </span>
                                    </Button>
                                  </PopoverTrigger>
                                  <PopoverContent align="start" className="w-72 p-1">
                                    <div className="space-y-0.5">
                                      {sectionFiles.map(renderMaterialItem)}
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              ) : (
                                <span className="text-[11px] text-muted-foreground/60">
                                  {t("contents.viewFilesByClassEmpty")}
                                </span>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              <RowAction
                                label={t("contents.regenerateClass")}
                                icon={Wand2}
                                disabled={isProcessing}
                                loading={isProcessing}
                                onClick={() => onRegenerateClass(n)}
                              />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Preview/editor inline para archivos .md/.txt. View mode usa
          react-markdown; edit mode swap a Textarea raw para ajustes
          rápidos. Al guardar, sube a storage (upsert) + actualiza el
          JSONB files[].body — misma estrategia que PptxViewerDialog. */}
      <MarkdownEditorDialog
        file={previewFile}
        contentId={content.id}
        initialMode={viewerInitialMode}
        onClose={() => setPreviewFile(null)}
        onSaved={(newBody) => {
          if (previewFile) setBodyOverrides((prev) => ({ ...prev, [previewFile.path]: newBody }));
        }}
      />

      {/* Viewer/editor de presentaciones .pptx-source. Reusa el JSONB
          `files[].body` para parsear las slides; al guardar persiste a
          storage (upsert el .pptx.txt) y al JSONB del contenido. */}
      <PptxViewerDialog
        open={pptxPreviewFile != null}
        onOpenChange={(o) => !o && setPptxPreviewFile(null)}
        file={pptxPreviewFile}
        contentId={content.id}
        initialMode={viewerInitialMode}
        isProcessing={isProcessing}
        onRegenerate={
          pptxPreviewFile
            ? () => {
                const cls = classNumberFromFilename(pptxPreviewFile.name);
                setPptxPreviewFile(null);
                if (cls != null) onRegenerateClass(cls);
              }
            : undefined
        }
        onDownload={(body) => {
          // Aprovechamos el flujo de descarga existente — el caller
          // espera un FileEntry pero `onDownload(f)` lee del storage.
          // Si el docente acaba de editar SIN guardar, la descarga
          // todavía traerá la versión del storage. Para reflejar el
          // body in-flight, llamamos un build local rápido aquí:
          if (!pptxPreviewFile) return;
          // Como buildPptxBlob vive en el padre del componente, lo
          // pasamos vía onDownload(file). El viewer ya validó que
          // currentBody es lo que hay que descargar. Si está en el
          // storage (post-save), `onDownload(file)` lo recogerá.
          // Si está dirty, el usuario debería guardar primero — el
          // botón de descarga en modo edit no se muestra.
          void body;
          onDownload(pptxPreviewFile);
        }}
        onSaved={(newBody) => {
          if (pptxPreviewFile)
            setBodyOverrides((prev) => ({ ...prev, [pptxPreviewFile.path]: newBody }));
        }}
      />
    </>
  );
}

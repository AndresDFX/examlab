/**
 * Banco de preguntas reutilizables.
 *
 * Cada pregunta vive dentro de un curso y es visible/editable por todos
 * los docentes asignados a ese curso (RLS course_teachers). El docente
 * puede luego importar selecciones al form de examen/taller/proyecto
 * via `QuestionBankImportDialog`.
 *
 * Soporta los 7 tipos: cerrada, cerrada_multi, codigo, codigo_zip,
 * abierta, diagrama, java_gui. Los tipos no aplicables al destino se
 * filtran al importar (codigo_zip solo va a proyectos).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { PageLoader } from "@/components/ui/loaders";
import { PageHeader } from "@/components/ui/page-header";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  SortableHead,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import {
  Library,
  Plus,
  Search,
  Pencil,
  Trash2,
  X as XIcon,
  Save,
  Copy,
  Sparkles,
  Globe,
  CircleDashed,
  BarChart3,
} from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { defaultScenario, parseScenario } from "@/modules/network/scenario";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { toCSV } from "@/shared/lib/csv";
import { usePagination } from "@/hooks/use-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";
import { DataPagination } from "@/components/ui/data-pagination";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { StatCard } from "@/components/ui/stat-card";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { logEvent } from "@/shared/lib/audit";
import { isStaffRole, isAdminLike as isAdminLikeRole } from "@/shared/lib/roles";

export const Route = createFileRoute("/app/teacher/question-bank")({
  component: QuestionBankPage,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type QuestionType =
  | "cerrada"
  | "cerrada_multi"
  | "codigo"
  | "codigo_zip"
  | "abierta"
  | "diagrama"
  | "java_gui"
  | "python_gui"
  | "red_consola"
  | "red_gui";

interface BankRow {
  id: string;
  course_id: string;
  created_by: string | null;
  type: QuestionType;
  content: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
  expected_rubric: string | null;
  language: string | null;
  starter_code: string | null;
  suggested_points: number;
  topic: string | null;
  difficulty: number | null;
  tags: string[];
  shared_org: boolean;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
}

interface Course {
  id: string;
  name: string;
}

// Mapa de tipo → clave i18n. Resolvemos el label vía i18n.t() en cada uso
// (no un Record literal a nivel módulo) para que el cambio de idioma en
// runtime se refleje sin recargar.
const TYPE_LABEL_KEY: Record<QuestionType, string> = {
  cerrada: "questionBank.type.cerrada",
  cerrada_multi: "questionBank.type.cerradaMulti",
  codigo: "questionBank.type.codigo",
  codigo_zip: "questionBank.type.codigoZip",
  abierta: "questionBank.type.abierta",
  diagrama: "questionBank.type.diagrama",
  java_gui: "questionBank.type.javaGui",
  python_gui: "questionBank.type.pythonGui",
  red_consola: "questionBank.type.redConsola",
  red_gui: "questionBank.type.redGui",
};

const typeLabel = (type: QuestionType): string => i18n.t(TYPE_LABEL_KEY[type]);

function QuestionBankPage() {
  const { t } = useTranslation();
  const { user, roles, loading: authLoading } = useAuth();
  const confirm = useConfirm();
  const aiGate = useAiAuthorizationGate();

  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [rows, setRows] = useState<BankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Gate del módulo. Si el admin lo desactivó, mostramos pantalla
  // "deshabilitado" en vez de chocar contra la tabla. También cubre el
  // caso en que la migración 20260518100000_question_bank no se haya
  // aplicado todavía (Lovable Publish pendiente) — al fallar el query
  // mostramos el mismo estado para no quemar al usuario con un toast
  // críptico de schema cache.
  const [moduleAvailable, setModuleAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (db as any)
        .from("app_settings")
        .select("question_bank_enabled")
        .maybeSingle();
      if (cancelled) return;
      setModuleAvailable(data?.question_bank_enabled === false ? false : true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filtros
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterDifficulty, setFilterDifficulty] = useState<string>("all");

  // Dialog estado (crear/editar)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BankRow | null>(null);
  const [draft, setDraft] = useState<Partial<BankRow>>({
    type: "abierta",
    suggested_points: 1,
    tags: [],
  });
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);
  // Escenario JSON para preguntas red_consola del banco (persiste en
  // options.network). Se siembra al abrir el dialog.
  const [netScenarioText, setNetScenarioText] = useState("");
  useEffect(() => {
    if (!dialogOpen) return;
    const net = (draft.options as { network?: unknown } | null)?.network;
    setNetScenarioText(
      net ? JSON.stringify(net, null, 2) : JSON.stringify(defaultScenario(), null, 2),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);
  // Guard "cambios sin guardar" para el dialog crear/editar pregunta.
  // El form ya es UN objeto (`draft`), así que se pasa directo.
  const draftDirty = useDirtyDialog(dialogOpen, draft);

  // Generación con IA (mismo gate que talleres/exámenes/Kahoot).
  const [aiOpen, setAiOpen] = useState(false);
  const [aiType, setAiType] = useState<QuestionType>("cerrada");
  const [aiTopics, setAiTopics] = useState("");
  const [aiCount, setAiCount] = useState(5);
  const [aiLoading, setAiLoading] = useState(false);

  // Admin y SuperAdmin ven TODOS los cursos visibles (la RLS de `courses`
  // ya los acota: Admin a su tenant, SuperAdmin cross-tenant / al tenant del
  // override). El Docente solo los suyos vía course_teachers. Antes esto
  // gateaba solo por Admin → un SuperAdmin PURO (sin rol Admin) caía al
  // branch de course_teachers y veía 0 cursos, dejando el banco inservible
  // pese a estar en su nav.
  const isAdminLike = isAdminLikeRole(roles);

  // Cargar cursos del docente
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      let query;
      if (isAdminLike) {
        query = db
          .from("courses")
          .select("id, name")
          .is("deleted_at", null)
          .order("name");
      } else {
        query = db
          .from("courses")
          .select("id, name, course_teachers!inner(user_id)")
          .eq("course_teachers.user_id", user.id)
          .is("deleted_at", null)
          .order("name");
      }
      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const list = (data ?? []) as Course[];
      setCourses(list);
      if (list.length > 0 && !courseId) {
        setCourseId(list[0].id);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Cargar preguntas del banco para el curso seleccionado
  const load = async () => {
    if (!courseId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("question_bank")
      .select("*")
      .eq("course_id", courseId)
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError(friendlyError(error, t("questionBank.loadError")));
      setLoading(false);
      return;
    }
    setRows((data ?? []) as BankRow[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  // Filtrado client-side
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterType !== "all" && r.type !== filterType) return false;
      if (filterDifficulty !== "all" && String(r.difficulty ?? "") !== filterDifficulty)
        return false;
      if (q) {
        const hay =
          r.content.toLowerCase().includes(q) ||
          (r.topic ?? "").toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q));
        if (!hay) return false;
      }
      return true;
    });
  }, [rows, search, filterType, filterDifficulty]);

  // Quick-stats del banco del curso seleccionado (sobre `rows` completos,
  // no `filtered` → no se mueven al filtrar). Cuatro tiles: total,
  // compartidas con la institución, sin usar y usos totales.
  const bankStats = useMemo(() => {
    let shared = 0,
      unused = 0,
      uses = 0;
    for (const r of rows) {
      if (r.shared_org) shared++;
      const u = r.times_used ?? 0;
      if (u === 0) unused++;
      uses += u;
    }
    return { total: rows.length, shared, unused, uses };
  }, [rows]);

  const sort = useTableSort(filtered, {
    columns: {
      content: (r) => r.content,
      type: (r) => typeLabel(r.type),
      topic: (r) => r.topic,
      difficulty: (r) => r.difficulty,
      suggested_points: (r) => r.suggested_points,
      times_used: (r) => r.times_used,
    },
    defaultSort: { key: "content", dir: "asc" },
    storageKey: "examlab_sort:teacher_question_bank",
  });

  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_question_bank",
    resetKey: `${search}|${filterType}|${filterDifficulty}|${courseId}|${sort.resetKey}`,
  });

  // Multi-selección + bulk delete. Opera sobre `sort.sorted` (todos los
  // items filtrados+ordenados, NO los paginados) para que "seleccionar
  // todos" abarque todas las páginas del filtro activo.
  const sel = useMultiSelect(sort.sorted);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const selectedBankItems = useMemo(
    () =>
      sort.sorted
        .filter((r) => sel.isSelected(r.id))
        .map((r) => ({ id: r.id, label: r.content.slice(0, 80) })),
    [sort.sorted, sel],
  );

  const handleBulkDelete = async (ids: string[]) => {
    const { error } = await db.from("question_bank").delete().in("id", ids);
    if (error) throw new Error(error.message);
    toast.success(
      i18n.t("toast.routes_app_teacher_question_bank.bulkDeleted", {
        defaultValue: "{{count}} pregunta(s) eliminada(s)",
        count: ids.length,
      }),
    );
    void logEvent({
      action: "question_bank.deleted",
      category: "question_bank",
      actorRole: roles[0],
      entityType: "question_bank",
      courseId: courseId || undefined,
      courseName: courses.find((c) => c.id === courseId)?.name,
      metadata: { count: ids.length, ids },
    });
    sel.clear();
    await load();
  };

  // Export del banco filtrado. No soportamos import porque las preguntas
  // (con options JSON, starter_code, expected_rubric) no caben en CSV plano;
  // para añadirlas en bulk usar la pestaña "IA" en exam/workshop/project
  // que genera + guarda en banco.
  const exportBankCsv = (): string => {
    const data = filtered.map((r) => ({
      type: r.type,
      content: r.content.replace(/\r?\n/g, " ").slice(0, 500),
      topic: r.topic ?? "",
      difficulty: r.difficulty ?? "",
      tags: r.tags.join("|"),
      suggested_points: r.suggested_points,
      language: r.language ?? "",
      times_used: r.times_used,
      last_used_at: r.last_used_at ?? "",
    }));
    return toCSV(data);
  };

  const openCreate = () => {
    setEditing(null);
    setDraft({ type: "abierta", suggested_points: 1, tags: [] });
    setTagInput("");
    setDialogOpen(true);
  };

  const openEdit = (r: BankRow) => {
    setEditing(r);
    setDraft({ ...r });
    setTagInput("");
    setDialogOpen(true);
  };

  /** Duplicar: abre el dialog en modo CREAR (editing=null) pre-llenado con
   *  los datos de la pregunta origen. Como una pregunta del banco es
   *  atómica (no tiene sub-partes), la "parametrización de qué copiar" es
   *  el propio formulario: el docente ajusta lo que quiera (enunciado,
   *  opciones, rúbrica, dificultad, tags…) ANTES de guardar la variante.
   *  No se inserta nada hasta que el docente confirma — así no quedan
   *  duplicados idénticos accidentales. */
  const duplicate = (r: BankRow) => {
    setEditing(null);
    setDraft({
      type: r.type,
      content: r.content,
      options: r.options ?? null,
      expected_rubric: r.expected_rubric,
      language: r.language,
      starter_code: r.starter_code,
      suggested_points: r.suggested_points,
      topic: r.topic,
      difficulty: r.difficulty,
      tags: r.tags ? [...r.tags] : [],
      shared_org: r.shared_org,
    });
    setTagInput("");
    setDialogOpen(true);
  };

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    const current = draft.tags ?? [];
    if (current.includes(t)) return;
    setDraft({ ...draft, tags: [...current, t] });
    setTagInput("");
  };

  const removeTag = (t: string) => {
    setDraft({ ...draft, tags: (draft.tags ?? []).filter((x) => x !== t) });
  };

  const save = async () => {
    if (!user || !courseId) return;
    if (!draft.content?.trim()) {
      toast.error(
        i18n.t("toast.routes_app_teacher_question_bank.writeStatement", {
          defaultValue: "Escribe el enunciado",
        }),
      );
      return;
    }
    if (!draft.type) {
      toast.error(
        i18n.t("toast.routes_app_teacher_question_bank.selectType", {
          defaultValue: "Selecciona un tipo",
        }),
      );
      return;
    }
    // red_consola: parsea + valida el escenario JSON antes de guardar.
    let resolvedOptions = draft.options ?? null;
    if (draft.type === "red_consola" || draft.type === "red_gui") {
      let scenarioObj: unknown = null;
      try {
        scenarioObj = JSON.parse(netScenarioText);
      } catch {
        scenarioObj = null;
      }
      const parsed = parseScenario({ network: scenarioObj });
      if (!parsed) {
        toast.error(
          i18n.t("toast.routes_app_teacher_question_bank.invalidNetworkScenario", {
            defaultValue:
              "El escenario de red no es válido. Revisa el JSON: devices, links, targetDeviceId y assertions.",
          }),
        );
        return;
      }
      resolvedOptions = { network: parsed };
    }
    setSaving(true);
    try {
      const payload = {
        course_id: courseId,
        type: draft.type,
        content: draft.content,
        options: resolvedOptions,
        expected_rubric: draft.expected_rubric ?? null,
        language: draft.language ?? null,
        starter_code: draft.starter_code ?? null,
        suggested_points: draft.suggested_points ?? 1,
        topic: draft.topic ?? null,
        difficulty: draft.difficulty ?? null,
        tags: draft.tags ?? [],
        shared_org: draft.shared_org ?? false,
      };
      if (editing) {
        const { error } = await db.from("question_bank").update(payload).eq("id", editing.id);
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_question_bank.questionUpdated", {
            defaultValue: "Pregunta actualizada",
          }),
        );
        void logEvent({
          action: "question_bank.updated",
          category: "question_bank",
          actorRole: roles[0],
          entityType: "question_bank",
          entityId: editing.id,
          entityName: (draft.content ?? "").slice(0, 80),
          courseId,
          courseName: courses.find((c) => c.id === courseId)?.name,
        });
      } else {
        const { data: inserted, error } = await db
          .from("question_bank")
          .insert({ ...payload, created_by: user.id })
          .select("id")
          .single();
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_question_bank.questionAddedToBank", {
            defaultValue: "Pregunta agregada al banco",
          }),
        );
        void logEvent({
          action: "question_bank.created",
          category: "question_bank",
          actorRole: roles[0],
          entityType: "question_bank",
          entityId: inserted?.id,
          entityName: (draft.content ?? "").slice(0, 80),
          courseId,
          courseName: courses.find((c) => c.id === courseId)?.name,
        });
      }
      setDialogOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: BankRow) => {
    const ok = await confirm({
      title: t("questionBank.deleteConfirmTitle"),
      description: t("questionBank.deleteConfirmDescription"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("question_bank").delete().eq("id", r.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_question_bank.questionDeleted", {
        defaultValue: "Pregunta eliminada",
      }),
    );
    void logEvent({
      action: "question_bank.deleted",
      category: "question_bank",
      actorRole: roles[0],
      entityType: "question_bank",
      entityId: r.id,
      entityName: r.content.slice(0, 80),
      courseId: r.course_id,
      courseName: courses.find((c) => c.id === r.course_id)?.name,
    });
    setRows((prev) => prev.filter((x) => x.id !== r.id));
  };

  /** Generar preguntas con IA directamente al banco del curso seleccionado.
   *  Mismo gate (sync / código inmediato / encolar) que talleres/exámenes/
   *  Kahoot. El edge `ai-generate-questions` con targetTable="question_bank"
   *  inserta filas nuevas en question_bank con course_id = curso actual. */
  const generateWithAI = async () => {
    if (!user || !courseId) return;
    if (!aiTopics.trim()) {
      toast.error(
        i18n.t("toast.routes_app_teacher_question_bank.aiNeedTopics", {
          defaultValue: "Escribe los temas para generar",
        }),
      );
      return;
    }
    const count = Math.max(1, Math.min(20, Math.round(aiCount) || 5));
    const decision = await aiGate.ensureAuthorized({ allowQueue: true });
    if (decision === "cancel") return;

    if (decision === "proceed-async") {
      const { error: enqErr } = await db.from("ai_generation_queue").insert([
        {
          kind: "question_bank",
          invoke_target: "ai-generate-questions",
          source_table: "courses",
          source_id: courseId,
          course_id: courseId,
          created_by: user.id,
          body: {
            topics: aiTopics,
            type: aiType,
            count,
            examId: courseId,
            targetTable: "question_bank",
            // El worker invoca el edge con service_role (sin user JWT); el
            // edge usa este created_by como actor para question_bank.created_by.
            created_by: user.id,
          },
        },
      ]);
      if (enqErr) {
        toast.error(friendlyError(enqErr, t("questionBank.aiEnqueueError")));
        return;
      }
      toast.success(
        i18n.t("toast.routes_app_teacher_question_bank.aiQueued", {
          defaultValue: "Generación encolada. Aparecerá en el banco al procesarse.",
        }),
      );
      void logEvent({
        action: "question_bank.created",
        category: "question_bank",
        actorRole: roles[0],
        entityType: "question_bank",
        entityName: aiTopics.slice(0, 80),
        courseId,
        courseName: courses.find((c) => c.id === courseId)?.name,
        metadata: { ai_generated: true, mode: "queued", type: aiType, count },
      });
      setAiOpen(false);
      setAiTopics("");
      return;
    }

    setAiLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: {
          topics: aiTopics,
          type: aiType,
          count,
          examId: courseId,
          targetTable: "question_bank",
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const edgeErr = error ?? (data as any)?.error;
      if (edgeErr) {
        toast.error(friendlyError(edgeErr));
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const n = (data as any)?.inserted?.length ?? 0;
      toast.success(
        i18n.t("toast.routes_app_teacher_question_bank.aiGenerated", {
          defaultValue: "{{n}} pregunta(s) generada(s) y agregada(s) al banco",
          n,
        }),
      );
      void logEvent({
        action: "question_bank.created",
        category: "question_bank",
        actorRole: roles[0],
        entityType: "question_bank",
        entityName: aiTopics.slice(0, 80),
        courseId,
        courseName: courses.find((c) => c.id === courseId)?.name,
        metadata: { ai_generated: true, mode: "sync", type: aiType, count: n },
      });
      setAiOpen(false);
      setAiTopics("");
      await load();
    } finally {
      setAiLoading(false);
    }
  };

  // Esperar a que useAuth termine de hidratar roles. Sin este guard el
  // primer render evalúa `roles=[]` → flash de "Solo docentes y admins"
  // durante ~500ms hasta que el profile carga (bug reportado al entrar
  // al módulo como Admin).
  if (authLoading) return <PageLoader />;
  if (!isStaffRole(roles)) {
    return <p className="text-muted-foreground p-6">{t("questionBank.staffOnly")}</p>;
  }

  if (moduleAvailable === false) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-4 sm:p-8 text-center space-y-2">
            <Library className="h-10 w-10 text-muted-foreground mx-auto" />
            <h2 className="text-base font-semibold">{t("questionBank.disabledTitle")}</h2>
            <p className="text-sm text-muted-foreground">
              {t("questionBank.disabledDescription")}
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={<Library className="h-6 w-6" />}
        title={t("questionBank.pageTitle")}
        subtitle={t("questionBank.pageSubtitle")}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            <ImportExportMenu
              resourceName="banco-preguntas"
              onExport={exportBankCsv}
              disabled={!courseId}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAiOpen(true)}
              disabled={!courseId}
              data-tour-id="bank-ai-generate"
            >
              <Sparkles className="h-4 w-4 mr-1" />
              {t("questionBank.generateWithAi")}
            </Button>
            <Button
              size="sm"
              onClick={openCreate}
              disabled={!courseId}
              data-tour-id="create-question"
            >
              <Plus className="h-4 w-4 mr-1" />
              {t("questionBank.newQuestion")}
            </Button>
          </div>
        }
      />

      {/* Stats 4-card — pulso rápido del banco del curso seleccionado. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={Library}
          label={t("questionBank.statTotal", { defaultValue: "Total de preguntas" })}
          value={bankStats.total}
        />
        <StatCard
          icon={Globe}
          label={t("questionBank.statShared", { defaultValue: "Compartidas con la institución" })}
          value={bankStats.shared}
          tone={bankStats.shared > 0 ? "success" : "default"}
        />
        <StatCard
          icon={CircleDashed}
          label={t("questionBank.statUnused", { defaultValue: "Sin usar" })}
          value={bankStats.unused}
        />
        <StatCard
          icon={BarChart3}
          label={t("questionBank.statUses", { defaultValue: "Usos totales" })}
          value={bankStats.uses}
        />
      </div>

      {/* Filtros */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">{t("questionBank.courseLabel")}</Label>
              <Select value={courseId} onValueChange={setCourseId} disabled={courses.length === 0}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      courses.length === 0
                        ? t("questionBank.noCoursesAssigned")
                        : t("questionBank.selectCoursePlaceholder")
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {courses.length === 0 && (
                // Mensaje accionable cuando el docente no está en
                // course_teachers de ningún curso. Sin esto, el botón
                // "Nueva pregunta" aparece disabled sin contexto y el
                // user no sabe qué hacer. El banco de preguntas vive
                // POR CURSO (RLS lo enforza), así que sin curso no
                // hay forma de crear.
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("questionBank.noCoursesHint")}
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs">{t("questionBank.typeLabel")}</Label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("questionBank.allTypes")}</SelectItem>
                  {(Object.keys(TYPE_LABEL_KEY) as QuestionType[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {typeLabel(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{t("questionBank.difficultyLabel")}</Label>
              <Select value={filterDifficulty} onValueChange={setFilterDifficulty}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t("questionBank.difficultyAll")}</SelectItem>
                  <SelectItem value="1">{t("questionBank.difficulty1")}</SelectItem>
                  <SelectItem value="2">{t("questionBank.difficulty2")}</SelectItem>
                  <SelectItem value="3">{t("questionBank.difficulty3")}</SelectItem>
                  <SelectItem value="4">{t("questionBank.difficulty4")}</SelectItem>
                  <SelectItem value="5">{t("questionBank.difficulty5")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{t("questionBank.searchLabel")}</Label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("questionBank.searchPlaceholder")}
                  className="pl-7"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <MultiSelectToolbar
        count={sel.count}
        onClear={sel.clear}
        onDelete={() => setBulkDeleteOpen(true)}
        entityNameSingular={t("questionBank.bulkEntitySingular", { defaultValue: "pregunta" })}
        entityNamePlural={t("questionBank.bulkEntityPlural", { defaultValue: "preguntas" })}
      />

      {/* Tabla */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="p-4 sm:p-8 text-center text-muted-foreground">
              <Spinner size="md" /> {t("common.loading")}
            </div>
          ) : loadError ? (
            <ErrorState
              message={t("questionBank.loadErrorTitle")}
              hint={loadError}
              onRetry={() => void load()}
            />
          ) : (
            <Table resizable>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <MultiSelectHeaderCheckbox state={sel} />
                  </TableHead>
                  <SortableHead sortKey="content" sort={sort}>
                    {t("questionBank.colQuestion")}
                  </SortableHead>
                  <SortableHead sortKey="type" sort={sort} className="hidden md:table-cell">
                    {t("questionBank.colType")}
                  </SortableHead>
                  <SortableHead sortKey="topic" sort={sort} className="hidden md:table-cell">
                    {t("questionBank.colTopic")}
                  </SortableHead>
                  <TableHead className="hidden lg:table-cell">{t("questionBank.colTags")}</TableHead>
                  <SortableHead
                    sortKey="difficulty"
                    sort={sort}
                    className="hidden sm:table-cell text-center"
                  >
                    {t("questionBank.colDifficulty")}
                  </SortableHead>
                  <SortableHead
                    sortKey="suggested_points"
                    sort={sort}
                    className="hidden sm:table-cell text-center"
                  >
                    {t("questionBank.colPoints")}
                  </SortableHead>
                  <SortableHead
                    sortKey="times_used"
                    sort={sort}
                    className="hidden lg:table-cell text-center"
                  >
                    {t("questionBank.colUses")}
                  </SortableHead>
                  <TableHead className="text-right">{t("questionBank.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableEmpty
                    colSpan={9}
                    text={
                      !courseId
                        ? t("questionBank.emptyNoCourseText")
                        : t("questionBank.emptyNoQuestionsText")
                    }
                    hint={
                      !courseId
                        ? t("questionBank.emptyNoCourseHint")
                        : rows.length === 0
                          ? t("questionBank.emptyNoQuestionsHint")
                          : t("questionBank.emptyNoMatchHint")
                    }
                    action={
                      courseId && rows.length === 0 ? (
                        <Button size="sm" onClick={openCreate}>
                          <Plus className="h-4 w-4 mr-1" />
                          {t("questionBank.createFirst")}
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  pagination.paginatedItems.map((r) => (
                    <TableRow
                      key={r.id}
                      data-state={sel.isSelected(r.id) ? "selected" : undefined}
                    >
                      <TableCell className="w-10">
                        <MultiSelectCheckbox id={r.id} state={sel} />
                      </TableCell>
                      <TableCell className="max-w-md">
                        <div className="line-clamp-2 text-sm">{r.content}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge variant="secondary" className="text-[10px] whitespace-nowrap">
                            {typeLabel(r.type)}
                          </Badge>
                          {r.shared_org && (
                            <Badge
                              variant="outline"
                              className="text-[10px] whitespace-nowrap gap-0.5 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                            >
                              <Globe className="h-2.5 w-2.5" />
                              {t("questionBank.sharedBadge")}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {r.topic || "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {r.tags.slice(0, 3).map((t) => (
                            <Badge key={t} variant="outline" className="text-[10px]">
                              {t}
                            </Badge>
                          ))}
                          {r.tags.length > 3 && (
                            <Badge variant="outline" className="text-[10px]">
                              +{r.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center text-xs tabular-nums">
                        {r.difficulty ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center text-xs tabular-nums">
                        {r.suggested_points}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-center text-xs tabular-nums">
                        {r.times_used}
                      </TableCell>
                      <TableCell className="text-right">
                        <RowActionsMenu
                          actions={[
                            { label: t("common.edit"), icon: Pencil, onClick: () => openEdit(r) },
                            { label: t("common.duplicate"), icon: Copy, onClick: () => duplicate(r) },
                            {
                              label: t("common.delete"),
                              icon: Trash2,
                              tone: "destructive",
                              separatorBefore: true,
                              onClick: () => void remove(r),
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
          <DataPagination state={pagination} entityNamePlural={t("questionBank.entityNamePlural")} />
        </CardContent>
      </Card>

      {/* Dialog crear/editar */}
      <Dialog open={dialogOpen} onOpenChange={draftDirty.guardOpenChange(setDialogOpen)}>
        <DialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] overflow-y-auto"
          data-tour-id="dialog-question"
        >
          <DialogHeader>
            <DialogTitle>
              {editing
                ? t("questionBank.dialogEditTitle")
                : t("questionBank.dialogCreateTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("questionBank.dialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div data-tour-id="question-field-type">
                <Label required>{t("questionBank.typeLabel")}</Label>
                <Select
                  value={draft.type ?? "abierta"}
                  onValueChange={(v) => setDraft({ ...draft, type: v as QuestionType })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TYPE_LABEL_KEY) as QuestionType[]).map((k) => (
                      <SelectItem key={k} value={k}>
                        {typeLabel(k)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("questionBank.suggestedPointsLabel")}</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  value={draft.suggested_points ?? 1}
                  onChange={(e) =>
                    setDraft({ ...draft, suggested_points: Number(e.target.value) || 1 })
                  }
                />
              </div>
            </div>

            <div data-tour-id="question-field-content">
              <Label required>{t("questionBank.statementLabel")}</Label>
              <Textarea
                value={draft.content ?? ""}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                rows={4}
                placeholder={t("questionBank.statementPlaceholder")}
              />
            </div>

            {(draft.type === "red_consola" || draft.type === "red_gui") && (
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5">
                  {t("questionBank.networkScenarioLabel", { defaultValue: "Escenario de red (JSON)" })}
                  <HelpHint>
                    {t("questionBank.networkScenarioHint", {
                      defaultValue:
                        "Topología (devices/links), targetDeviceId (dispositivo que configura el alumno) y assertions (rúbrica auto-calificada). El alumno resuelve en una consola tipo IOS.",
                    })}
                  </HelpHint>
                </Label>
                <Textarea
                  value={netScenarioText}
                  onChange={(e) => setNetScenarioText(e.target.value)}
                  rows={12}
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setNetScenarioText(JSON.stringify(defaultScenario(), null, 2))}
                >
                  {t("questionBank.networkResetTemplate", { defaultValue: "Restablecer plantilla" })}
                </Button>
              </div>
            )}
            {draft.type !== "cerrada" &&
              draft.type !== "cerrada_multi" &&
              draft.type !== "red_consola" &&
              draft.type !== "red_gui" && (
              <div data-tour-id="question-field-rubric">
                <Label>
                  {t("questionBank.expectedRubricLabel")}{" "}
                  <HelpHint>{t("help.rubricHelpCriteria")}</HelpHint>
                </Label>
                <Textarea
                  value={draft.expected_rubric ?? ""}
                  onChange={(e) => setDraft({ ...draft, expected_rubric: e.target.value })}
                  rows={2}
                />
              </div>
            )}

            {(draft.type === "codigo" ||
              draft.type === "java_gui" ||
              draft.type === "python_gui") && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>{t("questionBank.languageLabel")}</Label>
                  <Select
                    value={draft.language ?? "java"}
                    onValueChange={(v) => setDraft({ ...draft, language: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="java">Java</SelectItem>
                      <SelectItem value="python">Python</SelectItem>
                      <SelectItem value="javascript">JavaScript</SelectItem>
                      <SelectItem value="typescript">TypeScript</SelectItem>
                      <SelectItem value="c">C</SelectItem>
                      <SelectItem value="cpp">C++</SelectItem>
                      <SelectItem value="csharp">C#</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>{t("questionBank.topicLabel")}</Label>
                <Input
                  value={draft.topic ?? ""}
                  onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
                  placeholder={t("questionBank.topicPlaceholder")}
                />
              </div>
              <div>
                <Label>{t("questionBank.difficultyRangeLabel")}</Label>
                <Select
                  value={String(draft.difficulty ?? "")}
                  onValueChange={(v) =>
                    setDraft({ ...draft, difficulty: v === "" ? null : Number(v) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("questionBank.difficultyUndefined")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">{t("questionBank.difficulty1")}</SelectItem>
                    <SelectItem value="2">{t("questionBank.difficulty2")}</SelectItem>
                    <SelectItem value="3">{t("questionBank.difficulty3")}</SelectItem>
                    <SelectItem value="4">{t("questionBank.difficulty4")}</SelectItem>
                    <SelectItem value="5">{t("questionBank.difficulty5")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>{t("questionBank.tagsLabel")}</Label>
              <div className="flex flex-wrap gap-1 mb-2">
                {(draft.tags ?? []).map((t) => (
                  <Badge key={t} variant="secondary" className="text-[11px] gap-1">
                    {t}
                    <button
                      type="button"
                      onClick={() => removeTag(t)}
                      className="hover:text-destructive"
                      aria-label={i18n.t("questionBank.removeTag", {
                        label: t,
                        defaultValue: "Quitar etiqueta {{label}}",
                      })}
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder={t("questionBank.newTagPlaceholder")}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addTag}>
                  {t("questionBank.addTag")}
                </Button>
              </div>
            </div>

            {/* Compartir con la organización: cualquier docente del tenant podrá
                VER e IMPORTAR esta pregunta (a sus exámenes/talleres/proyectos/
                Kahoot). La edición/borrado sigue siendo solo tuya o del Admin. */}
            <div className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label className="flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                  {t("questionBank.shareOrgLabel")}
                  <HelpHint>{t("questionBank.shareOrgHelp")}</HelpHint>
                </Label>
                <p className="text-[11px] text-muted-foreground">
                  {t("questionBank.shareOrgHint")}
                </p>
              </div>
              <Switch
                checked={draft.shared_org ?? false}
                onCheckedChange={(v) => setDraft({ ...draft, shared_org: v })}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              {editing ? t("questionBank.saveChanges") : t("questionBank.addToBank")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: generar preguntas con IA al banco */}
      <Dialog open={aiOpen} onOpenChange={setAiOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-violet-500" />
              {t("questionBank.aiDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("questionBank.aiDialogDescription")}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label required>{t("questionBank.aiTypeLabel")}</Label>
                <Select
                  value={aiType}
                  onValueChange={(v) => setAiType(v as QuestionType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(TYPE_LABEL_KEY) as QuestionType[])
                      // codigo_zip es exclusivo de proyectos; red_consola usa
                      // escenario estructurado (no lo genera el modelo). Ambos
                      // se crean manualmente, no por IA en el banco.
                      .filter((k) => k !== "codigo_zip" && k !== "red_consola" && k !== "red_gui")
                      .map((k) => (
                        <SelectItem key={k} value={k}>
                          {typeLabel(k)}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("questionBank.aiCountLabel")}</Label>
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={aiCount}
                  onChange={(e) =>
                    setAiCount(Math.max(1, Math.min(20, Number(e.target.value) || 5)))
                  }
                />
              </div>
            </div>
            <div>
              <Label required>{t("questionBank.aiTopicsLabel")}</Label>
              <Textarea
                value={aiTopics}
                onChange={(e) => setAiTopics(e.target.value)}
                rows={3}
                placeholder={t("questionBank.aiTopicsPlaceholder")}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setAiOpen(false)} disabled={aiLoading}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void generateWithAI()} disabled={aiLoading || !aiTopics.trim()}>
              {aiLoading ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Sparkles className="h-4 w-4 mr-1" />
              )}
              {t("questionBank.aiGenerateButton")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={selectedBankItems}
        entityNameSingular={t("questionBank.bulkEntitySingular", { defaultValue: "pregunta" })}
        entityNamePlural={t("questionBank.bulkEntityPlural", { defaultValue: "preguntas" })}
        onConfirm={handleBulkDelete}
      />

      <aiGate.GateDialog />
    </div>
  );
}

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { RotateCcw, Save, Sparkles } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { useTranslation } from "react-i18next";
import { friendlyError } from "@/shared/lib/db-errors";

export const Route = createFileRoute("/app/teacher/ai-prompts")({
  component: TeacherAIPrompts,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type UseCase =
  | "workshop_full"
  | "workshop_question"
  | "project_file"
  | "project_full"
  | "exam_question"
  | "exam_time_evaluation"
  | "plagiarism_detection"
  | "ai_content_detection"
  | "project_description"
  | "project_questions";

/** Categorización por módulo (idéntica a AdminPromptsPanel). Solo
 * agrupa visualmente los use_cases en el Select de filtro. */
type PromptModule = "exams" | "workshops" | "projects" | "fraud";

const MODULE_LABELS: Record<PromptModule, string> = {
  exams: "Exámenes",
  workshops: "Talleres",
  projects: "Proyectos",
  fraud: "Detección de fraude",
};

type UseCaseDef = {
  key: UseCase;
  module: PromptModule;
  label: string;
  description: string;
};

const USE_CASES: UseCaseDef[] = [
  {
    key: "workshop_full",
    module: "workshops",
    label: "Taller completo",
    description: "Calificación de un taller entero (todas las respuestas en bloque).",
  },
  {
    key: "workshop_question",
    module: "workshops",
    label: "Pregunta de taller",
    description: "Calificación pregunta por pregunta dentro de un taller.",
  },
  {
    key: "project_file",
    module: "projects",
    label: "Archivo de proyecto",
    description: "Calificación de un archivo individual del proyecto.",
  },
  {
    key: "project_full",
    module: "projects",
    label: "Proyecto completo",
    description: "Calificación holística del proyecto completo.",
  },
  {
    key: "exam_question",
    module: "exams",
    label: "Pregunta de examen",
    description: "Calificación de una pregunta abierta de examen.",
  },
  {
    key: "exam_time_evaluation",
    module: "exams",
    label: "Evaluación de duración de examen",
    description: "Sugerencia de IA sobre cuántos minutos debería durar el examen.",
  },
  {
    key: "plagiarism_detection",
    module: "fraud",
    label: "Detección de copia entre estudiantes",
    description:
      "Prompt que usa el botón 'Detectar copias' para comparar respuestas a la misma pregunta y reportar pares sospechosos.",
  },
  {
    key: "ai_content_detection",
    module: "fraud",
    label: "Detección de respuestas generadas por IA",
    description:
      "Reglas que se anexan al prompt de calificación cuando el modelo debe estimar la probabilidad de que la respuesta haya sido generada por IA.",
  },
  {
    key: "project_description",
    module: "projects",
    label: "Descripción de proyecto (contexto global)",
    description:
      "Genera la descripción del proyecto a partir de un tema. La descripción se usa como contexto global para que cada pregunta del proyecto se califique con el alcance/propósito en mente.",
  },
  {
    key: "project_questions",
    module: "projects",
    label: "Preguntas del proyecto (auto-generadas desde la descripción)",
    description:
      "A partir de la descripción del proyecto, genera el set de preguntas/entregables. Restricción dura: SIEMPRE 1 pregunta tipo 'codigo_zip' + entre 2 y 5 preguntas adicionales (abierta/diagrama/cerrada) para evaluar análisis y diseño por separado.",
  },
];

type PromptRow = {
  id: string;
  use_case: UseCase;
  course_id: string | null;
  system_prompt: string;
};

type CourseLite = { id: string; name: string; period: string | null };

function TeacherAIPrompts() {
  const { user, roles, loading: authLoading } = useAuth();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [loadingCourses, setLoadingCourses] = useState(true);
  const [coursesError, setCoursesError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const [globals, setGlobals] = useState<Record<UseCase, string>>(
    Object.fromEntries(USE_CASES.map((u) => [u.key, ""])) as Record<UseCase, string>,
  );
  const [overrides, setOverrides] = useState<Record<UseCase, PromptRow | null>>(
    Object.fromEntries(USE_CASES.map((u) => [u.key, null])) as Record<UseCase, PromptRow | null>,
  );
  const [drafts, setDrafts] = useState<Record<UseCase, string>>(
    Object.fromEntries(USE_CASES.map((u) => [u.key, ""])) as Record<UseCase, string>,
  );
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [savingKey, setSavingKey] = useState<UseCase | null>(null);
  // Filtro por módulo (Exámenes / Talleres / Proyectos / Detección).
  // Solo afecta el render — la query de prompts es la misma.
  const [moduleFilter, setModuleFilter] = useState<PromptModule | "all">("all");
  const filteredUseCases = USE_CASES.filter(
    (uc) => moduleFilter === "all" || uc.module === moduleFilter,
  );

  // Cursos donde el docente está asignado. Para Admin, RLS retorna todos.
  // Para Docente, courses solo retorna donde está en course_teachers.
  useEffect(() => {
    if (!isTeacher) return;
    let cancelled = false;
    (async () => {
      setLoadingCourses(true);
      setCoursesError(null);
      // Para Docente solo ver cursos donde es teacher.
      // Hacemos un join via course_teachers para limitar (Admin verá todos
      // por RLS si así se desea, pero en esta vista filtramos a "mis cursos").
      let q = db
        .from("courses")
        .select("id, name, period")
        .order("period", { ascending: false, nullsFirst: false })
        .order("name");
      if (roles.includes("Docente") && !roles.includes("Admin") && user) {
        // Con RLS, el docente solo ve sus cursos; igual añadimos filtro
        // explícito para Admin actuando como Docente.
        const { data: ct } = await db
          .from("course_teachers")
          .select("course_id")
          .eq("user_id", user.id);
        const ids = (ct ?? []).map((r: { course_id: string }) => r.course_id);
        if (ids.length === 0) {
          if (!cancelled) {
            setCourses([]);
            setLoadingCourses(false);
          }
          return;
        }
        q = q.in("id", ids);
      }
      const { data, error } = await q;
      if (cancelled) return;
      if (error) {
        setCoursesError(friendlyError(error, "No pudimos cargar tus cursos."));
        setLoadingCourses(false);
        return;
      }
      const list = (data ?? []) as CourseLite[];
      setCourses(list);
      if (list.length > 0 && !courseId) setCourseId(list[0].id);
      setLoadingCourses(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isTeacher, user?.id, retryNonce]);

  // Carga prompts globales + overrides del curso seleccionado.
  const loadPrompts = async (cid: string) => {
    setLoadingPrompts(true);
    // Guard: PostgREST .or() interpola `cid` en el filtro string.
    // Si por alguna razón el state contiene algo distinto a un UUID,
    // un valor con coma podría inyectar condiciones extra. Validamos.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cid)) {
      setLoadingPrompts(false);
      return;
    }
    const { data, error } = await db
      .from("ai_prompts")
      .select("id, use_case, course_id, system_prompt")
      .or(`course_id.eq.${cid},course_id.is.null`);
    if (error) {
      toast.error(friendlyError(error));
      setLoadingPrompts(false);
      return;
    }
    const rows = (data ?? []) as PromptRow[];
    const nextGlobals = { ...globals };
    const nextOverrides = { ...overrides };
    const nextDrafts = { ...drafts };
    for (const uc of USE_CASES) {
      const global = rows.find((r) => r.use_case === uc.key && r.course_id === null);
      const override = rows.find((r) => r.use_case === uc.key && r.course_id === cid) ?? null;
      nextGlobals[uc.key] = global?.system_prompt ?? "";
      nextOverrides[uc.key] = override;
      nextDrafts[uc.key] = override?.system_prompt ?? global?.system_prompt ?? "";
    }
    setGlobals(nextGlobals);
    setOverrides(nextOverrides);
    setDrafts(nextDrafts);
    setLoadingPrompts(false);
  };

  useEffect(() => {
    if (courseId) loadPrompts(courseId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  const handleSaveOverride = async (uc: UseCaseDef) => {
    if (!user || !courseId) return;
    const text = drafts[uc.key].trim();
    if (!text) {
      toast.error("El prompt no puede estar vacío");
      return;
    }
    setSavingKey(uc.key);
    try {
      const existing = overrides[uc.key];
      if (existing) {
        const { error } = await db
          .from("ai_prompts")
          .update({ system_prompt: text, updated_by: user.id })
          .eq("id", existing.id);
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
      } else {
        const { error } = await db.from("ai_prompts").insert({
          use_case: uc.key,
          course_id: courseId,
          system_prompt: text,
          updated_by: user.id,
        });
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
      }
      void logEvent({
        action: "ai_prompt.course_override_saved",
        category: "system",
        severity: "info",
        entityType: "ai_prompt",
        entityId: existing?.id ?? undefined,
        entityName: uc.label,
        courseId,
        metadata: { use_case: uc.key, scope: "course", length: text.length },
      });
      toast.success(`Override de "${uc.label}" guardado para este curso`);
      await loadPrompts(courseId);
    } finally {
      setSavingKey(null);
    }
  };

  const handleRestoreGlobal = async (uc: UseCaseDef) => {
    if (!courseId) return;
    const existing = overrides[uc.key];
    if (!existing) return;
    const ok = await confirm({
      title: t("prompts.removeOverrideTitle", { label: uc.label }),
      description: t("prompts.removeOverrideBody"),
      confirmLabel: t("prompts.removeOverrideConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    setSavingKey(uc.key);
    try {
      const { error } = await db.from("ai_prompts").delete().eq("id", existing.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "ai_prompt.course_override_removed",
        category: "system",
        severity: "info",
        entityType: "ai_prompt",
        entityId: existing.id,
        entityName: uc.label,
        courseId,
        metadata: { use_case: uc.key, scope: "course" },
      });
      toast.success(`"${uc.label}" volvió al prompt global`);
      await loadPrompts(courseId);
    } finally {
      setSavingKey(null);
    }
  };

  if (authLoading) return null;
  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  const selectedCourse = courses.find((c) => c.id === courseId);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Sparkles className="h-6 w-6 text-amber-500" />}
        title={
          <span className="inline-flex items-center gap-2">
            Prompts de IA por curso
            <HelpHint side="bottom" align="start"><span dangerouslySetInnerHTML={{ __html: t("help.editRoleOnly") }} /></HelpHint>
          </span>
        }
        subtitle="Personaliza el rol y criterios del modelo para cada caso de uso dentro de un curso específico. Si no hay override, se usa el prompt global del sistema."
      />

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div>
            <Label>Curso</Label>
            {loadingCourses ? (
              <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
                <Spinner size="md" /> Cargando cursos…
              </div>
            ) : coursesError ? (
              <ErrorState
                message="No pudimos cargar los cursos"
                hint={coursesError}
                onRetry={() => setRetryNonce((n) => n + 1)}
                className="py-4"
              />
            ) : courses.length === 0 ? (
              <p className="text-sm text-muted-foreground mt-1">No tienes cursos asignados.</p>
            ) : (
              <Select value={courseId ?? undefined} onValueChange={(v) => setCourseId(v)}>
                <SelectTrigger className="w-full sm:w-[400px] mt-1">
                  <SelectValue placeholder="Selecciona un curso" />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.period ? (
                        <span className="text-muted-foreground"> · {c.period}</span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Filtro por módulo: Exámenes / Talleres / Proyectos / Detección
          de fraude. Solo afecta el render — comparte el mismo state de
          drafts/overrides que el panel completo. */}
      {courseId && (
        <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-3">
          <div className="flex-1 min-w-[160px] sm:min-w-48">
            <Label className="text-xs">Módulo</Label>
            <Select
              value={moduleFilter}
              onValueChange={(v) => setModuleFilter(v as PromptModule | "all")}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los módulos</SelectItem>
                {(["exams", "workshops", "projects", "fraud"] as const).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODULE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Badge variant="outline" className="text-[11px] tabular-nums h-6">
            {filteredUseCases.length} de {USE_CASES.length} prompt(s)
          </Badge>
        </div>
      )}

      {courseId && loadingPrompts ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="md" /> Cargando prompts…
          </CardContent>
        </Card>
      ) : courseId && selectedCourse ? (
        <div className="grid gap-4">
          {filteredUseCases.length === 0 && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground text-center">
                No hay prompts en este módulo.
              </CardContent>
            </Card>
          )}
          {filteredUseCases.map((uc) => {
            const override = overrides[uc.key];
            const draft = drafts[uc.key];
            const dirty = override ? draft !== override.system_prompt : draft !== globals[uc.key];
            const hasOverride = !!override;
            return (
              <Card key={uc.key}>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                    {uc.label}
                    {hasOverride ? (
                      <Badge className="text-[10px] bg-amber-500/15 text-amber-700 border-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300 dark:border-amber-400/25">
                        Override del curso
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        Usando global
                      </Badge>
                    )}
                  </CardTitle>
                  <p className="text-xs text-muted-foreground mt-1">{uc.description}</p>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Prompt global de referencia */}
                  <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                        Prompt global (referencia)
                      </span>
                    </div>
                    <p className="text-xs whitespace-pre-wrap leading-relaxed text-muted-foreground">
                      {globals[uc.key] || "(sin prompt global definido)"}
                    </p>
                  </div>

                  {/* Editor del override */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {hasOverride ? "Override de este curso" : "Crear override para este curso"}
                    </Label>
                    <Textarea
                      rows={6}
                      value={drafts[uc.key]}
                      onChange={(e) => setDrafts((d) => ({ ...d, [uc.key]: e.target.value }))}
                      placeholder={globals[uc.key] || "Escribe el prompt para este curso…"}
                      className="font-mono text-xs leading-relaxed"
                    />
                  </div>

                  <div className="flex flex-wrap gap-2 justify-end">
                    {dirty && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDrafts((d) => ({
                            ...d,
                            [uc.key]: override?.system_prompt ?? globals[uc.key],
                          }))
                        }
                        disabled={savingKey === uc.key}
                      >
                        Cancelar
                      </Button>
                    )}
                    {hasOverride && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRestoreGlobal(uc)}
                        disabled={savingKey === uc.key}
                      >
                        <RotateCcw className="h-4 w-4 mr-1" />
                        Volver al global
                      </Button>
                    )}
                    <Button
                      size="sm"
                      onClick={() => handleSaveOverride(uc)}
                      disabled={savingKey === uc.key || !dirty}
                    >
                      {savingKey === uc.key ? (
                        <Spinner size="md" className="mr-1" />
                      ) : (
                        <Save className="h-4 w-4 mr-1" />
                      )}
                      {hasOverride ? "Guardar override" : "Crear override"}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

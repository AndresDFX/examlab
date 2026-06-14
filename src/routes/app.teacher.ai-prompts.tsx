import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { isStaffRole } from "@/shared/lib/roles";
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
import i18n from "@/i18n";

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
  | "project_questions"
  | "tutor_chat";

/** Categorización por módulo (idéntica a AdminPromptsPanel). Solo
 * agrupa visualmente los use_cases en el Select de filtro. */
type PromptModule = "exams" | "workshops" | "projects" | "fraud" | "tutor";

const MODULE_LABELS: Record<PromptModule, string> = {
  exams: i18n.t("hc_routesAppTeacherAiPrompts.moduleExams"),
  workshops: i18n.t("hc_routesAppTeacherAiPrompts.moduleWorkshops"),
  projects: i18n.t("hc_routesAppTeacherAiPrompts.moduleProjects"),
  fraud: i18n.t("hc_routesAppTeacherAiPrompts.moduleFraud"),
  tutor: i18n.t("hc_routesAppTeacherAiPrompts.moduleTutor"),
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
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucWorkshopFullLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucWorkshopFullDesc"),
  },
  {
    key: "workshop_question",
    module: "workshops",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucWorkshopQuestionLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucWorkshopQuestionDesc"),
  },
  {
    key: "project_file",
    module: "projects",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectFileLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectFileDesc"),
  },
  {
    key: "project_full",
    module: "projects",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectFullLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectFullDesc"),
  },
  {
    key: "exam_question",
    module: "exams",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucExamQuestionLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucExamQuestionDesc"),
  },
  {
    key: "exam_time_evaluation",
    module: "exams",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucExamTimeEvalLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucExamTimeEvalDesc"),
  },
  {
    key: "plagiarism_detection",
    module: "fraud",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucPlagiarismLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucPlagiarismDesc"),
  },
  {
    key: "ai_content_detection",
    module: "fraud",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucAiContentLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucAiContentDesc"),
  },
  {
    key: "project_description",
    module: "projects",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectDescriptionLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectDescriptionDesc"),
  },
  {
    key: "project_questions",
    module: "projects",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectQuestionsLabel"),
    description: i18n.t("hc_routesAppTeacherAiPrompts.ucProjectQuestionsDesc"),
  },
  {
    key: "tutor_chat",
    module: "tutor",
    label: i18n.t("hc_routesAppTeacherAiPrompts.ucTutorChatLabel"),
    description:
      "System prompt del Tutor IA. Soporta {{course_name}}, {{course_description}}, {{course_content_topics}}, {{course_content_material}} y {{current_datetime}} (fecha/hora actual) para responder anclado al contenido y a las fechas del curso. El override de este curso pisa al global del tenant.",
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
  // SA accede a pantallas Docente para soporte / diagnóstico — sin SA
  // en el set, recibía "Necesitas rol Docente" silencioso al entrar.
  const isTeacher = isStaffRole(roles);

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
        .is("deleted_at", null)
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
        setCoursesError(friendlyError(error, t("hc_routesAppTeacherAiPrompts.coursesLoadError")));
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
      toast.error(
        i18n.t("toast.routes_app_teacher_ai_prompts.promptEmpty", {
          defaultValue: "El prompt no puede estar vacío",
        }),
      );
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
      toast.success(
        i18n.t("toast.routes_app_teacher_ai_prompts.overrideSaved", {
          defaultValue: 'Override de "{{label}}" guardado para este curso',
          label: uc.label,
        }),
      );
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
      toast.success(
        i18n.t("toast.routes_app_teacher_ai_prompts.revertedToGlobal", {
          defaultValue: '"{{label}}" volvió al prompt global',
          label: uc.label,
        }),
      );
      await loadPrompts(courseId);
    } finally {
      setSavingKey(null);
    }
  };

  if (authLoading) return null;
  if (!isTeacher) return <p className="text-muted-foreground">{t("hc_routesAppTeacherAiPrompts.needTeacherRole")}</p>;

  const selectedCourse = courses.find((c) => c.id === courseId);

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Sparkles className="h-6 w-6 text-amber-500" />}
        title={
          <span className="inline-flex items-center gap-2">
            {t("hc_routesAppTeacherAiPrompts.pageTitle")}
            <HelpHint side="bottom" align="start"><span dangerouslySetInnerHTML={{ __html: t("help.editRoleOnly") }} /></HelpHint>
          </span>
        }
        subtitle={t("hc_routesAppTeacherAiPrompts.pageSubtitle")}
      />

      <Card>
        <CardContent className="p-4 sm:p-5 space-y-3">
          <div>
            <Label>{t("hc_routesAppTeacherAiPrompts.courseLabel")}</Label>
            {loadingCourses ? (
              <div className="text-sm text-muted-foreground flex items-center gap-2 mt-1">
                <Spinner size="md" /> {t("hc_routesAppTeacherAiPrompts.loadingCourses")}
              </div>
            ) : coursesError ? (
              <ErrorState
                message={t("hc_routesAppTeacherAiPrompts.coursesLoadErrorTitle")}
                hint={coursesError}
                onRetry={() => setRetryNonce((n) => n + 1)}
                className="py-4"
              />
            ) : courses.length === 0 ? (
              <p className="text-sm text-muted-foreground mt-1">{t("hc_routesAppTeacherAiPrompts.noCoursesAssigned")}</p>
            ) : (
              <Select value={courseId ?? undefined} onValueChange={(v) => setCourseId(v)}>
                <SelectTrigger className="w-full sm:w-[400px] mt-1">
                  <SelectValue placeholder={t("hc_routesAppTeacherAiPrompts.selectCoursePlaceholder")} />
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
            <Label className="text-xs">{t("hc_routesAppTeacherAiPrompts.moduleLabel")}</Label>
            <Select
              value={moduleFilter}
              onValueChange={(v) => setModuleFilter(v as PromptModule | "all")}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("hc_routesAppTeacherAiPrompts.allModules")}</SelectItem>
                {(["exams", "workshops", "projects", "fraud", "tutor"] as const).map((m) => (
                  <SelectItem key={m} value={m}>
                    {MODULE_LABELS[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Badge variant="outline" className="text-[11px] tabular-nums h-6">
            {t("hc_routesAppTeacherAiPrompts.promptCount", {
              count: filteredUseCases.length,
              total: USE_CASES.length,
            })}
          </Badge>
        </div>
      )}

      {courseId && loadingPrompts ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="md" /> {t("hc_routesAppTeacherAiPrompts.loadingPrompts")}
          </CardContent>
        </Card>
      ) : courseId && selectedCourse ? (
        <div className="grid gap-4">
          {filteredUseCases.length === 0 && (
            <Card>
              <CardContent className="p-6 text-sm text-muted-foreground text-center">
                {t("hc_routesAppTeacherAiPrompts.noPromptsInModule")}
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
                        {t("hc_routesAppTeacherAiPrompts.badgeCourseOverride")}
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("hc_routesAppTeacherAiPrompts.badgeUsingGlobal")}
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
                        {t("hc_routesAppTeacherAiPrompts.globalPromptReference")}
                      </span>
                    </div>
                    <p className="text-xs whitespace-pre-wrap leading-relaxed text-muted-foreground">
                      {globals[uc.key] || t("hc_routesAppTeacherAiPrompts.noGlobalPromptDefined")}
                    </p>
                  </div>

                  {/* Editor del override */}
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      {hasOverride
                        ? t("hc_routesAppTeacherAiPrompts.editorLabelOverride")
                        : t("hc_routesAppTeacherAiPrompts.editorLabelCreate")}
                    </Label>
                    <Textarea
                      rows={6}
                      value={drafts[uc.key]}
                      onChange={(e) => setDrafts((d) => ({ ...d, [uc.key]: e.target.value }))}
                      placeholder={globals[uc.key] || t("hc_routesAppTeacherAiPrompts.editorPlaceholder")}
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
                        {t("hc_routesAppTeacherAiPrompts.cancel")}
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
                        {t("hc_routesAppTeacherAiPrompts.backToGlobal")}
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
                      {hasOverride
                        ? t("hc_routesAppTeacherAiPrompts.saveOverride")
                        : t("hc_routesAppTeacherAiPrompts.createOverride")}
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

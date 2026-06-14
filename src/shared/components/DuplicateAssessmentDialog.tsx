/**
 * Dialog reutilizable para "Duplicar examen/taller/proyecto".
 * Pide curso destino + nuevo título opcional, llama la RPC clone_*,
 * y permite al docente navegar al nuevo item (status='draft' siempre).
 *
 * Uso:
 *   <DuplicateAssessmentDialog
 *     open={...}
 *     onOpenChange={...}
 *     source={{ id: "...", title: "Examen 1", courseId: "..." }}
 *     target="exam" | "workshop" | "project"
 *     onDuplicated={(newId) => navigate(...)}
 *   />
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Course {
  id: string;
  name: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: { id: string; title: string; courseId: string };
  target: "exam" | "workshop" | "project";
  onDuplicated?: (newId: string) => void;
}

const RPC_BY_TARGET: Record<Props["target"], string> = {
  exam: "clone_exam",
  workshop: "clone_workshop",
  project: "clone_project",
};

const LABEL_KEY_BY_TARGET: Record<Props["target"], string> = {
  exam: "hc_sharedComponentsDuplicateAssessmentDialog.targetExam",
  workshop: "hc_sharedComponentsDuplicateAssessmentDialog.targetWorkshop",
  project: "hc_sharedComponentsDuplicateAssessmentDialog.targetProject",
};

/**
 * Opciones parametrizables por tipo: qué información INTERNA copiar. Cada
 * `param` es el nombre del argumento booleano del RPC clone_* (mig
 * 20260918000000). `default: true` preserva el comportamiento histórico
 * (copiaba todo) cuando el docente no toca nada.
 */
const COPY_OPTIONS_BY_TARGET: Record<
  Props["target"],
  Array<{ param: string; labelKey: string; hintKey: string }>
> = {
  exam: [
    {
      param: "_copy_questions",
      labelKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyQuestionsLabel",
      hintKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyQuestionsExamHint",
    },
    {
      param: "_copy_proctoring",
      labelKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyProctoringLabel",
      hintKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyProctoringHint",
    },
  ],
  workshop: [
    {
      param: "_copy_questions",
      labelKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyQuestionsLabel",
      hintKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyQuestionsWorkshopHint",
    },
    {
      param: "_copy_groups",
      labelKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyGroupsLabel",
      hintKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyGroupsHint",
    },
  ],
  project: [
    {
      param: "_copy_files",
      labelKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyFilesLabel",
      hintKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyFilesHint",
    },
    {
      param: "_copy_groups",
      labelKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyGroupsLabel",
      hintKey: "hc_sharedComponentsDuplicateAssessmentDialog.copyGroupsHint",
    },
  ],
};

export function DuplicateAssessmentDialog({
  open,
  onOpenChange,
  source,
  target,
  onDuplicated,
}: Props) {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const isAdmin = roles.includes("Admin");

  const copyOptions = COPY_OPTIONS_BY_TARGET[target];

  const [courses, setCourses] = useState<Course[]>([]);
  const [targetCourseId, setTargetCourseId] = useState<string>(source.courseId);
  const [newTitle, setNewTitle] = useState(
    t("hc_sharedComponentsDuplicateAssessmentDialog.copyOfTitle", { title: source.title }),
  );
  // Flags "qué copiar". Default true para cada opción del tipo actual —
  // preserva el comportamiento histórico (duplicar todo) si el docente no
  // desmarca nada.
  const [copyFlags, setCopyFlags] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(copyOptions.map((o) => [o.param, true])),
  );
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTargetCourseId(source.courseId);
    setNewTitle(t("hc_sharedComponentsDuplicateAssessmentDialog.copyOfTitle", { title: source.title }));
    setCopyFlags(Object.fromEntries(copyOptions.map((o) => [o.param, true])));
    (async () => {
      let query;
      if (isAdmin) {
        query = db.from("courses").select("id, name").order("name");
      } else {
        // Solo cursos donde el docente está asignado (puede clonar a uno
        // distinto al origen también).
        query = db
          .from("courses")
          .select("id, name, course_teachers!inner(user_id)")
          .order("name");
      }
      const { data, error } = await query;
      if (error) {
        toast.error(friendlyError(error));
        setLoading(false);
        return;
      }
      setCourses((data ?? []) as Course[]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source.id]);

  const submit = async () => {
    if (!targetCourseId) {
      toast.error(
        i18n.t("toast.shared_components_DuplicateAssessmentDialog.selectTargetCourse", {
          defaultValue: "Selecciona el curso destino",
        }),
      );
      return;
    }
    if (!newTitle.trim()) {
      toast.error(
        i18n.t("toast.shared_components_DuplicateAssessmentDialog.enterCopyTitle", {
          defaultValue: "Ingresa un título para la copia",
        }),
      );
      return;
    }
    setSubmitting(true);
    try {
      const params: Record<string, unknown> = {
        _source_id: source.id,
        _target_course_id: targetCourseId,
        _new_title: newTitle.trim(),
        // Flags "qué copiar" — el RPC clone_* los respeta (mig 20260918000000).
        ...copyFlags,
      };
      const { data, error } = await db.rpc(RPC_BY_TARGET[target], params);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const newId = String(data);
      toast.success(
        i18n.t("toast.shared_components_DuplicateAssessmentDialog.copyCreated", {
          defaultValue:
            "Copia creada (queda en borrador — revisa fechas y peso antes de publicar)",
        }),
      );
      onDuplicated?.(newId);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" hideCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4 text-indigo-500" />
            {t("hc_sharedComponentsDuplicateAssessmentDialog.dialogTitle", {
              target: t(LABEL_KEY_BY_TARGET[target]),
            })}
          </DialogTitle>
          <DialogDescription>
            <span
              dangerouslySetInnerHTML={{
                __html: t("hc_sharedComponentsDuplicateAssessmentDialog.dialogDescription"),
              }}
            />
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>{t("hc_sharedComponentsDuplicateAssessmentDialog.targetCourseLabel")}</Label>
            <Select value={targetCourseId} onValueChange={setTargetCourseId}>
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    loading
                      ? t("hc_sharedComponentsDuplicateAssessmentDialog.loadingPlaceholder")
                      : t("hc_sharedComponentsDuplicateAssessmentDialog.selectPlaceholder")
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.id === source.courseId
                      ? t("hc_sharedComponentsDuplicateAssessmentDialog.sameCourseSuffix")
                      : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("hc_sharedComponentsDuplicateAssessmentDialog.copyTitleLabel")}</Label>
            <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          </div>

          {/* Parametrización: qué información interna copiar. */}
          <div className="space-y-2 rounded-md border p-3">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              {t("hc_sharedComponentsDuplicateAssessmentDialog.whatToCopy")}
            </Label>
            {copyOptions.map((opt) => (
              <label
                key={opt.param}
                className="flex items-start gap-2 cursor-pointer select-none"
              >
                <Checkbox
                  checked={copyFlags[opt.param] ?? true}
                  onCheckedChange={(v) =>
                    setCopyFlags((prev) => ({ ...prev, [opt.param]: Boolean(v) }))
                  }
                  disabled={submitting}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-sm font-medium block">{t(opt.labelKey)}</span>
                  <span className="text-[11px] text-muted-foreground block">{t(opt.hintKey)}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("hc_sharedComponentsDuplicateAssessmentDialog.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || loading}>
            {submitting ? <Spinner size="sm" className="mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
            {t("hc_sharedComponentsDuplicateAssessmentDialog.duplicate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

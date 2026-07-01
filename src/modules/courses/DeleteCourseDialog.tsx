import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangle, Trash2 } from "lucide-react";
import {
  courseContentSummary,
  courseHasContent,
  type CourseContentSummary,
} from "@/modules/trash/soft-delete";

interface DeleteCourseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 1 curso = flujo single; N = bulk (se suman los conteos). */
  courseIds: string[];
  /** Etiqueta para el título: nombre del curso (1) o "N cursos" (bulk). */
  courseLabel: string;
  /** El caller ejecuta el borrado (loop sobre soft_delete_course_cascade) + recarga. */
  onConfirm: (cascade: boolean) => void | Promise<void>;
}

type Aggregate = CourseContentSummary;

const EMPTY: Aggregate = {
  exams: 0,
  workshops: 0,
  projects: 0,
  sessions: 0,
  whiteboards: 0,
  contents: 0,
  polls: 0,
  enrollments: 0,
  forums: 0,
};

// Claves de entidad para las líneas de conteo (el label sale de i18n:
// deleteCourseDialog.entities.<key>).
const ENTITY_KEYS: Array<[keyof Aggregate, string]> = [
  ["exams", "exams"],
  ["workshops", "workshops"],
  ["projects", "projects"],
  ["sessions", "sessions"],
  ["whiteboards", "whiteboards"],
  ["contents", "contents"],
  ["polls", "polls"],
];

/** Diálogo de borrado de curso(s) con advertencia de contenido huérfano + la
 *  opción de qué hacer con él (cascada a papelera vs. solo el curso). */
export function DeleteCourseDialog({
  open,
  onOpenChange,
  courseIds,
  courseLabel,
  onConfirm,
}: DeleteCourseDialogProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<Aggregate>(EMPTY);
  const [cascade, setCascade] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setCascade(true);
    void (async () => {
      const agg: Aggregate = { ...EMPTY };
      for (const id of courseIds) {
        const { data } = await courseContentSummary(id);
        if (cancelled) return;
        if (data) {
          (Object.keys(EMPTY) as (keyof Aggregate)[]).forEach((k) => {
            agg[k] += Number(data[k] ?? 0);
          });
        }
      }
      if (cancelled) return;
      setSummary(agg);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, courseIds]);

  const hasContent = courseHasContent(summary);

  // Líneas de conteo (solo las > 0) para la advertencia — el label es traducible.
  const contentLines = ENTITY_KEYS.map(([field, key]) => ({ key, n: summary[field] })).filter(
    ({ n }) => n > 0,
  );

  const handleConfirm = async () => {
    setSubmitting(true);
    try {
      await onConfirm(hasContent ? cascade : false);
      onOpenChange(false);
    } catch {
      // el caller maneja/toastea; no cerramos para que el usuario reintente
    } finally {
      setSubmitting(false);
    }
  };

  const multi = courseIds.length > 1;

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="h-5 w-5 text-destructive" />
            {multi
              ? t("deleteCourseDialog.titleMulti", { label: courseLabel })
              : t("deleteCourseDialog.title", { label: courseLabel })}
          </DialogTitle>
          <DialogDescription>
            {multi ? t("deleteCourseDialog.descMulti") : t("deleteCourseDialog.descSingle")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner size="sm" /> {t("deleteCourseDialog.checking")}
          </div>
        ) : !hasContent ? (
          <p className="py-2 text-sm text-muted-foreground">
            {multi
              ? t("deleteCourseDialog.noContentMulti")
              : t("deleteCourseDialog.noContentSingle")}
            {summary.enrollments > 0
              ? t("deleteCourseDialog.enrollmentsHidden", { n: summary.enrollments })
              : ""}
            .
          </p>
        ) : (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {multi
                  ? t("deleteCourseDialog.hasContentMulti")
                  : t("deleteCourseDialog.hasContentSingle")}{" "}
                <strong>
                  {contentLines
                    .map(({ key, n }) =>
                      t("deleteCourseDialog.line", {
                        n,
                        label: t(`deleteCourseDialog.entities.${key}`),
                      }),
                    )
                    .join(" · ")}
                </strong>
                {summary.enrollments > 0
                  ? t("deleteCourseDialog.enrollmentsSuffix", { n: summary.enrollments })
                  : ""}
                {t("deleteCourseDialog.chooseWhat")}
              </AlertDescription>
            </Alert>

            <RadioGroup
              value={cascade ? "cascade" : "course_only"}
              onValueChange={(v) => setCascade(v === "cascade")}
              className="gap-3"
            >
              <div className="flex items-start gap-2">
                <RadioGroupItem value="cascade" id="opt-cascade" className="mt-0.5" />
                <Label htmlFor="opt-cascade" className="font-normal cursor-pointer">
                  <span className="font-medium">{t("deleteCourseDialog.cascadeTitle")}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {t("deleteCourseDialog.cascadeHint")}
                  </span>
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="course_only" id="opt-course-only" className="mt-0.5" />
                <Label htmlFor="opt-course-only" className="font-normal cursor-pointer">
                  <span className="font-medium">{t("deleteCourseDialog.courseOnlyTitle")}</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {t("deleteCourseDialog.courseOnlyHint")}
                  </span>
                </Label>
              </div>
            </RadioGroup>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t("deleteCourseDialog.cancel")}
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading || submitting}>
            {submitting ? <Spinner size="sm" className="mr-2" /> : null}
            {hasContent && cascade
              ? t("deleteCourseDialog.confirmWithContent")
              : t("deleteCourseDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

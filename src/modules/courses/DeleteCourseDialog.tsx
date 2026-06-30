import { useEffect, useState } from "react";
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
import { friendlyError } from "@/shared/lib/db-errors";

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

/** Diálogo de borrado de curso(s) con advertencia de contenido huérfano + la
 *  opción de qué hacer con él (cascada a papelera vs. solo el curso). */
export function DeleteCourseDialog({
  open,
  onOpenChange,
  courseIds,
  courseLabel,
  onConfirm,
}: DeleteCourseDialogProps) {
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

  // Líneas de conteo (solo las > 0) para la advertencia.
  const items: Array<[string, number]> = [
    ["exámenes", summary.exams],
    ["talleres", summary.workshops],
    ["proyectos", summary.projects],
    ["sesiones", summary.sessions],
    ["pizarras", summary.whiteboards],
    ["contenidos", summary.contents],
    ["encuestas", summary.polls],
  ];
  const contentLines = items.filter(([, n]) => n > 0);

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
            {multi ? `Eliminar ${courseLabel}` : `Eliminar curso «${courseLabel}»`}
          </DialogTitle>
          <DialogDescription>
            {multi
              ? "Los cursos seleccionados se moverán a la papelera."
              : "El curso se moverá a la papelera (recuperable durante 30 días)."}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Spinner size="sm" /> Revisando el contenido asociado…
          </div>
        ) : !hasContent ? (
          <p className="py-2 text-sm text-muted-foreground">
            {multi ? "Los cursos no tienen" : "Este curso no tiene"} contenido asociado
            {summary.enrollments > 0 ? ` (sí ${summary.enrollments} matrícula(s), que se ocultarán)` : ""}.
          </p>
        ) : (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {multi ? "Estos cursos tienen" : "Este curso tiene"} contenido asociado:{" "}
                <strong>
                  {contentLines.map(([label, n]) => `${n} ${label}`).join(" · ")}
                </strong>
                {summary.enrollments > 0 ? ` · ${summary.enrollments} matrícula(s)` : ""}. Elegí
                qué hacer con él.
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
                  <span className="font-medium">Mover el curso y todo su contenido a la papelera</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Recomendado. Todo se puede restaurar junto desde la papelera (al restaurar el
                    curso vuelve su contenido).
                  </span>
                </Label>
              </div>
              <div className="flex items-start gap-2">
                <RadioGroupItem value="course_only" id="opt-course-only" className="mt-0.5" />
                <Label htmlFor="opt-course-only" className="font-normal cursor-pointer">
                  <span className="font-medium">Eliminar solo el curso</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    El contenido queda huérfano: oculto para todos (alumnos y staff) hasta que
                    restaures el curso, pero no se envía a la papelera.
                  </span>
                </Label>
              </div>
            </RadioGroup>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button variant="destructive" onClick={handleConfirm} disabled={loading || submitting}>
            {submitting ? <Spinner size="sm" className="mr-2" /> : null}
            {hasContent && cascade ? "Eliminar curso y contenido" : "Eliminar curso"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

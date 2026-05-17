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

const LABEL_BY_TARGET: Record<Props["target"], string> = {
  exam: "examen",
  workshop: "taller",
  project: "proyecto",
};

export function DuplicateAssessmentDialog({
  open,
  onOpenChange,
  source,
  target,
  onDuplicated,
}: Props) {
  const { roles } = useAuth();
  const isAdmin = roles.includes("Admin");

  const [courses, setCourses] = useState<Course[]>([]);
  const [targetCourseId, setTargetCourseId] = useState<string>(source.courseId);
  const [newTitle, setNewTitle] = useState(`Copia de ${source.title}`);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setTargetCourseId(source.courseId);
    setNewTitle(`Copia de ${source.title}`);
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
        toast.error(error.message);
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
      toast.error("Selecciona el curso destino");
      return;
    }
    if (!newTitle.trim()) {
      toast.error("Ingresa un título para la copia");
      return;
    }
    setSubmitting(true);
    try {
      const params: Record<string, unknown> = {
        _source_id: source.id,
        _target_course_id: targetCourseId,
        _new_title: newTitle.trim(),
      };
      const { data, error } = await db.rpc(RPC_BY_TARGET[target], params);
      if (error) {
        toast.error(error.message);
        return;
      }
      const newId = String(data);
      toast.success(
        `Copia creada (queda en borrador — revisa fechas y peso antes de publicar)`,
      );
      onDuplicated?.(newId);
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4 text-indigo-500" />
            Duplicar {LABEL_BY_TARGET[target]}
          </DialogTitle>
          <DialogDescription>
            Crea una copia con preguntas y configuración. La copia queda en{" "}
            <strong>borrador</strong> — debes revisar fechas, peso y corte antes de publicar.
            Asignaciones, entregas y grupos NO se copian.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Curso destino</Label>
            <Select value={targetCourseId} onValueChange={setTargetCourseId}>
              <SelectTrigger>
                <SelectValue placeholder={loading ? "Cargando…" : "Selecciona…"} />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                    {c.id === source.courseId ? " (mismo curso)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Título de la copia</Label>
            <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={submitting || loading}>
            {submitting ? <Spinner size="sm" className="mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
            Duplicar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

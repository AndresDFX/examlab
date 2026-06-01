/**
 * LaunchPollDialog — diálogo "rápido" para lanzar una encuesta DENTRO
 * de una sesión presencial.
 *
 * Diferencias vs. el CreatePollDialog del módulo
 * `/app/teacher/polls`:
 *   - `course_id` y `attendance_session_id` vienen pre-rellenados desde
 *     el caller (el docente está PARADO en esa sesión, no le pedimos
 *     elegir curso de nuevo).
 *   - Form mínimo: título, tipo (default `single`), opciones, visibilidad
 *     de resultados. Sin fecha de cierre — el docente cierra
 *     manualmente cuando termine la pregunta en clase. Sin descripción
 *     (es una pregunta in-the-moment).
 *   - Defaults orientados al uso "show of hands":
 *     `results_visible_to_students = 'always'` para que el alumno vea
 *     los votos al instante (típico de una clase interactiva).
 *
 * Reusa el mismo schema (`polls` + `poll_options`) y misma RPC para
 * el voto (la RLS del DB no diferencia "encuesta en sesión" vs
 * "encuesta suelta", solo le importa el course_id).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { RowAction } from "@/components/ui/row-action";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { Plus, Trash2, Zap } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type PollType = "single" | "multiple" | "slot";
type ResultsVis = "always" | "after_close" | "never";

interface DraftOption {
  label: string;
  max_responses: string;
}

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Curso al que pertenece la sesión. Obligatorio: la encuesta
   *  hereda este `course_id` y la RLS se aplica contra él. */
  courseId: string;
  /** Sesión presencial donde la encuesta se lanza. Si se omite, la
   *  encuesta queda "suelta" del curso (mismo modo de uso que el
   *  CreatePollDialog del módulo dedicado). */
  attendanceSessionId?: string | null;
  /** Etiqueta humana de la sesión para mostrar en el header del dialog
   *  (ej. "Clase 3 · 28 sep"). Opcional. */
  sessionLabel?: string;
  /** Callback al crear exitosamente — el caller refetchea o navega. */
  onCreated?: (pollId: string) => void;
}

export function LaunchPollDialog({
  open,
  onOpenChange,
  courseId,
  attendanceSessionId,
  sessionLabel,
  onCreated,
}: Props) {
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<PollType>("single");
  const [visibility, setVisibility] = useState<ResultsVis>("always");
  const [options, setOptions] = useState<DraftOption[]>([
    { label: "", max_responses: "" },
    { label: "", max_responses: "" },
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setTitle("");
      setType("single");
      setVisibility("always");
      setOptions([
        { label: "", max_responses: "" },
        { label: "", max_responses: "" },
      ]);
    }
  }, [open]);

  const addOption = () => setOptions((opts) => [...opts, { label: "", max_responses: "" }]);
  const removeOption = (idx: number) =>
    setOptions((opts) => (opts.length > 2 ? opts.filter((_, i) => i !== idx) : opts));
  const updateOption = (idx: number, patch: Partial<DraftOption>) =>
    setOptions((opts) => opts.map((o, i) => (i === idx ? { ...o, ...patch } : o)));

  const save = async () => {
    if (!user) return;
    if (!title.trim()) {
      toast.error("Escribí la pregunta");
      return;
    }
    const validOptions = options.filter((o) => o.label.trim());
    if (validOptions.length < 2) {
      toast.error("Se necesitan al menos 2 opciones");
      return;
    }
    if (type === "slot") {
      const bad = validOptions.some((o) => {
        const n = Number(o.max_responses);
        return !Number.isInteger(n) || n <= 0;
      });
      if (bad) {
        toast.error("En tipo 'cupo por opción' cada opción necesita un cupo entero > 0");
        return;
      }
    }
    setSaving(true);
    try {
      const { data: pollRow, error: pollErr } = await db
        .from("polls")
        .insert({
          course_id: courseId,
          attendance_session_id: attendanceSessionId ?? null,
          title: title.trim(),
          poll_type: type,
          results_visible_to_students: visibility,
          // closes_at NULL = cerrada manualmente. Acorde al caso de
          // uso "in-session": el docente cierra cuando termina la
          // pregunta.
          created_by: user.id,
        })
        .select("id")
        .single();
      if (pollErr || !pollRow) {
        toast.error(friendlyError(pollErr, "No se pudo crear la encuesta"));
        return;
      }
      const optionsPayload = validOptions.map((o, idx) => ({
        poll_id: pollRow.id,
        label: o.label.trim(),
        position: idx,
        max_responses: type === "slot" ? Number(o.max_responses) : null,
      }));
      const { error: optsErr } = await db.from("poll_options").insert(optionsPayload);
      if (optsErr) {
        // Rollback: borrar poll huérfana.
        await db.from("polls").delete().eq("id", pollRow.id);
        toast.error(friendlyError(optsErr, "No se pudieron crear las opciones"));
        return;
      }
      toast.success("Encuesta lanzada");
      onOpenChange(false);
      onCreated?.(pollRow.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-sky-500" />
            Lanzar encuesta en vivo
          </DialogTitle>
          {sessionLabel && <p className="text-xs text-muted-foreground">Sesión: {sessionLabel}</p>}
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label required>Pregunta</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Ej: ¿Quedó claro el concepto?"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label required>Tipo</Label>
              <Select value={type} onValueChange={(v) => setType(v as PollType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">Opción única</SelectItem>
                  <SelectItem value="multiple">Múltiple</SelectItem>
                  <SelectItem value="slot">Cupo por opción</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Resultados</Label>
              <Select value={visibility} onValueChange={(v) => setVisibility(v as ResultsVis)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">Visibles al alumno</SelectItem>
                  <SelectItem value="after_close">Tras cerrar</SelectItem>
                  <SelectItem value="never">Solo docente</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label required>Opciones</Label>
            <div className="space-y-2 mt-1">
              {options.map((o, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={o.label}
                    onChange={(e) => updateOption(idx, { label: e.target.value })}
                    placeholder={`Opción ${idx + 1}`}
                    className="flex-1"
                  />
                  {type === "slot" && (
                    <Input
                      type="number"
                      min={1}
                      value={o.max_responses}
                      onChange={(e) => updateOption(idx, { max_responses: e.target.value })}
                      placeholder="Cupo"
                      className="w-20"
                    />
                  )}
                  {options.length > 2 && (
                    <RowAction
                      label="Quitar opción"
                      icon={Trash2}
                      tone="destructive"
                      onClick={() => removeOption(idx)}
                    />
                  )}
                </div>
              ))}
              <Button variant="outline" size="sm" onClick={addOption}>
                <Plus className="h-3.5 w-3.5 mr-1" />
                Agregar opción
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            La encuesta queda abierta hasta que la cierres manualmente desde el módulo de Encuestas
            o la dejes vencer.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Spinner size="sm" className="mr-1" />}
            <Zap className="h-3.5 w-3.5 mr-1" />
            Lanzar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

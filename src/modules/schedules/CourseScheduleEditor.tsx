/**
 * Editor de horarios de un curso (dialog reutilizable).
 *
 * Se abre desde el grid de cursos (admin/teacher) vía un row action.
 * Carga los bloques existentes, permite añadir/editar/eliminar inline
 * y persiste al cerrar.
 *
 * Performance: una sola query al abrir, un solo upsert+delete al
 * guardar. La validación de overlap se hace en cliente con
 * `blocksOverlap` — si hay overlap solo mostramos warning, no
 * bloqueamos (un curso puede legítimamente solaparse dentro del
 * mismo día si así lo decide la institución).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Plus, Trash2, CalendarClock, AlertTriangle } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";
import {
  blocksOverlap,
  compareBlocks,
  DAY_LABELS,
  WEEK_ORDER,
  type CourseScheduleBlock,
  type DayOfWeek,
  type Modalidad,
} from "./course-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string;
  courseName: string;
}

interface Draft extends CourseScheduleBlock {
  /** Identificador local para reactividad. Si tiene `id` real de DB,
   *  usamos eso; si es bloque nuevo, generamos uno con crypto. */
  _key: string;
  /** Marca para eliminar al guardar (solo aplica a filas con id de DB). */
  _deleted?: boolean;
}

function newBlock(): Draft {
  return {
    _key: crypto.randomUUID(),
    day_of_week: 1,
    start_time: "08:00",
    end_time: "10:00",
    aula: "",
    modalidad: "presencial",
    notes: null,
  };
}

export function CourseScheduleEditor({ open, onOpenChange, courseId, courseName }: Props) {
  const { user } = useAuth();
  const [blocks, setBlocks] = useState<Draft[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open || !courseId) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data, error } = await db
        .from("course_schedules")
        .select("id, day_of_week, start_time, end_time, aula, modalidad, notes")
        .eq("course_id", courseId)
        .order("day_of_week")
        .order("start_time");
      if (cancelled) return;
      if (error) {
        toast.error(friendlyError(error, "No pudimos cargar el horario"));
        setLoading(false);
        return;
      }
      setBlocks(
        ((data ?? []) as CourseScheduleBlock[]).map((b) => ({
          ...b,
          _key: b.id ?? crypto.randomUUID(),
        })),
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, courseId]);

  const addBlock = () => setBlocks((prev) => [...prev, newBlock()]);
  const updateBlock = (key: string, patch: Partial<Draft>) =>
    setBlocks((prev) => prev.map((b) => (b._key === key ? { ...b, ...patch } : b)));
  const removeBlock = (key: string) =>
    setBlocks((prev) =>
      prev
        .map((b) =>
          b._key === key
            ? // si tenía id de DB, solo lo marcamos; si era local, lo quitamos
              b.id
              ? { ...b, _deleted: true }
              : null
            : b,
        )
        .filter((b): b is Draft => b !== null),
    );

  // Lista filtrada (sin los marcados para eliminar) para render.
  const visible = blocks.filter((b) => !b._deleted).sort(compareBlocks);

  // Detección de overlaps (warning visual; no bloquea).
  const overlapKeys = new Set<string>();
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      if (blocksOverlap(visible[i], visible[j])) {
        overlapKeys.add(visible[i]._key);
        overlapKeys.add(visible[j]._key);
      }
    }
  }

  const save = async () => {
    if (!user) return;
    // Validación básica: end > start lo enforza el CHECK de DB, pero
    // chequeamos en cliente para dar mejor error.
    for (const b of visible) {
      if (b.end_time <= b.start_time) {
        toast.error(
          `${DAY_LABELS[b.day_of_week]}: la hora de fin debe ser posterior a la de inicio.`,
        );
        return;
      }
    }
    setSaving(true);
    try {
      // Borrar primero los marcados.
      const toDelete = blocks.filter((b) => b._deleted && b.id).map((b) => b.id!);
      if (toDelete.length > 0) {
        const { error } = await db.from("course_schedules").delete().in("id", toDelete);
        if (error) throw new Error(error.message);
      }
      // Upsert del resto.
      const payload = visible.map((b) => ({
        ...(b.id ? { id: b.id } : {}),
        course_id: courseId,
        day_of_week: b.day_of_week,
        start_time: b.start_time,
        end_time: b.end_time,
        aula: b.aula?.trim() || null,
        modalidad: b.modalidad,
        notes: b.notes?.trim() || null,
      }));
      if (payload.length > 0) {
        const { error } = await db.from("course_schedules").upsert(payload);
        if (error) throw new Error(error.message);
      }
      void logEvent({
        action: "course.schedule_updated",
        category: "academic",
        severity: "info",
        entityType: "course",
        entityId: courseId,
        entityName: courseName,
        courseId,
        courseName,
        metadata: { blocks: visible.length },
      });
      toast.success("Horario guardado");
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo guardar el horario"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarClock className="h-5 w-5 text-cyan-500" />
            Horario de {courseName}
          </DialogTitle>
          <DialogDescription>
            Bloques semanales recurrentes. Múltiples bloques permitidos. El curso se dicta cada
            semana del periodo en los horarios definidos.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
            <Spinner size="sm" /> Cargando…
          </div>
        ) : (
          <div className="space-y-3">
            {visible.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-6 border rounded-md border-dashed">
                Aún no has definido bloques para este curso.
              </div>
            ) : (
              <div className="space-y-2">
                {visible.map((b) => (
                  <div
                    key={b._key}
                    className={`rounded-md border p-3 grid grid-cols-2 sm:grid-cols-[120px_104px_104px_130px_minmax(150px,1fr)_36px] items-end gap-2 ${
                      overlapKeys.has(b._key)
                        ? "border-amber-400 bg-amber-50/50 dark:bg-amber-500/5"
                        : ""
                    }`}
                  >
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Día
                      </Label>
                      <Select
                        value={String(b.day_of_week)}
                        onValueChange={(v) =>
                          updateBlock(b._key, { day_of_week: Number(v) as DayOfWeek })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WEEK_ORDER.map((d) => (
                            <SelectItem key={d} value={String(d)}>
                              {DAY_LABELS[d]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Inicio
                      </Label>
                      <Input
                        type="time"
                        value={b.start_time.slice(0, 5)}
                        onChange={(e) => updateBlock(b._key, { start_time: e.target.value })}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Fin
                      </Label>
                      <Input
                        type="time"
                        value={b.end_time.slice(0, 5)}
                        onChange={(e) => updateBlock(b._key, { end_time: e.target.value })}
                        className="h-8"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Modalidad
                      </Label>
                      <Select
                        value={b.modalidad}
                        onValueChange={(v) => updateBlock(b._key, { modalidad: v as Modalidad })}
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="presencial">Presencial</SelectItem>
                          <SelectItem value="virtual">Virtual</SelectItem>
                          <SelectItem value="hibrida">Híbrida</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1 col-span-2 sm:col-span-1">
                      <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        Aula / link
                      </Label>
                      <Input
                        value={b.aula ?? ""}
                        onChange={(e) => updateBlock(b._key, { aula: e.target.value })}
                        placeholder="Aula 301 / Zoom link"
                        className="h-8"
                      />
                    </div>
                    <div className="flex justify-end col-span-2 sm:col-span-1">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => removeBlock(b._key)}
                        title="Eliminar bloque"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {overlapKeys.size > 0 && (
              <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                Algunos bloques se solapan en horario. Revisa antes de guardar (no es bloqueante).
              </div>
            )}

            <Button type="button" variant="outline" size="sm" onClick={addBlock}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              Agregar bloque
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving || loading}>
            {saving ? "Guardando…" : "Guardar horario"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

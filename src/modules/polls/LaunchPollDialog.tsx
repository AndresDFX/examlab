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
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { RowAction } from "@/components/ui/row-action";
import { HelpHint } from "@/components/ui/help-hint";
import { Switch } from "@/components/ui/switch";
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
  const { t } = useTranslation();
  const { user } = useAuth();
  const [title, setTitle] = useState("");
  const [type, setType] = useState<PollType>("single");
  const [visibility, setVisibility] = useState<ResultsVis>("always");
  // Parámetros del docente (mig 20260603000000). En vivo defaults:
  // allowChange=true (alumno puede corregirse durante la pregunta) y
  // autoCloseAll=false (el docente cierra cuando termina, suele ser
  // antes de que todos respondan).
  const [allowChange, setAllowChange] = useState(true);
  const [autoCloseAll, setAutoCloseAll] = useState(false);
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
      setAllowChange(true);
      setAutoCloseAll(false);
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
      toast.error(
        i18n.t("toast.modules_polls_LaunchPollDialog.questionRequired", {
          defaultValue: "Escribí la pregunta",
        }),
      );
      return;
    }
    const validOptions = options.filter((o) => o.label.trim());
    if (validOptions.length < 2) {
      toast.error(
        i18n.t("toast.modules_polls_LaunchPollDialog.minTwoOptions", {
          defaultValue: "Se necesitan al menos 2 opciones",
        }),
      );
      return;
    }
    if (type === "slot") {
      const bad = validOptions.some((o) => {
        const n = Number(o.max_responses);
        return !Number.isInteger(n) || n <= 0;
      });
      if (bad) {
        toast.error(
          i18n.t("toast.modules_polls_LaunchPollDialog.slotNeedsPositiveCapacity", {
            defaultValue: "En tipo 'cupo por opción' cada opción necesita un cupo entero > 0",
          }),
        );
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
          allow_change_response: allowChange,
          auto_close_when_all_responded: autoCloseAll,
          // closes_at NULL = cerrada manualmente. Acorde al caso de
          // uso "in-session": el docente cierra cuando termina la
          // pregunta. El trigger AFTER INSERT (mig 20260603020000)
          // se encarga de poblar poll_courses con el curso ancla.
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
      toast.success(
        i18n.t("toast.modules_polls_LaunchPollDialog.pollLaunched", {
          defaultValue: "Encuesta lanzada",
        }),
      );
      onOpenChange(false);
      onCreated?.(pollRow.id);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
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
              <Label required>
                Tipo{" "}
                <HelpHint side="right">
                  <div className="space-y-2 text-xs">
                    <p>
                      <strong>Opción única:</strong> el alumno elige <em>una sola</em> opción
                      (comprensión rápida, satisfacción).
                    </p>
                    <p>
                      <strong>Múltiple:</strong> el alumno puede marcar <em>varias</em>
                      opciones a la vez.
                    </p>
                    <p>
                      <strong>Cupo por opción (Doodle):</strong> cada opción tiene un cupo limitado
                      y se cierra al llenarse. Ideal para repartir fechas/turnos (ej. sustentaciones
                      de proyecto).
                    </p>
                  </div>
                </HelpHint>
              </Label>
              <Select value={type} onValueChange={(v) => setType(v as PollType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="single">
                    <div className="flex flex-col gap-0.5">
                      <span>Opción única</span>
                      <span className="text-[11px] text-muted-foreground">
                        El alumno elige una sola opción
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="multiple">
                    <div className="flex flex-col gap-0.5">
                      <span>Múltiple</span>
                      <span className="text-[11px] text-muted-foreground">
                        El alumno puede marcar varias opciones
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="slot">
                    <div className="flex flex-col gap-0.5">
                      <span>Cupo por opción (Doodle)</span>
                      <span className="text-[11px] text-muted-foreground">
                        Cupo limitado por opción — ej. fechas de sustentación
                      </span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>
                Resultados{" "}
                <HelpHint side="left">
                  <div className="space-y-2 text-xs">
                    <p>
                      <strong>Visibles al alumno:</strong> ve resultados parciales en cuanto vota.
                    </p>
                    <p>
                      <strong>Tras cerrar:</strong> los ve solo cuando cierras la encuesta. Evita el
                      sesgo de "votar lo que ya va ganando".
                    </p>
                    <p>
                      <strong>Solo docente:</strong> los alumnos nunca ven resultados; útil para
                      feedback honesto.
                    </p>
                  </div>
                </HelpHint>
              </Label>
              <Select value={visibility} onValueChange={(v) => setVisibility(v as ResultsVis)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="always">
                    <div className="flex flex-col gap-0.5">
                      <span>Visibles al alumno</span>
                      <span className="text-[11px] text-muted-foreground">
                        Ve resultados parciales mientras vota
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="after_close">
                    <div className="flex flex-col gap-0.5">
                      <span>Tras cerrar</span>
                      <span className="text-[11px] text-muted-foreground">
                        Solo cuando termines la encuesta
                      </span>
                    </div>
                  </SelectItem>
                  <SelectItem value="never">
                    <div className="flex flex-col gap-0.5">
                      <span>Solo docente</span>
                      <span className="text-[11px] text-muted-foreground">
                        El alumno nunca los ve
                      </span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Switches de comportamiento del voto (mig 20260603000000).
              Compactos para no inflar el dialog del live launch. */}
          <div className="space-y-1.5 rounded-md border bg-muted/20 p-2 text-xs">
            <label className="flex items-start justify-between gap-2 cursor-pointer">
              <span className="flex-1 min-w-0">
                <span className="font-medium flex items-center gap-1">
                  Permitir cambiar respuesta
                  <HelpHint>{t("help.pollAllowChangeResponseShort")}</HelpHint>
                </span>
              </span>
              <Switch checked={allowChange} onCheckedChange={setAllowChange} />
            </label>
            <label className="flex items-start justify-between gap-2 cursor-pointer pt-1.5 border-t">
              <span className="flex-1 min-w-0">
                <span className="font-medium flex items-center gap-1">
                  Cerrar al responder todos
                  <HelpHint>{t("help.pollAutoCloseAllRespondedShort")}</HelpHint>
                </span>
              </span>
              <Switch checked={autoCloseAll} onCheckedChange={setAutoCloseAll} />
            </label>
          </div>

          <div>
            <Label required>
              Opciones{" "}
              <HelpHint side="right">
                <div className="space-y-1 text-xs">
                  <p>Mínimo 2 respuestas para que el alumno elija.</p>
                  {type === "slot" && (
                    <p>
                      <strong>Cupo:</strong> máximo de alumnos que pueden elegir esa opción. Ej. si
                      cada opción es una fecha de sustentación y caben 5 estudiantes por día, pon{" "}
                      <code>5</code> en cada cupo.
                    </p>
                  )}
                </div>
              </HelpHint>
            </Label>
            <div className="space-y-2 mt-1">
              {options.map((o, idx) => (
                <div key={idx} className="flex items-center gap-2">
                  <Input
                    value={o.label}
                    onChange={(e) => updateOption(idx, { label: e.target.value })}
                    placeholder={
                      type === "slot"
                        ? idx === 0
                          ? "Ej: Lun 10 jun, 9:00 AM"
                          : idx === 1
                            ? "Ej: Lun 10 jun, 10:00 AM"
                            : `Opción ${idx + 1}`
                        : `Opción ${idx + 1}`
                    }
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
                      title="Máximo de alumnos que pueden elegir esta opción"
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

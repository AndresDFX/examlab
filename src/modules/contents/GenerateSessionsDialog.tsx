/**
 * GenerateSessionsDialog — programa N sesiones de asistencia para un
 * curso a partir de fecha inicio + días de semana.
 *
 * Dos modos de uso:
 *   1. **Desde un contenido generado** (Módulo Contenidos): recibe el
 *      `content` y reusa los datos detectados (clases, títulos). Cada
 *      sesión queda asociada al contenido (`content_id`) + clase
 *      correspondiente (`content_class_index`). Preview read-only.
 *
 *   2. **Desde el Tablero de Asistencia** (`content` null): el docente agenda
 *      sesiones del curso. Este modo PREFIJA los días + horarios desde el
 *      horario del curso (`course_schedules`), marca los FESTIVOS de Colombia
 *      (omitir / mover / incluir) y muestra una PREVIEW EDITABLE por fila
 *      (fecha, título, hora, duración). Al crear, las sesiones quedan en el
 *      tablero de Asistencia con su hora y duración.
 *
 * Si hay sesiones existentes (modo 1) ofrecemos Reusar / Crear.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
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
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { HelpHint } from "@/components/ui/help-hint";
import { Spinner } from "@/components/ui/spinner";
import { CalendarPlus, X } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  availableClassNumbers,
  extractClassTitle,
  type ContentFile,
} from "@/modules/contents/contents-extract";
import {
  computeSessionDates,
  parseLocalIsoDate,
  toLocalIsoDate,
  WEEKDAYS_ES,
} from "@/modules/contents/session-dates";
import {
  buildSessionPlan,
  type HolidayPolicy,
  type SessionPlanRow,
} from "@/modules/contents/session-plan";
import { isCoHoliday, coHolidayName } from "@/modules/schedules/co-holidays";
import type { CourseScheduleBlock } from "@/modules/schedules/course-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

/** Shape mínimo del contenido que el dialog consume. Definido aquí para
 *  no acoplar el componente al tipo completo de `generated_contents`. */
export interface GenerateSessionsContent {
  id: string;
  course_id: string | null;
  topic: string;
  /** Nombre humano único — si está poblado lo usamos en la preview en
   *  vez del topic. Backwards-compatible con filas pre-migración. */
  display_name?: string | null;
  mode: "curso_completo" | "material_individual";
  files: ContentFile[];
}

interface ExistingSessionRow {
  id: string;
  session_date: string;
  title: string | null;
  content_id: string | null;
}

interface GenerateSessionsDialogProps {
  /** Controla apertura del dialog. */
  open: boolean;
  /** Modo 1: contenido asociado. Modo 2 (null): sesiones vacías. */
  content: GenerateSessionsContent | null;
  /** Curso destino. Si `content?.course_id` está poblado tiene prioridad
   *  — útil para el modo desde contenidos donde el contenido determina
   *  el curso. En modo tablero, este prop SIEMPRE viene poblado. */
  courseId: string;
  onClose: () => void;
  /** Default 8 — solo aplica en modo "vacías" (content null). El usuario
   *  puede editarlo. En modo "con contenido" se ignora porque N viene
   *  del contenido. */
  defaultSessionCount?: number;
  onCreated: () => void;
}

const HOLIDAY_POLICIES: { value: HolidayPolicy; label: string }[] = [
  { value: "skip", label: "Omitir y recompletar" },
  { value: "move", label: "Mover al siguiente día hábil" },
  { value: "include", label: "Incluir festivos" },
];

export function GenerateSessionsDialog({
  open,
  content,
  courseId,
  defaultSessionCount = 8,
  onClose,
  onCreated,
}: GenerateSessionsDialogProps) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [startDate, setStartDate] = useState<string>("");
  // Default: Lun + Mié (patrón común universitario). El docente edita — o se
  // prefija desde el horario del curso al abrir (modo tablero).
  const [days, setDays] = useState<Set<number>>(new Set([1, 3]));
  const [conflictMode, setConflictMode] = useState<"reuse" | "create">("reuse");
  const [existingSessions, setExistingSessions] = useState<ExistingSessionRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [sessionCountInput, setSessionCountInput] = useState<number>(defaultSessionCount);
  // Modo tablero (content null): horario del curso + política de festivos +
  // preview editable.
  const [schedules, setSchedules] = useState<CourseScheduleBlock[]>([]);
  const [scheduleLoaded, setScheduleLoaded] = useState(false);
  const [holidayPolicy, setHolidayPolicy] = useState<HolidayPolicy>("skip");
  const [rows, setRows] = useState<SessionPlanRow[]>([]);

  const effectiveCourseId = content?.course_id ?? courseId ?? "";

  const classNumbers = useMemo(
    () => (content ? availableClassNumbers(content.files ?? []) : []),
    [content],
  );
  const isCursoCompleto = content?.mode === "curso_completo";

  const sessionCount = content
    ? isCursoCompleto
      ? Math.max(classNumbers.length, 1)
      : 1
    : Math.max(1, sessionCountInput);

  // Carga sesiones existentes + horario del curso al abrir.
  useEffect(() => {
    if (!open || !effectiveCourseId) {
      setExistingSessions([]);
      return;
    }
    setStartDate(toLocalIsoDate(new Date()));
    if (!content) {
      setSessionCountInput(defaultSessionCount);
      setConflictMode("create");
      setHolidayPolicy("skip");
    }
    setScheduleLoaded(false);
    void (async () => {
      const { data } = await db
        .from("attendance_sessions")
        .select("id, session_date, title, content_id")
        .eq("course_id", effectiveCourseId)
        .is("deleted_at", null)
        .order("session_date", { ascending: true });
      setExistingSessions((data ?? []) as ExistingSessionRow[]);

      // Horario del curso: prefija días + horas (solo en modo tablero).
      const { data: sch } = await db
        .from("course_schedules")
        .select("id, day_of_week, start_time, end_time, aula, modalidad, notes")
        .eq("course_id", effectiveCourseId)
        .order("day_of_week", { ascending: true })
        .order("start_time", { ascending: true });
      const blocks = (sch ?? []) as CourseScheduleBlock[];
      setSchedules(blocks);
      if (!content && blocks.length > 0) {
        setDays(new Set(blocks.map((b) => b.day_of_week)));
      }
      setScheduleLoaded(true);
    })();
    // defaultSessionCount intencional fuera del array — solo importa al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, effectiveCourseId, content?.id]);

  // Recompute del plan editable (modo tablero). Al cambiar cualquier input
  // base se regenera (se descartan ediciones manuales previas — el docente
  // ajusta filas como paso final). Espera a que el horario haya cargado para
  // no recomputar dos veces (default → prefijado).
  useEffect(() => {
    if (content || !open) return;
    if (!scheduleLoaded || !startDate || days.size === 0) {
      setRows([]);
      return;
    }
    setRows(
      buildSessionPlan({
        start: parseLocalIsoDate(startDate),
        days,
        count: sessionCount,
        schedules,
        policy: holidayPolicy,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, open, scheduleLoaded, startDate, days, sessionCount, holidayPolicy, schedules]);

  if (!open) return null;

  // Fechas para el modo CONTENIDO (read-only). En modo tablero usamos `rows`.
  const previewDates =
    content && startDate
      ? computeSessionDates(parseLocalIsoDate(startDate), days, sessionCount)
      : [];

  const toggleDay = (idx: number) => {
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const updateRow = (key: string, patch: Partial<SessionPlanRow>) =>
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) => setRows((prev) => prev.filter((r) => r.key !== key));

  // Habilitación del botón crear según modo.
  const canSubmit = content
    ? !!startDate && days.size > 0 && previewDates.length >= sessionCount
    : rows.length > 0;

  const submit = async () => {
    if (!user || !effectiveCourseId) return;
    if (!startDate) {
      toast.error(t("contents.generateSessionsErrStart", { defaultValue: "Indica una fecha de inicio." }));
      return;
    }
    if (days.size === 0) {
      toast.error(t("contents.generateSessionsErrDays", { defaultValue: "Selecciona al menos un día." }));
      return;
    }
    setSaving(true);
    try {
      // RAMA "REUSAR" (solo modo contenido con sesiones existentes).
      if (content && conflictMode === "reuse" && existingSessions.length > 0) {
        const target = existingSessions.slice(0, sessionCount);
        for (let i = 0; i < target.length; i++) {
          const cls = isCursoCompleto ? (classNumbers[i] ?? null) : null;
          const { error } = await db
            .from("attendance_sessions")
            .update({ content_id: content.id, content_class_index: cls ?? 0 })
            .eq("id", target[i].id);
          if (error) throw new Error(error.message);
        }
        toast.success(
          t("contents.generateSessionsReusedToast", {
            count: target.length,
            defaultValue: `Asignadas a ${target.length} sesión(es) existentes`,
          }),
        );
        onCreated();
        return;
      }

      let insertRows: Record<string, unknown>[];
      if (content) {
        // RAMA "CREAR" modo contenido (sin horarios/festivos — igual que antes).
        if (previewDates.length < sessionCount) {
          toast.error(
            t("contents.generateSessionsErrCount", {
              defaultValue: "No se pudieron calcular suficientes fechas.",
            }),
          );
          setSaving(false);
          return;
        }
        const files = content.files ?? [];
        insertRows = previewDates.map((d, i) => {
          const cls = isCursoCompleto ? (classNumbers[i] ?? null) : null;
          const extracted = cls != null ? extractClassTitle(files, cls) : null;
          const title =
            extracted ??
            (cls != null ? `Clase ${cls}` : content.display_name?.trim() || content.topic);
          return {
            course_id: effectiveCourseId,
            session_date: toLocalIsoDate(d),
            title,
            created_by: user.id,
            content_id: content.id,
            content_class_index: cls ?? 0,
          };
        });
      } else {
        // RAMA "CREAR" modo tablero: usa el plan editable con horarios.
        if (rows.length === 0) {
          toast.error(
            t("contents.generateSessionsErrCount", {
              defaultValue: "No se pudieron calcular suficientes fechas.",
            }),
          );
          setSaving(false);
          return;
        }
        insertRows = rows.map((r) => ({
          course_id: effectiveCourseId,
          session_date: r.iso,
          title: r.title?.trim() || null,
          // start_time TIME sin TZ ("HH:MM:00"); duration solo si hay hora
          // (mismo contrato que createSession — no inventar duración sin hora).
          start_time: r.startTime ? `${r.startTime}:00` : null,
          duration_minutes: r.startTime ? (r.durationMin ?? 90) : null,
          created_by: user.id,
        }));
      }

      const { error } = await db.from("attendance_sessions").insert(insertRows);
      if (error) throw new Error(error.message);
      toast.success(
        t("contents.generateSessionsCreatedToast", {
          count: insertRows.length,
          defaultValue: `${insertRows.length} sesión(es) creadas`,
        }),
      );
      onCreated();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  const subtitle = content
    ? t("contents.generateSessionsSubtitle", {
        count: sessionCount,
        defaultValue: `Se programarán ${sessionCount} sesión(es) para este contenido.`,
      })
    : `Se programarán las sesiones del curso con su horario. Podrás editar cada fecha antes de crearlas.`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl" hideCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarPlus className="h-5 w-5 text-primary" />
            {t("contents.generateSessionsTitle", { defaultValue: "Programar sesiones del curso" })}
          </DialogTitle>
          <DialogDescription>{subtitle}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5 sm:col-span-1">
              <Label required>
                {t("contents.generateSessionsStart", { defaultValue: "Fecha de inicio" })}
                <HelpHint>
                  {t("contents.generateSessionsStartHint", {
                    defaultValue:
                      "Desde esta fecha se calcula la primera sesión cuyo día coincida con los días seleccionados.",
                  })}
                </HelpHint>
              </Label>
              <DatePicker value={startDate} onChange={setStartDate} />
            </div>
            <div className="space-y-1.5 sm:col-span-1">
              <Label required>
                {t("contents.generateSessionsDays", { defaultValue: "Días de la semana" })}
                <HelpHint>
                  {t("contents.generateSessionsDaysHint", {
                    defaultValue:
                      "Días en que se programan las sesiones. En el tablero se prefijan desde el horario del curso.",
                  })}
                </HelpHint>
              </Label>
              <div className="flex flex-wrap gap-1">
                {WEEKDAYS_ES.map((d) => {
                  const checked = days.has(d.idx);
                  return (
                    <button
                      key={d.idx}
                      type="button"
                      onClick={() => toggleDay(d.idx)}
                      className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
                        checked
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border hover:bg-muted/40"
                      }`}
                      title={d.long}
                    >
                      {d.short}
                    </button>
                  );
                })}
              </div>
              {!content && schedules.length > 0 && (
                <p className="text-[10px] text-muted-foreground">
                  {t("contents.generateSessionsFromSchedule", {
                    defaultValue: "Días y horarios tomados del horario del curso.",
                  })}
                </p>
              )}
            </div>
            {!content && (
              <div className="space-y-1.5 sm:col-span-1">
                <Label required>
                  {t("contents.generateSessionsCount", { defaultValue: "Cantidad de sesiones" })}
                  <HelpHint>{t("help.sessionCountHint")}</HelpHint>
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={sessionCountInput}
                  onChange={(e) =>
                    setSessionCountInput(Math.max(1, Math.min(60, Number(e.target.value) || 1)))
                  }
                />
              </div>
            )}
          </div>

          {/* Política de festivos (solo modo tablero). */}
          {!content && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                {t("contents.generateSessionsHolidays", { defaultValue: "Festivos de Colombia" })}
                <HelpHint>
                  {t("contents.generateSessionsHolidaysHint", {
                    defaultValue:
                      "Qué hacer con las fechas que caen en festivo colombiano: omitirlas (y agregar más al final para llegar a la cantidad), moverlas al siguiente día hábil, o dejarlas.",
                  })}
                </HelpHint>
              </Label>
              <div className="flex flex-wrap gap-3 text-[11px]">
                {HOLIDAY_POLICIES.map((p) => (
                  <label key={p.value} className="flex items-center gap-1 cursor-pointer">
                    <input
                      type="radio"
                      name="holiday-policy"
                      checked={holidayPolicy === p.value}
                      onChange={() => setHolidayPolicy(p.value)}
                    />
                    <span>{p.label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Vista previa. Modo tablero: EDITABLE por fila. Modo contenido: read-only. */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t("contents.generateSessionsPreview", { defaultValue: "Vista previa de fechas" })}
            </Label>

            {!content ? (
              rows.length === 0 ? (
                <div className="rounded-md border bg-muted/30 p-3 text-[11px] text-muted-foreground">
                  {t("contents.generateSessionsPreviewEmpty", {
                    defaultValue: "Selecciona fecha y días para ver las sesiones.",
                  })}
                </div>
              ) : (
                <div className="rounded-md border max-h-[260px] overflow-y-auto divide-y">
                  {rows.map((r) => (
                    <div key={r.key} className="flex items-center gap-2 px-2 py-1.5">
                      <div className="w-32 shrink-0">
                        <DatePicker
                          value={r.iso}
                          onChange={(v) =>
                            updateRow(r.key, {
                              iso: v,
                              isHoliday: isCoHoliday(v),
                              holidayName: coHolidayName(v),
                            })
                          }
                        />
                      </div>
                      <Input
                        className="h-8 flex-1 text-[11px]"
                        value={r.title}
                        onChange={(e) => updateRow(r.key, { title: e.target.value })}
                        placeholder={t("contents.generateSessionsTitlePh", { defaultValue: "Título" })}
                      />
                      <Input
                        type="time"
                        className="h-8 w-[92px] text-[11px]"
                        value={r.startTime ?? ""}
                        onChange={(e) => updateRow(r.key, { startTime: e.target.value || null })}
                      />
                      <Input
                        type="number"
                        min={15}
                        max={480}
                        className="h-8 w-16 text-[11px]"
                        value={r.durationMin ?? ""}
                        placeholder="min"
                        onChange={(e) =>
                          updateRow(r.key, {
                            durationMin: e.target.value
                              ? Math.min(480, Math.max(15, Number(e.target.value)))
                              : null,
                          })
                        }
                      />
                      {r.isHoliday && (
                        <span
                          className="text-[10px] text-amber-600 dark:text-amber-400 whitespace-nowrap"
                          title={r.holidayName ?? undefined}
                        >
                          ⚠ {t("contents.generateSessionsHolidayBadge", { defaultValue: "Festivo" })}
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeRow(r.key)}
                        className="text-muted-foreground hover:text-destructive shrink-0 p-1"
                        title={t("common.remove", { defaultValue: "Quitar" })}
                        aria-label={t("common.remove", { defaultValue: "Quitar" })}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )
            ) : previewDates.length === 0 ? (
              <div className="rounded-md border bg-muted/30 p-3 text-[11px] text-muted-foreground">
                {t("contents.generateSessionsPreviewEmpty", {
                  defaultValue: "Selecciona fecha y días para ver las sesiones.",
                })}
              </div>
            ) : (
              <div className="rounded-md border max-h-[200px] overflow-y-auto divide-y">
                {previewDates.map((d, i) => {
                  const cls = isCursoCompleto ? (classNumbers[i] ?? null) : null;
                  const extracted = cls != null ? extractClassTitle(content.files, cls) : null;
                  const dayShort = WEEKDAYS_ES.find((x) => x.idx === d.getDay())?.short ?? "";
                  const titleLabel =
                    cls != null ? `Clase ${cls}` : (content.display_name ?? content.topic);
                  return (
                    <div key={i} className="flex items-center gap-3 px-3 py-1.5 text-[11px]">
                      <span className="tabular-nums text-foreground/80 w-32 shrink-0">
                        {toLocalIsoDate(d)} ({dayShort})
                      </span>
                      <span className="font-medium">{titleLabel}</span>
                      {extracted && (
                        <span className="text-muted-foreground truncate">— {extracted}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Conflict prompt (solo modo contenido con sesiones existentes). */}
          {content && existingSessions.length > 0 && (
            <div className="rounded-md border border-amber-300 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30 p-3 space-y-2">
              <div className="text-[11px] font-medium text-amber-700 dark:text-amber-300">
                {t("contents.generateSessionsConflictTitle", {
                  count: existingSessions.length,
                  defaultValue: `El curso ya tiene ${existingSessions.length} sesión(es) programadas.`,
                })}
              </div>
              <div className="space-y-1.5">
                <label className="flex items-start gap-2 text-[11px] cursor-pointer">
                  <input
                    type="radio"
                    name="conflict-mode"
                    checked={conflictMode === "reuse"}
                    onChange={() => setConflictMode("reuse")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      {t("contents.generateSessionsReuseLabel", { defaultValue: "Reusar las existentes" })}
                    </span>
                    <span className="block text-muted-foreground">
                      {t("contents.generateSessionsReuseHint", {
                        count: sessionCount,
                        defaultValue: `Asigna el contenido a las primeras ${sessionCount} sesión(es) sin crear duplicados.`,
                      })}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-2 text-[11px] cursor-pointer">
                  <input
                    type="radio"
                    name="conflict-mode"
                    checked={conflictMode === "create"}
                    onChange={() => setConflictMode("create")}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="font-medium">
                      {t("contents.generateSessionsCreateLabel", { defaultValue: "Crear nuevas" })}
                    </span>
                    <span className="block text-muted-foreground">
                      {t("contents.generateSessionsCreateHint", {
                        defaultValue:
                          "Agrega sesiones nuevas en las fechas calculadas (las existentes se mantienen).",
                      })}
                    </span>
                  </span>
                </label>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button onClick={submit} disabled={saving || !effectiveCourseId || !canSubmit}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <CalendarPlus className="h-4 w-4 mr-1" />
            )}
            {saving
              ? t("contents.generateSessionsSaving", { defaultValue: "Guardando..." })
              : content && conflictMode === "reuse" && existingSessions.length > 0
                ? t("contents.generateSessionsReuseSubmit", { defaultValue: "Reusar y asignar" })
                : t("contents.generateSessionsCreateSubmit", { defaultValue: "Crear sesiones" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

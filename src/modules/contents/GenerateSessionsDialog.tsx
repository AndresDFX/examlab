/**
 * GenerateSessionsDialog — programa N sesiones de asistencia para un
 * curso a partir de fecha inicio + días de semana.
 *
 * Dos modos de uso:
 *   1. **Desde un contenido generado** (Módulo Contenidos): recibe el
 *      `content` y reusa los datos detectados (clases, títulos). Cada
 *      sesión queda asociada al contenido (`content_id`) + clase
 *      correspondiente (`content_class_index`).
 *
 *   2. **Desde el Tablero de Asistencia**: el docente quiere agendar N
 *      sesiones del curso sin contenido pre-existente. `content` viene
 *      null, `courseId` viene del selector de curso del tablero, y el
 *      docente edita `sessionCount` manualmente. Las sesiones quedan
 *      sin `content_id` (el docente puede asignar contenido después
 *      desde el mismo tablero).
 *
 * Si hay sesiones existentes en el curso, ofrecemos:
 *   - **Reusar** (default cuando hay content) — asigna `content_id` a
 *     las primeras N existentes. Solo disponible en modo 1.
 *   - **Crear** — agrega N nuevas con las fechas calculadas.
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
import { CalendarPlus } from "lucide-react";
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
  // Default: Lun + Mié (patrón común universitario). El docente edita.
  const [days, setDays] = useState<Set<number>>(new Set([1, 3]));
  const [conflictMode, setConflictMode] = useState<"reuse" | "create">("reuse");
  const [existingSessions, setExistingSessions] = useState<ExistingSessionRow[]>([]);
  const [saving, setSaving] = useState(false);
  /** Solo se usa en modo "vacías" (content null). Cuando hay content, N
   *  viene del propio contenido y el input se oculta. */
  const [sessionCountInput, setSessionCountInput] = useState<number>(defaultSessionCount);

  const effectiveCourseId = content?.course_id ?? courseId ?? "";

  const classNumbers = useMemo(
    () => (content ? availableClassNumbers(content.files ?? []) : []),
    [content],
  );
  const isCursoCompleto = content?.mode === "curso_completo";

  // Cuántas sesiones se crean. Cuando hay content: derivado del contenido
  // (no editable). Cuando NO: el input editable.
  const sessionCount = content
    ? isCursoCompleto
      ? Math.max(classNumbers.length, 1)
      : 1
    : Math.max(1, sessionCountInput);

  // Carga sesiones existentes del curso al abrir, para mostrar el
  // conflict-prompt. Se re-ejecuta al cambiar contenido o curso.
  useEffect(() => {
    if (!open || !effectiveCourseId) {
      setExistingSessions([]);
      return;
    }
    setStartDate(toLocalIsoDate(new Date()));
    if (!content) {
      // Reset N al abrir en modo vacío para no arrastrar valor previo.
      setSessionCountInput(defaultSessionCount);
    }
    // En modo vacío forzamos "create" — no hay content_id que reusar.
    if (!content) setConflictMode("create");
    void (async () => {
      const { data } = await db
        .from("attendance_sessions")
        .select("id, session_date, title, content_id")
        .eq("course_id", effectiveCourseId)
        .order("session_date", { ascending: true });
      setExistingSessions((data ?? []) as ExistingSessionRow[]);
    })();
    // defaultSessionCount intencional fuera del array — solo importa al abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, effectiveCourseId, content?.id]);

  if (!open) return null;

  const previewDates = startDate
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
    if (previewDates.length < sessionCount) {
      toast.error(t("contents.generateSessionsErrCount", { defaultValue: "No se pudieron calcular suficientes fechas." }));
      return;
    }
    setSaving(true);
    try {
      // RAMA "REUSAR": solo aplica si hay content + sesiones existentes.
      // Asigna content+class_index a las primeras N existentes (orden
      // cronológico). No tocamos session_date.
      if (content && conflictMode === "reuse" && existingSessions.length > 0) {
        const target = existingSessions.slice(0, sessionCount);
        for (let i = 0; i < target.length; i++) {
          const cls = isCursoCompleto ? (classNumbers[i] ?? null) : null;
          const { error } = await db
            .from("attendance_sessions")
            .update({
              content_id: content.id,
              content_class_index: cls ?? 0,
            })
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

      // RAMA "CREAR": insert N sesiones nuevas. Si hay content, asigna
      // content_id + class_index. Si no, queda solo el shell de sesión.
      const files = content?.files ?? [];
      const rows = previewDates.map((d, i) => {
        const cls = isCursoCompleto ? (classNumbers[i] ?? null) : null;
        const extracted =
          content && cls != null ? extractClassTitle(files, cls) : null;
        const title = content
          ? (extracted ?? (cls != null ? `Clase ${cls}` : content.topic))
          : `Sesión ${i + 1}`;
        const base: Record<string, unknown> = {
          course_id: effectiveCourseId,
          session_date: toLocalIsoDate(d),
          title,
          created_by: user.id,
        };
        if (content) {
          base.content_id = content.id;
          base.content_class_index = cls ?? 0;
        }
        return base;
      });
      const { error } = await db.from("attendance_sessions").insert(rows);
      if (error) throw new Error(error.message);
      toast.success(
        t("contents.generateSessionsCreatedToast", {
          count: rows.length,
          defaultValue: `${rows.length} sesión(es) creadas`,
        }),
      );
      onCreated();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  };

  // Subtítulo del dialog según modo.
  const subtitle = content
    ? t("contents.generateSessionsSubtitle", {
        count: sessionCount,
        defaultValue: `Se programarán ${sessionCount} sesión(es) para este contenido.`,
      })
    : `Se programarán ${sessionCount} sesión(es) del curso, sin contenido asociado. Podrás asignarles contenido luego desde el mismo tablero.`;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl" hideCloseButton>
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
                {t("contents.generateSessionsDays", { defaultValue: "Días" })}
                <HelpHint>
                  {t("contents.generateSessionsDaysHint", {
                    defaultValue:
                      "Días de la semana en que se programan las sesiones. Combina varios para cursos con 2-3 sesiones/semana.",
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
            </div>
            {/* Input cantidad de sesiones — solo en modo "vacías". */}
            {!content && (
              <div className="space-y-1.5 sm:col-span-1">
                <Label required>
                  Cantidad de sesiones
                  <HelpHint>
                    Número de sesiones a programar. En modo "con contenido" este número se
                    deriva automáticamente de las clases del contenido.
                  </HelpHint>
                </Label>
                <Input
                  type="number"
                  min={1}
                  max={60}
                  value={sessionCountInput}
                  onChange={(e) =>
                    setSessionCountInput(
                      Math.max(1, Math.min(60, Number(e.target.value) || 1)),
                    )
                  }
                />
              </div>
            )}
          </div>

          {/* Vista previa: lista de fechas calculadas con título extraído. */}
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              {t("contents.generateSessionsPreview", { defaultValue: "Vista previa" })}
            </Label>
            {previewDates.length === 0 ? (
              <div className="rounded-md border bg-muted/30 p-3 text-[11px] text-muted-foreground">
                {t("contents.generateSessionsPreviewEmpty", {
                  defaultValue: "Selecciona fecha y días para ver las sesiones.",
                })}
              </div>
            ) : (
              <div className="rounded-md border max-h-[200px] overflow-y-auto divide-y">
                {previewDates.map((d, i) => {
                  const cls = content && isCursoCompleto ? (classNumbers[i] ?? null) : null;
                  const extracted =
                    content && cls != null ? extractClassTitle(content.files, cls) : null;
                  const dayShort = WEEKDAYS_ES.find((x) => x.idx === d.getDay())?.short ?? "";
                  const titleLabel = content
                    ? cls != null
                      ? `Clase ${cls}`
                      : (content.display_name ?? content.topic)
                    : `Sesión ${i + 1}`;
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

          {/* Conflict prompt: si el curso ya tiene sesiones y HAY content,
              ofrecemos reusar las primeras N o crear nuevas. Default
              "reuse" para evitar duplicar. En modo vacío, NO mostramos —
              siempre creamos nuevas. */}
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
                      {t("contents.generateSessionsReuseLabel", {
                        defaultValue: "Reusar las existentes",
                      })}
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
                      {t("contents.generateSessionsCreateLabel", {
                        defaultValue: "Crear nuevas",
                      })}
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
          <Button
            onClick={submit}
            disabled={
              saving ||
              !effectiveCourseId ||
              !startDate ||
              days.size === 0 ||
              previewDates.length < sessionCount
            }
          >
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <CalendarPlus className="h-4 w-4 mr-1" />
            )}
            {saving
              ? t("contents.generateSessionsSaving", { defaultValue: "Guardando..." })
              : content && conflictMode === "reuse" && existingSessions.length > 0
                ? t("contents.generateSessionsReuseSubmit", {
                    defaultValue: "Reusar y asignar",
                  })
                : t("contents.generateSessionsCreateSubmit", {
                    defaultValue: "Crear sesiones",
                  })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

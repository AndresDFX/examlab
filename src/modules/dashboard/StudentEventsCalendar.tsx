/**
 * StudentEventsCalendar — vista de mes con dots por tipo de evento.
 *
 * Vive en el dashboard del estudiante (reemplazó al widget "Mi semana"
 * del listado de cursos). Muestra un calendario mensual donde cada día
 * tiene 1-N círculos de color indicando qué tipos de eventos hay ese
 * día. La leyenda traduce los colores a tipos (Examen, Taller, etc.).
 *
 * Tipos de evento mostrados:
 *   - inicio_curso  → cyan      (courses.start_date donde estoy matriculado)
 *   - fin_curso     → orange    (courses.end_date)
 *   - clase         → sky       (attendance_sessions.session_date)
 *   - examen        → violet    (exam_assignments → exams.start_time)
 *   - taller        → amber     (workshop_assignments → workshops.due_date)
 *   - proyecto      → rose      (project_assignments → projects.due_date)
 *
 * Cap visual: hasta 3 dots por día. Si hay más, el 3er dot es un "+N"
 * con tooltip de los tipos restantes. Click en un día abre una popover
 * con la lista completa de eventos de ese día (título + curso + tipo).
 *
 * Datos: una sola pasada de queries en paralelo al mount. No usa polling
 * realtime — el calendario es informativo, las acciones (entregar/tomar
 * examen) viven en sus módulos dedicados.
 */
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileText,
  Hammer,
  FolderKanban,
  CalendarCheck,
  Flag,
  CheckCircle2,
  Lock,
} from "lucide-react";
import { formatDate } from "@/shared/lib/format";
import { cn } from "@/shared/lib/utils";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type EventKind =
  | "inicio_curso"
  | "fin_curso"
  | "clase"
  | "examen"
  | "taller"
  | "proyecto"
  | "cierre";

interface CalendarEvent {
  id: string;
  /** YYYY-MM-DD — clave del bucket por día. */
  date: string;
  kind: EventKind;
  title: string;
  course_name: string | null;
  /** Ruta interna para navegar al recurso. Null si no aplica. */
  href: string | null;
}

// Mapping kind → meta visual estática (color + ícono). Los labels se
// resuelven desde i18n dentro del componente para soportar es/en.
// Colores derivados de Tailwind: usamos clases utility para que respeten
// dark mode automáticamente sin meter hex hardcodeados.
const KIND_META_STATIC: Record<
  EventKind,
  { dotClass: string; icon: typeof Flag; legendClass: string; defaultLabel: string }
> = {
  inicio_curso: {
    dotClass: "bg-cyan-500",
    legendClass: "text-cyan-600 dark:text-cyan-400",
    icon: Flag,
    defaultLabel: "Inicio de curso",
  },
  fin_curso: {
    dotClass: "bg-orange-500",
    legendClass: "text-orange-600 dark:text-orange-400",
    icon: CheckCircle2,
    defaultLabel: "Fin de curso",
  },
  clase: {
    dotClass: "bg-sky-500",
    legendClass: "text-sky-600 dark:text-sky-400",
    icon: CalendarCheck,
    defaultLabel: "Clase",
  },
  examen: {
    dotClass: "bg-violet-500",
    legendClass: "text-violet-600 dark:text-violet-400",
    icon: FileText,
    defaultLabel: "Examen",
  },
  taller: {
    dotClass: "bg-amber-500",
    legendClass: "text-amber-600 dark:text-amber-400",
    icon: Hammer,
    defaultLabel: "Taller",
  },
  proyecto: {
    dotClass: "bg-rose-500",
    legendClass: "text-rose-600 dark:text-rose-400",
    icon: FolderKanban,
    defaultLabel: "Proyecto",
  },
  // Cierre de corte (grade_cuts.end_date) — solo en modo docente. Color
  // rojo intenso + candado: marca el límite de cierre del corte.
  cierre: {
    dotClass: "bg-red-600",
    legendClass: "text-red-700 dark:text-red-400",
    icon: Lock,
    defaultLabel: "Cierre de corte",
  },
};

const MONTH_NAMES_FALLBACK_ES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];
const MONTH_KEYS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;
const WEEKDAY_NAMES_FALLBACK_ES_SHORT = ["L", "M", "M", "J", "V", "S", "D"];

/** Helper: extrae YYYY-MM-DD de un ISO timestamp respetando zona LOCAL
 *  del navegador. Si usás `toISOString().slice(0,10)` un evento de las
 *  23:00 local (Bogotá) en martes te sale como miércoles UTC. */
function isoToLocalDateKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Devuelve YYYY-MM-DD de un Date local (sin tocar TZ). */
function dateToLocalKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function StudentEventsCalendar({
  userId,
  className,
  mode = "student",
}: {
  userId: string | undefined;
  /** Permite que el dashboard estire el calendario para que llene su
   *  columna (h-full flex flex-col) y se alinee con la agenda al lado. */
  className?: string;
  /** "student" (default): eventos de los cursos en que el usuario está
   *  matriculado, vía sus asignaciones. "teacher": eventos de TODOS los
   *  cursos que el docente dicta (course_teachers), por curso, + los
   *  cierres de corte (grade_cuts.end_date). Mismo UI/calendario. */
  mode?: "student" | "teacher";
}) {
  const { t } = useTranslation();
  // Labels traducidos derivados de la metadata estática + i18n.
  const KIND_META = useMemo(() => {
    const out: Record<
      EventKind,
      { label: string; dotClass: string; icon: typeof Flag; legendClass: string }
    > = {} as Record<
      EventKind,
      { label: string; dotClass: string; icon: typeof Flag; legendClass: string }
    >;
    (Object.keys(KIND_META_STATIC) as EventKind[]).forEach((k) => {
      const meta = KIND_META_STATIC[k];
      out[k] = {
        label: t(`studentCalendar.kinds.${k}`, { defaultValue: meta.defaultLabel }),
        dotClass: meta.dotClass,
        legendClass: meta.legendClass,
        icon: meta.icon,
      };
    });
    return out;
  }, [t]);
  const MONTH_NAMES = useMemo(
    () =>
      MONTH_KEYS.map((k, i) =>
        t(`studentCalendar.monthLabels.${k}`, { defaultValue: MONTH_NAMES_FALLBACK_ES[i] }),
      ),
    [t],
  );
  const WEEKDAY_NAMES_SHORT = useMemo(() => {
    const raw = t("studentCalendar.weekdaysShort", {
      returnObjects: true,
      defaultValue: WEEKDAY_NAMES_FALLBACK_ES_SHORT,
    });
    return Array.isArray(raw) ? (raw as string[]) : WEEKDAY_NAMES_FALLBACK_ES_SHORT;
  }, [t]);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  // Mes actualmente visible (1er día del mes en hora local).
  const today = new Date();
  const [viewYear, setViewYear] = useState<number>(today.getFullYear());
  const [viewMonth, setViewMonth] = useState<number>(today.getMonth()); // 0-indexed

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const isTeacher = mode === "teacher";
        const role = isTeacher ? "teacher" : "student";

        // 1) Cursos base: docente → los que dicta (course_teachers);
        //    estudiante → en los que está matriculado (course_enrollments).
        const { data: courseLink } = isTeacher
          ? await db.from("course_teachers").select("course_id").eq("user_id", userId)
          : await db.from("course_enrollments").select("course_id").eq("user_id", userId);
        const courseIds = ((courseLink ?? []) as Array<{ course_id: string }>).map(
          (r) => r.course_id,
        );
        if (courseIds.length === 0) {
          if (!cancelled) {
            setEvents([]);
            setLoading(false);
          }
          return;
        }

        // 2) Datos en paralelo. En modo docente los exámenes/talleres se
        //    traen POR CURSO (el docente ve TODO lo de sus cursos, no
        //    "asignaciones"); en modo estudiante, por asignación al usuario.
        //    Proyectos: project_courses sirve a ambos (+ project_assignments
        //    solo para el alumno). Sesiones: por curso en ambos. Los cierres
        //    (grade_cuts.end_date) solo aplican al docente.
        const [
          coursesRes,
          sessionsRes,
          examItemsRes,
          workshopItemsRes,
          projectCoursesRes,
          projectAsgRes,
          cutsRes,
        ] = await Promise.all([
          db
            .from("courses")
            .select("id, name, start_date, end_date")
            .in("id", courseIds)
            .is("deleted_at", null),
          db
            .from("attendance_sessions")
            .select("id, title, session_date, course:courses(id, name)")
            .in("course_id", courseIds)
            .is("deleted_at", null),
          isTeacher
            ? db
                .from("exams")
                .select("id, title, start_time, status, deleted_at, course:courses(name)")
                .in("course_id", courseIds)
            : db
                .from("exam_assignments")
                .select(
                  "exam:exams(id, title, start_time, status, deleted_at, course:courses(name))",
                )
                .eq("user_id", userId),
          isTeacher
            ? db
                .from("workshops")
                .select("id, title, due_date, status, deleted_at, course:courses(name)")
                .in("course_id", courseIds)
            : db
                .from("workshop_assignments")
                .select(
                  "workshop:workshops(id, title, due_date, status, deleted_at, course:courses(name))",
                )
                .eq("user_id", userId),
          db
            .from("project_courses")
            .select(
              "project:projects(id, title, due_date, status, deleted_at, course:courses(name))",
            )
            .in("course_id", courseIds),
          isTeacher
            ? Promise.resolve({ data: [] as unknown[] })
            : db
                .from("project_assignments")
                .select(
                  "project:projects(id, title, due_date, status, deleted_at, course:courses(name))",
                )
                .eq("user_id", userId),
          isTeacher
            ? db
                .from("grade_cuts")
                .select("id, name, end_date, course:courses(name)")
                .in("course_id", courseIds)
            : Promise.resolve({ data: [] as unknown[] }),
        ]);

        // Normalización exámenes/talleres: docente trae la fila directa;
        // alumno trae un wrapper { exam } / { workshop } de la asignación.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const examItems: any[] = isTeacher
          ? ((examItemsRes.data ?? []) as any[])
          : ((examItemsRes.data ?? []) as any[]).map((a) => a.exam);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const workshopItems: any[] = isTeacher
          ? ((workshopItemsRes.data ?? []) as any[])
          : ((workshopItemsRes.data ?? []) as any[]).map((a) => a.workshop);

        const all: CalendarEvent[] = [];

        // Cursos: inicio + fin.
        for (const c of (coursesRes.data ?? []) as Array<{
          id: string;
          name: string;
          start_date: string | null;
          end_date: string | null;
        }>) {
          if (c.start_date) {
            all.push({
              id: `course-start-${c.id}`,
              date: c.start_date.slice(0, 10),
              kind: "inicio_curso",
              title: c.name,
              course_name: c.name,
              href: null,
            });
          }
          if (c.end_date) {
            all.push({
              id: `course-end-${c.id}`,
              date: c.end_date.slice(0, 10),
              kind: "fin_curso",
              title: c.name,
              course_name: c.name,
              href: null,
            });
          }
        }

        // Sesiones (clases).
        for (const s of (sessionsRes.data ?? []) as Array<{
          id: string;
          title: string | null;
          session_date: string;
          course: { id: string; name: string } | null;
        }>) {
          all.push({
            id: `session-${s.id}`,
            date: s.session_date.slice(0, 10),
            kind: "clase",
            title: s.title ?? "Clase",
            course_name: s.course?.name ?? null,
            href: isTeacher ? "/app/teacher/attendance" : null,
          });
        }

        // Exámenes. Filtramos a published; un examen draft/closed no es
        // accionable y descoloca verlo en el calendario.
        for (const ex of examItems as Array<{
          id: string;
          title: string;
          start_time: string;
          status: string | null;
          deleted_at: string | null;
          course: { name: string } | null;
        } | null>) {
          if (!ex) continue;
          if (ex.deleted_at) continue; // en papelera → no se muestra
          if ((ex.status ?? "published") !== "published") continue;
          const date = isoToLocalDateKey(ex.start_time);
          if (!date) continue;
          all.push({
            id: `exam-${ex.id}`,
            date,
            kind: "examen",
            title: ex.title,
            course_name: ex.course?.name ?? null,
            href: `/app/${role}/exams`,
          });
        }

        // Talleres — la "fecha del calendario" es el due_date (vencimiento).
        for (const w of workshopItems as Array<{
          id: string;
          title: string;
          due_date: string | null;
          status: string | null;
          deleted_at: string | null;
          course: { name: string } | null;
        } | null>) {
          if (!w) continue;
          if (w.deleted_at) continue; // en papelera → no se muestra
          if (w.status !== "published") continue;
          if (!w.due_date) continue;
          const date = isoToLocalDateKey(w.due_date);
          if (!date) continue;
          all.push({
            id: `workshop-${w.id}`,
            date,
            kind: "taller",
            title: w.title,
            course_name: w.course?.name ?? null,
            href: `/app/${role}/workshops`,
          });
        }

        // Proyectos — vienen por 2 caminos: project_assignments (alumno
        // asignado directo) y project_courses (proyecto enlazado al curso
        // donde está matriculado). Dedup por project_id usando un Set.
        const projectsSeen = new Set<string>();
        const collectProject = (p: {
          id: string;
          title: string;
          due_date: string | null;
          status: string | null;
          deleted_at: string | null;
          course: { name: string } | null;
        } | null) => {
          if (!p) return;
          if (p.deleted_at) return; // en papelera → no se muestra
          if (p.status !== "published") return;
          if (!p.due_date) return;
          if (projectsSeen.has(p.id)) return;
          projectsSeen.add(p.id);
          const date = isoToLocalDateKey(p.due_date);
          if (!date) return;
          all.push({
            id: `project-${p.id}`,
            date,
            kind: "proyecto",
            title: p.title,
            course_name: p.course?.name ?? null,
            href: `/app/${role}/projects`,
          });
        };
        for (const a of (projectAsgRes.data ?? []) as Array<{
          project: {
            id: string;
            title: string;
            due_date: string | null;
            status: string | null;
            deleted_at: string | null;
            course: { name: string } | null;
          } | null;
        }>) {
          collectProject(a.project);
        }
        for (const a of (projectCoursesRes.data ?? []) as Array<{
          project: {
            id: string;
            title: string;
            due_date: string | null;
            status: string | null;
            deleted_at: string | null;
            course: { name: string } | null;
          } | null;
        }>) {
          collectProject(a.project);
        }

        // Cierres de corte (solo docente): la fecha del calendario es el
        // end_date del corte (cuándo cierra la calificación de ese corte).
        for (const cut of (cutsRes.data ?? []) as Array<{
          id: string;
          name: string;
          end_date: string | null;
          course: { name: string } | null;
        }>) {
          if (!cut.end_date) continue;
          all.push({
            id: `cut-${cut.id}`,
            date: cut.end_date.slice(0, 10),
            kind: "cierre",
            title: cut.name,
            course_name: cut.course?.name ?? null,
            href: "/app/teacher/gradebook",
          });
        }

        if (!cancelled) setEvents(all);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, mode]);

  // Agrupa por date string para lookup O(1) al renderizar cada celda.
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const arr = m.get(e.date);
      if (arr) arr.push(e);
      else m.set(e.date, [e]);
    }
    return m;
  }, [events]);

  // Tipos únicos presentes en el mes visible — para mostrar la leyenda
  // SOLO de los tipos que de hecho aparecen (menos ruido visual).
  const visibleKinds = useMemo(() => {
    const monthStart = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-01`;
    // Último día del mes (formato YYYY-MM-DD).
    const lastDay = new Date(viewYear, viewMonth + 1, 0).getDate();
    const monthEnd = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    const set = new Set<EventKind>();
    for (const e of events) {
      if (e.date >= monthStart && e.date <= monthEnd) set.add(e.kind);
    }
    return set;
  }, [events, viewYear, viewMonth]);

  // Grid del mes — 6 filas × 7 cols. Empezamos en lunes (cultura es-CO
  // espera la semana lunes-domingo, no domingo-sábado como US).
  const monthGrid = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1);
    // JS: 0=domingo … 6=sábado. Convertimos a 0=lunes … 6=domingo.
    const offset = (firstDay.getDay() + 6) % 7;
    const cells: Array<{ date: Date; key: string; inMonth: boolean }> = [];
    // Llenamos con días del mes anterior para los primeros offset slots.
    for (let i = 0; i < offset; i++) {
      const d = new Date(viewYear, viewMonth, 1 - (offset - i));
      cells.push({ date: d, key: dateToLocalKey(d), inMonth: false });
    }
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) {
      const d = new Date(viewYear, viewMonth, i);
      cells.push({ date: d, key: dateToLocalKey(d), inMonth: true });
    }
    // Padding final hasta completar 6 filas × 7 (42 celdas) — algunos
    // meses caben en 5 filas, pero fijar 6 evita layout shift al navegar.
    while (cells.length < 42) {
      const last = cells[cells.length - 1].date;
      const d = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      cells.push({ date: d, key: dateToLocalKey(d), inMonth: false });
    }
    return cells;
  }, [viewYear, viewMonth]);

  const todayKey = dateToLocalKey(today);

  const goPrev = () => {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };
  const goNext = () => {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };
  const goToday = () => {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
  };
  const isCurrentMonth =
    viewYear === today.getFullYear() && viewMonth === today.getMonth();

  return (
    <Card className={cn(className)}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-primary" />
            {MONTH_NAMES[viewMonth]} {viewYear}
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={goPrev}
              aria-label={t("studentCalendar.nav.prevMonth", { defaultValue: "Mes anterior" })}
              className="h-8 w-8 p-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={goToday}
              className="h-7 px-2 text-xs"
              disabled={isCurrentMonth}
            >
              {t("studentCalendar.nav.today", { defaultValue: "Hoy" })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={goNext}
              aria-label={t("studentCalendar.nav.nextMonth", { defaultValue: "Mes siguiente" })}
              className="h-8 w-8 p-0"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      {/* min-h-0 + overflow-y-auto: cuando el dashboard estira el Card
          (h-full flex flex-col), el contenido del mes scrollea adentro en
          vez de empujar la página. En uso standalone (sin flex parent),
          flex-1 es no-op → altura natural, mismo comportamiento de antes. */}
      <CardContent className="space-y-3 flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Spinner size="md" />
          </div>
        ) : (
          <>
            {/* Header de días de la semana */}
            <div className="grid grid-cols-7 gap-1 text-[10px] uppercase font-medium text-muted-foreground tracking-wide">
              {WEEKDAY_NAMES_SHORT.map((w, i) => (
                <div key={i} className="text-center py-1">
                  {w}
                </div>
              ))}
            </div>
            {/* Grid de celdas */}
            <div className="grid grid-cols-7 gap-1">
              {monthGrid.map((cell) => {
                const dayEvents = byDate.get(cell.key) ?? [];
                const isToday = cell.key === todayKey;
                const hasEvents = dayEvents.length > 0;
                // Dots únicos por tipo (no repetimos color si hay 2
                // exámenes el mismo día — el segundo "+N" cubre el conteo).
                const uniqueKinds: EventKind[] = [];
                for (const e of dayEvents) {
                  if (!uniqueKinds.includes(e.kind)) uniqueKinds.push(e.kind);
                }
                const visibleDots = uniqueKinds.slice(0, 3);
                const extraKinds = uniqueKinds.slice(3);
                return (
                  <DayCell
                    key={cell.key}
                    dateNum={cell.date.getDate()}
                    inMonth={cell.inMonth}
                    isToday={isToday}
                    hasEvents={hasEvents}
                    events={dayEvents}
                    visibleDots={visibleDots}
                    extraKinds={extraKinds}
                    kindMeta={KIND_META}
                  />
                );
              })}
            </div>

            {/* Leyenda — solo los kinds que aparecen este mes. Si el
                mes está limpio, mostramos un hint. */}
            {visibleKinds.size > 0 ? (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-2 border-t text-[11px]">
                <span className="text-muted-foreground font-medium uppercase tracking-wide text-[10px]">
                  {t("studentCalendar.legend.label", { defaultValue: "Leyenda:" })}
                </span>
                {(Object.keys(KIND_META) as EventKind[])
                  .filter((k) => visibleKinds.has(k))
                  .map((k) => (
                    <div key={k} className="flex items-center gap-1.5">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${KIND_META[k].dotClass}`}
                      />
                      <span className={KIND_META[k].legendClass}>{KIND_META[k].label}</span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground italic pt-2 border-t">
                {t("studentCalendar.legend.empty", { defaultValue: "Sin eventos en este mes." })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Celda individual del calendario. Click abre popover con la lista
 *  detallada de eventos del día (cuando hay alguno). */
function DayCell({
  dateNum,
  inMonth,
  isToday,
  hasEvents,
  events,
  visibleDots,
  extraKinds,
  kindMeta,
}: {
  dateNum: number;
  inMonth: boolean;
  isToday: boolean;
  hasEvents: boolean;
  events: CalendarEvent[];
  visibleDots: EventKind[];
  extraKinds: EventKind[];
  kindMeta: Record<
    EventKind,
    { label: string; dotClass: string; icon: typeof Flag; legendClass: string }
  >;
}) {
  // NO usar `aspect-square`: en columnas anchas (dashboard a 1-col, o el
  // calendario full-width de /app/student/calendar) la celda cuadrada se
  // vuelve altísima y el mes deja de caber sin scroll. Una altura fija
  // modesta mantiene el calendario compacto sin importar el ancho.
  const cellClasses = [
    "relative min-h-[34px] sm:min-h-[40px] rounded-md border flex flex-col items-center justify-start p-1 transition-colors",
    inMonth ? "bg-card" : "bg-muted/20",
    isToday ? "ring-1 ring-primary border-primary/40" : "border-transparent",
    hasEvents
      ? "cursor-pointer hover:bg-accent"
      : "cursor-default",
  ].join(" ");

  const cellContent = (
    <>
      <span
        className={[
          "text-xs tabular-nums",
          inMonth ? "" : "text-muted-foreground/40",
          isToday ? "font-bold text-primary" : "",
        ].join(" ")}
      >
        {dateNum}
      </span>
      {visibleDots.length > 0 && (
        <div className="flex items-center gap-0.5 mt-auto pb-0.5">
          {visibleDots.map((k) => (
            <span
              key={k}
              className={`inline-block h-1.5 w-1.5 rounded-full ${kindMeta[k].dotClass}`}
              title={kindMeta[k].label}
            />
          ))}
          {extraKinds.length > 0 && (
            <span
              className="text-[8px] font-bold text-muted-foreground ml-0.5"
              title={extraKinds.map((k) => kindMeta[k].label).join(", ")}
            >
              +{extraKinds.length}
            </span>
          )}
        </div>
      )}
    </>
  );

  if (!hasEvents) {
    return <div className={cellClasses}>{cellContent}</div>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cellClasses}>
          {cellContent}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-72 p-3 space-y-2">
        <div className="text-xs font-medium text-muted-foreground">
          {formatDate(events[0].date)}
        </div>
        <ul className="space-y-1.5">
          {events.map((e) => {
            const meta = kindMeta[e.kind];
            const Icon = meta.icon;
            const inner = (
              <>
                <div className="flex items-start gap-2">
                  <span
                    className={`inline-block h-2 w-2 rounded-full ${meta.dotClass} mt-1.5 shrink-0`}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate flex items-center gap-1.5">
                      <Icon className={`h-3 w-3 shrink-0 ${meta.legendClass}`} />
                      <span className="truncate">{e.title}</span>
                    </div>
                    {e.course_name && (
                      <div className="text-[11px] text-muted-foreground truncate">
                        {e.course_name}
                      </div>
                    )}
                    <div className={`text-[10px] mt-0.5 ${meta.legendClass}`}>{meta.label}</div>
                  </div>
                </div>
              </>
            );
            return (
              <li
                key={e.id}
                className="rounded-md border px-2 py-1.5 hover:bg-accent transition-colors"
              >
                {e.href ? (
                  <Link to={e.href} className="block">
                    {inner}
                  </Link>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

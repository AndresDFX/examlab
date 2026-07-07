/**
 * Vista "Mi semana" — renderiza los bloques de horario agrupados por
 * día. Reusable: estudiante y docente comparten el mismo componente.
 *
 * Diseño de lista vs grid de calendario: elegimos LISTA porque:
 *  - Funciona en mobile sin scroll horizontal (un calendario 6×24
 *    en 375px es ilegible)
 *  - Bloques se muestran con todo el contexto (curso, aula,
 *    modalidad) sin necesidad de tooltip
 *  - Cargas livianas (≤ 30 bloques típicos por persona/semana)
 *
 * Carga: una sola query — `course_schedules` con embed de courses.
 * RLS limita automáticamente a los cursos del usuario (matriculados
 * para estudiante; asignados para docente).
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { CalendarClock, MapPin, Video } from "lucide-react";
import {
  DAY_LABELS,
  WEEK_ORDER,
  compareBlocks,
  trimTime,
  type CourseScheduleBlock,
  type DayOfWeek,
} from "./course-schedule";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface BlockWithCourse extends CourseScheduleBlock {
  course_id: string;
  course_name: string;
  course_grupo: string | null;
}

interface Props {
  /** Título de la card. Default: "Mi semana". */
  title?: string;
  /** Si true, el día actual se resalta con un borde acentuado. */
  highlightToday?: boolean;
}

export function WeeklyScheduleView({ title, highlightToday = true }: Props) {
  const { t } = useTranslation();
  const [blocks, setBlocks] = useState<BlockWithCourse[]>([]);
  const [loading, setLoading] = useState(true);
  const resolvedTitle =
    title ?? t("hc_modulesSchedulesWeeklyScheduleView.title", { defaultValue: "Mi semana" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      // RLS filtra automáticamente: el usuario solo ve horarios de
      // cursos donde está matriculado o es docente.
      const { data } = await db
        .from("course_schedules")
        .select(
          "id, day_of_week, start_time, end_time, aula, modalidad, course_id, course:courses(name, grupo)",
        );
      if (cancelled) return;
      const rows: BlockWithCourse[] = ((data ?? []) as Array<{
        id: string;
        day_of_week: DayOfWeek;
        start_time: string;
        end_time: string;
        aula: string | null;
        modalidad: "presencial" | "virtual" | "hibrida";
        course_id: string;
        course: { name: string; grupo: string | null } | null;
      }>).map((r) => ({
        id: r.id,
        day_of_week: r.day_of_week,
        start_time: r.start_time,
        end_time: r.end_time,
        aula: r.aula,
        modalidad: r.modalidad,
        notes: null,
        course_id: r.course_id,
        course_name: r.course?.name ?? "—",
        course_grupo: r.course?.grupo ?? null,
      }));
      setBlocks(rows);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Agrupar por día de la semana, respetando el orden lunes-primero.
  const byDay = useMemo(() => {
    const map = new Map<DayOfWeek, BlockWithCourse[]>();
    for (const b of blocks) {
      const list = map.get(b.day_of_week) ?? [];
      list.push(b);
      map.set(b.day_of_week, list);
    }
    for (const [, list] of map) list.sort(compareBlocks);
    return map;
  }, [blocks]);

  const today = new Date().getDay() as DayOfWeek;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-cyan-500" />
          {resolvedTitle}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> {t("common.loading")}
          </div>
        ) : blocks.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            text={t("hc_modulesSchedulesWeeklyScheduleView.emptyText", {
              defaultValue: "Sin horario configurado",
            })}
            hint={t("hc_modulesSchedulesWeeklyScheduleView.emptyHint", {
              defaultValue:
                "Cuando tus cursos tengan bloques semanales definidos, aparecerán aquí.",
            })}
          />
        ) : (
          <div className="space-y-3">
            {WEEK_ORDER.map((day) => {
              const dayBlocks = byDay.get(day);
              if (!dayBlocks || dayBlocks.length === 0) return null;
              const isToday = highlightToday && day === today;
              return (
                <div
                  key={day}
                  className={`rounded-md border ${
                    isToday ? "border-cyan-400 bg-cyan-50/40 dark:bg-cyan-500/5" : ""
                  }`}
                >
                  <div className="px-3 py-1.5 flex items-center justify-between border-b">
                    <span className="text-sm font-medium">{DAY_LABELS[day]}</span>
                    {isToday && (
                      <Badge variant="outline" className="text-[10px] border-cyan-400 text-cyan-700 dark:text-cyan-300">
                        {t("hc_modulesSchedulesWeeklyScheduleView.today", { defaultValue: "Hoy" })}
                      </Badge>
                    )}
                  </div>
                  <ul className="divide-y">
                    {dayBlocks.map((b) => (
                      <li key={b.id} className="px-3 py-2 flex items-start gap-3">
                        <div className="font-mono text-xs tabular-nums text-muted-foreground shrink-0 mt-0.5">
                          {trimTime(b.start_time)}
                          <br />
                          {trimTime(b.end_time)}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-medium truncate">
                            {b.course_name}
                            {b.course_grupo && (
                              <span className="text-xs text-muted-foreground ml-1.5 font-normal">
                                · {b.course_grupo}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2 mt-0.5 flex-wrap">
                            {b.modalidad === "virtual" ? (
                              <span className="inline-flex items-center gap-1">
                                <Video className="h-3 w-3" />{" "}
                                {t("hc_modulesSchedulesWeeklyScheduleView.modalityVirtual", {
                                  defaultValue: "Virtual",
                                })}
                              </span>
                            ) : b.modalidad === "hibrida" ? (
                              <span className="inline-flex items-center gap-1">
                                <Video className="h-3 w-3" />{" "}
                                {t("hc_modulesSchedulesWeeklyScheduleView.modalityHibrida", {
                                  defaultValue: "Híbrida",
                                })}
                              </span>
                            ) : null}
                            {b.aula?.trim() && (
                              <span className="inline-flex items-center gap-1">
                                <MapPin className="h-3 w-3" />
                                {b.aula}
                              </span>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

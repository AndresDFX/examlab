/**
 * Cuánto falta calificar por corte, sumando VARIOS cursos.
 *
 * Responde la pregunta del cierre de periodo: «del Corte 1, en todas mis
 * asignaturas, ¿qué porcentaje de notas falta?». La versión por curso vive en
 * la pantalla de Estadísticas; esta es la del modo «Todos los cursos».
 *
 * ── Por qué se agrupa por NOMBRE de corte ─────────────────────────────
 *
 * Cada curso tiene sus propias filas en `grade_cuts`: el «Corte 1» de Bases de
 * Datos y el de Seminario son registros distintos. La pregunta del docente los
 * trata como el mismo, así que se suman por nombre (ver `unirPorNombreDeCorte`).
 *
 * ── Por qué el porcentaje se recalcula y no se promedia ───────────────
 *
 * Un curso con 1 de 1 nota puesta y otro con 0 de 99 es 99% sin calificar, no
 * 50%. Promediar porcentajes de cursos de tamaños distintos da un número que
 * suena razonable y no significa nada.
 *
 * ── El costo, dicho de frente ─────────────────────────────────────────
 *
 * Carga el dataset completo de cada curso (unas 8 consultas cada uno) porque
 * reusa exactamente el mismo cálculo que la vista por curso, y eso garantiza
 * que los dos números coincidan. Por eso solo carga los cursos que el docente
 * tiene marcados, y no arranca solo: hay un botón.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ClipboardList } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { loadCourseDataset } from "@/shared/lib/statistics";
import { pendientesPorCorte, unirPorNombreDeCorte, type PendientesDeCorte } from "./sin-calificar";
import { DesgloseDeCorte } from "./DesgloseDeCorte";

export function SinCalificarAgregado({
  courses,
}: {
  courses: ReadonlyArray<{ id: string; name: string }>;
}) {
  const { t } = useTranslation();
  const [filas, setFilas] = useState<PendientesDeCorte[] | null>(null);
  const [cargando, setCargando] = useState(false);

  const calcular = async () => {
    if (cargando || courses.length === 0) return;
    setCargando(true);
    // `Date.now()` se toma UNA vez y se pasa a todos los cursos: si cada uno
    // leyera el suyo, dos cursos podrían quedar de distinto lado de la
    // medianoche y el mismo corte saldría «en curso» en uno y «cerrado» en
    // otro dentro de la misma tabla.
    const ahora = Date.now();
    try {
      const datasets = await Promise.all(courses.map((c) => loadCourseDataset(c.id)));
      const porCurso = datasets.map((ds) =>
        pendientesPorCorte(
          ds.cuts,
          ds.actividades,
          [...ds.examSubs, ...ds.workshopSubs, ...ds.projectSubs],
          new Set(ds.enrollments.map((e) => e.user_id)).size,
          ahora,
        ),
      );
      setFilas(unirPorNombreDeCorte(porCurso));
    } catch (e) {
      toast.error(friendlyError(e, t("statistics.ungradedError")));
    } finally {
      setCargando(false);
    }
  };

  const hayAlgo = (filas ?? []).some((f) => f.actividades > 0);

  return (
    <Card>
      <CardHeader className="p-4 pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <ClipboardList className="h-4 w-4 text-amber-500" />
          {t("statistics.ungradedTitle")}
        </CardTitle>
        <CardDescription>
          {t("statistics.ungradedAggDesc", { count: courses.length })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {filas === null ? (
          <Button size="sm" onClick={() => void calcular()} disabled={cargando || courses.length === 0}>
            {cargando && <Spinner size="sm" className="mr-1" />}
            {t("statistics.ungradedCompute")}
          </Button>
        ) : !hayAlgo ? (
          <p className="text-xs text-muted-foreground">{t("statistics.ungradedNoActivities")}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {(filas ?? []).map((f) => (
              <DesgloseDeCorte key={f.cutId} fila={f} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

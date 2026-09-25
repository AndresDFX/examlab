/**
 * La fila de UN corte en «Qué falta del corte»: barra apilada + desglose.
 *
 * Vive aparte porque la dibujan los DOS paneles —el de un curso, en
 * Estadísticas, y el agregado de «Todos los cursos»—, y antes cada uno tenía
 * su propia copia de la barra. Dos copias de la misma barra divergen, y el
 * modo de falla es que el mismo corte se vea distinto según desde dónde se
 * mire, sin que nada falle.
 *
 * ── Por qué una barra APILADA y no un porcentaje ──────────────────────
 *
 * «40,6% sin calificar» no dice qué hacer. Los cuatro segmentos sí: lo que
 * está por calificar es trabajo del docente, lo que está sin empezar es de los
 * estudiantes, y el ancho relativo de los dos decide a qué dedicarle la
 * semana. Es el mismo número, partido por quién tiene que actuar.
 *
 * ── Por qué un corte FUTURO no se pinta de rojo ───────────────────────
 *
 * El Corte 3 va del 27-oct al 20-nov y salía «100% sin calificar» a fines de
 * septiembre: cierto, y completamente inútil. Un panel que alarma por trabajo
 * que todavía no existe entrena al docente a ignorarlo, y entonces tampoco ve
 * la alarma del corte que sí está abierto. Un corte que no empezó se muestra
 * apagado y con su motivo escrito.
 */
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { PendientesDeCorte } from "./sin-calificar";

/** Los cuatro segmentos, en el orden en que se apilan: de hecho a no hecho. */
const SEGMENTOS = [
  { campo: "calificadas", clase: "bg-emerald-500", clave: "statistics.ungradedGraded" },
  { campo: "porCalificar", clase: "bg-amber-500", clave: "statistics.ungradedToGrade" },
  { campo: "enCurso", clase: "bg-sky-500", clave: "statistics.ungradedInProgress" },
  { campo: "sinEmpezar", clase: "bg-muted-foreground/40", clave: "statistics.ungradedNotStarted" },
] as const;

export function DesgloseDeCorte({ fila }: { fila: PendientesDeCorte }) {
  const { t } = useTranslation();
  const futuro = fila.estado === "futuro";
  // `esperadas === 0` cubre dos casos y los dos tienen que caer acá: un corte
  // sin actividades, y un curso con actividades pero SIN matriculados — ese
  // segundo divide por cero al repartir la barra y pinta anchos `NaN%`, que el
  // navegador ignora en silencio dejando la barra vacía sin ningún error.
  const vacio = fila.actividades === 0 || fila.esperadas === 0;

  const etiquetaEstado =
    fila.estado === "futuro"
      ? t("statistics.ungradedCutFuture")
      : fila.estado === "terminado"
        ? t("statistics.ungradedCutDone")
        : fila.estado === "en_curso"
          ? t("statistics.ungradedCutOpen")
          : null;

  return (
    <div className={`flex flex-col gap-1.5 ${futuro ? "opacity-60" : ""}`}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium truncate">{fila.cutName}</span>
          {etiquetaEstado && (
            <Badge variant="secondary" className="text-3xs shrink-0 font-normal">
              {etiquetaEstado}
            </Badge>
          )}
        </div>
        <span className="tabular-nums shrink-0 text-muted-foreground">
          {t("statistics.ungradedActivities", { count: fila.actividades })}
        </span>
      </div>

      {vacio ? (
        // Se distingue cuál de los dos vacíos es: decir «sin actividades
        // publicadas» sobre un curso que SÍ las tiene y lo que le faltan son
        // estudiantes manda al docente a revisar lo que no está roto.
        <p className="text-2xs text-muted-foreground">
          {fila.actividades === 0
            ? t("statistics.ungradedCutEmpty")
            : t("statistics.ungradedNoStudents")}
        </p>
      ) : (
        <>
          <TooltipProvider>
            <div className="flex h-2.5 w-full rounded-full bg-muted overflow-hidden">
              {SEGMENTOS.map((s) => {
                const n = fila[s.campo];
                if (n <= 0) return null;
                const pct = (n / fila.esperadas) * 100;
                return (
                  <Tooltip key={s.campo}>
                    <TooltipTrigger asChild>
                      <div className={s.clase} style={{ width: `${pct}%` }} />
                    </TooltipTrigger>
                    <TooltipContent>
                      {t(s.clave)}: {n} ({Math.round(pct * 10) / 10}%)
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>

          {/* La leyenda repite los números en texto: el tooltip no existe en un
              teléfono, y este panel se mira desde el teléfono. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-muted-foreground">
            {SEGMENTOS.map((s) => {
              const n = fila[s.campo];
              if (n <= 0) return null;
              return (
                <span key={s.campo} className="inline-flex items-center gap-1">
                  <span className={`h-2 w-2 rounded-full shrink-0 ${s.clase}`} />
                  <span className="tabular-nums">
                    {n} {t(s.clave).toLowerCase()}
                  </span>
                </span>
              );
            })}
          </div>

          {futuro ? (
            <p className="text-2xs text-muted-foreground">{t("statistics.ungradedFutureHint")}</p>
          ) : (
            (fila.porCalificar > 0 || fila.estudiantesSinEmpezarNada > 0) && (
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-2xs">
                {fila.porCalificar > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {t("statistics.ungradedYourTurn")}: {fila.porCalificar}
                  </span>
                )}
                {fila.estudiantesSinEmpezarNada > 0 && (
                  <span className="text-muted-foreground">
                    {t("statistics.ungradedNoneStarted", {
                      count: fila.estudiantesSinEmpezarNada,
                    })}
                  </span>
                )}
              </div>
            )
          )}
        </>
      )}
    </div>
  );
}

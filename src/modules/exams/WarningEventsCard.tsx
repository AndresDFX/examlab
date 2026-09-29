/**
 * Tarjeta de advertencias de un intento de examen: la lista de eventos con su
 * hora, el botón de borrarlas todas y uno por evento.
 *
 * Vive acá y no inline en el monitor porque se monta en DOS sitios: dentro del
 * diálogo de «ver y calificar» (intentos finalizados, que es donde estaba) y en
 * el diálogo de advertencias que se abre con el examen EN CURSO. Escribirla dos
 * veces garantizaba que el día que se toque una, la otra quede distinta — el
 * mismo problema que este archivo ya documenta para el set de «estado final».
 */
import { AlertTriangle, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RowAction } from "@/components/ui/row-action";
import { formatDateTime } from "@/shared/lib/format";
import {
  warningLabel,
  warningEventTimestamp,
  eventoSumoStrike,
  type WarningEvent,
} from "@/modules/exams/proctoring";
import { Badge } from "@/components/ui/badge";

export function WarningEventsCard({
  events,
  onClearAll,
  onClearOne,
  questions,
  cleared,
}: {
  events: WarningEvent[];
  onClearAll: () => void;
  onClearOne: (idx: number) => void;
  /** Las preguntas EN EL ORDEN DEL DOCENTE, para ubicar cada evento. Sin esto
   *  la lista dice qué pasó y no dónde — que en un «Intento de pegar» es la
   *  mitad del dato. */
  questions?: ReadonlyArray<{ id: string }>;
  /** Advertencias que ya se perdonaron. Antes desaparecían sin dejar rastro. */
  cleared?: WarningEvent[];
}) {
  const { t } = useTranslation();

  /**
   * Dónde ocurrió el evento, por ID.
   *
   * Se prefiere el ID sobre el índice porque con la mezcla activada el orden es
   * distinto para cada alumno: su «Pregunta 4» no es la 4 del docente. El
   * índice queda de respaldo para los eventos viejos, que no traen ID.
   */
  const ubicacion = (ev: WarningEvent): number | null => {
    if (ev.questionId && questions?.length) {
      const i = questions.findIndex((q) => q.id === ev.questionId);
      if (i >= 0) return i;
    }
    return typeof ev.questionIdx === "number" ? ev.questionIdx : null;
  };

  if (!events.length && !cleared?.length) return null;
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center justify-between gap-2">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            {t("hc_routesAppTeacherMonitorExamId.warningEventsTitle", { count: events.length })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!events.length}
            onClick={onClearAll}
            title={t("hc_routesAppTeacherMonitorExamId.clearAllWarningsTitle")}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            {t("hc_routesAppTeacherMonitorExamId.clearAll")}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs space-y-1">
        {events.map((ev, i) => {
          const dondeFue = ubicacion(ev);
          return (
            <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground tabular-nums">
                {formatDateTime(warningEventTimestamp(ev))}
              </span>
              <span className="font-medium">{warningLabel(ev.type)}</span>
              {/* Cuáles de estos cuentan para el tope no se podía saber mirando
                  la lista, y desde que pegar puede sumar o no según la pregunta
                  el tipo dejó de alcanzar para deducirlo. */}
              {eventoSumoStrike(ev) && (
                <Badge variant="destructive" className="text-3xs">
                  {t("hc_routesAppTeacherMonitorExamId.warningCounts")}
                </Badge>
              )}
              {dondeFue !== null && (
                <span className="text-muted-foreground">
                  · {t("hc_routesAppTeacherMonitorExamId.questionN", { n: dondeFue + 1 })}
                </span>
              )}
              <RowAction
                label={t("hc_routesAppTeacherMonitorExamId.deleteThisWarning")}
                icon={Trash2}
                tone="destructive"
                onClick={() => onClearOne(i)}
              />
            </div>
          );
        })}

        {/* Lo perdonado sigue a la vista. Antes desaparecía: al revisar después
            el expediente decía «0 advertencias» y no había forma de saber qué
            se había quitado, ni cuándo, ni de qué tipo. */}
        {!!cleared?.length && (
          <div className="mt-3 border-t pt-2 space-y-1">
            <p className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("hc_routesAppTeacherMonitorExamId.forgivenTitle", { count: cleared.length })}
            </p>
            {cleared.map((ev, i) => {
              const dondeFue = ubicacion(ev);
              return (
                <div key={i} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                  <span className="tabular-nums">
                    {formatDateTime(warningEventTimestamp(ev))}
                  </span>
                  <span className="line-through">{warningLabel(ev.type)}</span>
                  {dondeFue !== null && (
                    <span>
                      · {t("hc_routesAppTeacherMonitorExamId.questionN", { n: dondeFue + 1 })}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

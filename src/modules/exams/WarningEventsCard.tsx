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
  type WarningEvent,
} from "@/modules/exams/proctoring";

export function WarningEventsCard({
  events,
  onClearAll,
  onClearOne,
}: {
  events: WarningEvent[];
  onClearAll: () => void;
  onClearOne: (idx: number) => void;
}) {
  const { t } = useTranslation();
  if (!events.length) return null;
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
            onClick={onClearAll}
            title={t("hc_routesAppTeacherMonitorExamId.clearAllWarningsTitle")}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            {t("hc_routesAppTeacherMonitorExamId.clearAll")}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="text-xs space-y-1">
        {events.map((ev, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="text-muted-foreground tabular-nums">
              {formatDateTime(warningEventTimestamp(ev))}
            </span>
            <span className="font-medium">{warningLabel(ev.type)}</span>
            {typeof ev.questionIdx === "number" && (
              <span className="text-muted-foreground">
                · {t("hc_routesAppTeacherMonitorExamId.questionN", { n: ev.questionIdx + 1 })}
              </span>
            )}
            <RowAction
              label={t("hc_routesAppTeacherMonitorExamId.deleteThisWarning")}
              icon={Trash2}
              tone="destructive"
              onClick={() => onClearOne(i)}
            />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

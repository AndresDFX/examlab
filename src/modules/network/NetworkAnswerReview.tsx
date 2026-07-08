/**
 * Vista de REVISIÓN de una respuesta `red_consola` — reutilizable en todos los
 * flujos donde el estudiante (o el docente) ve la respuesta ya entregada
 * (revisión de examen/taller/proyecto). Renderiza la consola IOS en modo
 * readOnly, que REPRODUCE los comandos del alumno (prompt + salida) = la
 * terminal exacta, en vez del JSON serializado que se envía a calificar.
 *
 * Si el escenario no es válido (dato corrupto / legacy), cae al texto crudo
 * para no ocultar la respuesta.
 */
import { useMemo } from "react";
import { NetworkConsole } from "./NetworkConsole";
import { parseScenario } from "./scenario";

interface Props {
  /** `question.options` (contiene options.network con el escenario). */
  options: unknown;
  /** Respuesta serializada del alumno (topología final + historial). */
  value: unknown;
}

export function NetworkAnswerReview({ options, value }: Props) {
  const scenario = useMemo(() => parseScenario(options), [options]);
  if (!scenario) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap font-mono min-h-[44px]">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </div>
    );
  }
  return (
    <NetworkConsole
      scenario={scenario}
      value={typeof value === "string" ? value : null}
      readOnly
    />
  );
}

/**
 * Repartir los puntos de las preguntas para que sumen EXACTAMENTE la nota
 * máxima del curso.
 *
 * ── Qué problema resuelve ─────────────────────────────────────────────
 * El docente arma un examen sobre 5,00 y después borra una pregunta: quedan
 * 4,70 repartidos y ninguna forma cómoda de volver a cuadrarlos. Corregir a
 * mano diez preguntas para recuperar 0,30 es la clase de tarea que se hace mal
 * y se abandona a la mitad.
 *
 * ── Lo que NO cambia ──────────────────────────────────────────────────
 * La nota del estudiante. `computeFinalGrade` divide lo ganado sobre el total
 * REAL de puntos y lo escala a la nota máxima, así que un examen que suma 4,70
 * hoy tampoco perjudica a nadie. Lo que estaba mal era lo que se VE: cada
 * pregunta muestra su puntaje y el docente hace las cuentas de cabeza sobre un
 * total que no da. Esto arregla eso, no la aritmética de la calificación.
 *
 * ── Por qué proporcional y no en partes iguales ───────────────────────
 * Los pesos que el docente puso son una decisión suya: la pregunta de código
 * vale más que la de opción múltiple porque cuesta más. Repartir en partes
 * iguales borraría ese criterio sin avisar. Se conserva la proporción y solo
 * se ajusta la escala. Únicamente cuando NINGUNA pregunta tiene puntaje (todo
 * en cero, un examen recién importado) se reparte parejo, porque ahí no hay
 * proporción que conservar.
 */

/** Cuántos decimales maneja el puntaje de una pregunta. */
const DECIMALES = 2;
const FACTOR = 10 ** DECIMALES;

/**
 * Devuelve los puntajes ajustados para que sumen `objetivo`, o `null` cuando
 * no tiene sentido repartir.
 *
 * Trabaja en CENTÉSIMAS enteras y no en decimales: `0.1 + 0.2 !== 0.3` en
 * coma flotante, así que sumar los redondeos de a uno deja sobras de un
 * centésimo que el docente vería como «4,99 de 5,00» justo después de pulsar
 * el botón que existe para cuadrarlo.
 *
 * Garantiza tres cosas:
 *  · la suma es EXACTAMENTE `objetivo`;
 *  · ninguna pregunta queda en cero — una pregunta que no vale nada es una
 *    pregunta que el estudiante puede dejar en blanco sin costo;
 *  · el resultado es determinista (ante empates manda el orden de la lista),
 *    así que pulsar dos veces da lo mismo.
 */
export function repartirPuntos(
  puntos: readonly number[],
  objetivo: number,
): number[] | null {
  const n = puntos.length;
  if (n === 0) return null;
  if (!Number.isFinite(objetivo) || objetivo <= 0) return null;

  const objetivoCent = Math.round(objetivo * FACTOR);
  // No alcanza ni para un centésimo por pregunta: repartir dejaría preguntas
  // en cero, que es peor que dejar el total como está.
  if (objetivoCent < n) return null;

  const crudos = puntos.map((p) => {
    const v = Number(p);
    return Number.isFinite(v) && v > 0 ? v : 0;
  });
  const suma = crudos.reduce((a, b) => a + b, 0);

  const ideales =
    suma > 0
      ? crudos.map((p) => (p / suma) * objetivoCent)
      : crudos.map(() => objetivoCent / n);

  // Piso, con el mínimo de un centésimo por pregunta.
  const cent = ideales.map((v) => Math.max(1, Math.floor(v)));
  let dif = objetivoCent - cent.reduce((a, b) => a + b, 0);

  if (dif > 0) {
    // Sobran centésimos: van a quien quedó más cerca de merecer el siguiente
    // (método del resto mayor). Sin esto el sobrante se lo llevaría siempre la
    // primera pregunta y el reparto dejaría de ser proporcional.
    const orden = ideales
      .map((v, i) => ({ i, resto: v - Math.floor(v), ideal: v }))
      .sort((a, b) => b.resto - a.resto || b.ideal - a.ideal || a.i - b.i);
    for (let k = 0; dif > 0; k++, dif--) cent[orden[k % n].i] += 1;
  } else if (dif < 0) {
    // Faltan: los pone quien más tiene, nunca bajando de un centésimo. Pasa
    // cuando el mínimo obligatorio empujó la suma por encima del objetivo.
    let restan = -dif;
    while (restan > 0) {
      const orden = cent
        .map((v, i) => ({ i, v }))
        .filter((x) => x.v > 1)
        .sort((a, b) => b.v - a.v || a.i - b.i);
      if (orden.length === 0) return null; // todas en el mínimo: no se puede
      for (const x of orden) {
        if (restan === 0) break;
        cent[x.i] -= 1;
        restan--;
      }
    }
  }

  return cent.map((c) => c / FACTOR);
}

/**
 * Cuánto le falta (o le sobra) al examen para llegar a la nota máxima,
 * redondeado a los decimales que maneja el puntaje.
 *
 * Se redondea ANTES de comparar a propósito: la suma de decimales en coma
 * flotante da cosas como `4.999999999999999`, y sin redondear el botón de
 * ajustar aparecería sobre un examen que ya está cuadrado.
 */
export function diferenciaHastaObjetivo(
  puntos: readonly number[],
  objetivo: number,
): number {
  const suma = puntos.reduce((a, p) => {
    const v = Number(p);
    return a + (Number.isFinite(v) ? v : 0);
  }, 0);
  return Number((objetivo - suma).toFixed(DECIMALES));
}

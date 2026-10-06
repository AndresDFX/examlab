/**
 * El porcentaje de asistencia de un estudiante, con la MISMA regla que su nota
 * (`asistenciaDelCorte` en grading/nota-relativa.ts):
 *
 *  - Cuentan solo las sesiones que se DIERON: las que tienen al menos una marca
 *    de alguien (`sesionesDadas`). Sin ninguna marca no se sabe si hubo clase
 *    —o es una sesión futura—, así que no entra para nadie.
 *  - En una sesión que se dio, quien no tiene marca FALTÓ. Los docentes marcan
 *    a los que vinieron y casi nunca a los que no: un vacío es una ausencia.
 *  - Asistió = `presente` o `tarde` (`countsAsPresent`, el mismo predicado de
 *    la nota).
 *
 * Existe porque cada pantalla tenía su propia cuenta y ninguna coincidía con la
 * nota: el estudiante veía 100 % (calculado solo sobre sus marcas) mientras la
 * nota le contaba las faltas; la grilla del docente dividía también por las
 * sesiones futuras; el tablero del curso comparaba contra `"present"` en
 * inglés y mostraba 0 % siempre. Un porcentaje que contradice a la nota es
 * peor que ninguno: es el que el estudiante va a reclamar.
 */
import { countsAsPresent } from "@/modules/grading/grade";

export interface AsistenciaDelEstudiante {
  /** Sesiones que se dieron: el denominador. */
  dadas: number;
  /** Asistió (presente o tarde). */
  asistio: number;
  /** Dadas en las que no asistió: ausente marcado, justificado o SIN marca. */
  falto: number;
  /** De `falto`, las que no tienen ninguna marca (el docente no marcó ausentes). */
  sinMarca: number;
  /** 0..100 redondeado; null si todavía no se dio ninguna sesión. */
  pct: number | null;
}

export function asistenciaDelEstudiante(
  sesiones: readonly { id: string }[],
  dadas: ReadonlySet<string>,
  estado: (sessionId: string) => string | null | undefined,
): AsistenciaDelEstudiante {
  let total = 0;
  let asistio = 0;
  let sinMarca = 0;
  for (const s of sesiones) {
    if (!dadas.has(s.id)) continue;
    total++;
    const st = estado(s.id);
    if (countsAsPresent(st)) asistio++;
    else if (st == null || st === "") sinMarca++;
  }
  return {
    dadas: total,
    asistio,
    falto: total - asistio,
    sinMarca,
    pct: total > 0 ? Math.round((asistio / total) * 100) : null,
  };
}

/**
 * Las sesiones que se dieron, vistas por un ESTUDIANTE (que no ve las marcas de
 * los demás).
 *
 * El servidor las da (`senales_nota_relativa`), pero esa lista se lee al cargar:
 * si el estudiante marca asistencia DESPUÉS —el check-in con la página abierta—,
 * su sesión todavía no figura y la fila diría «Presente» mientras el porcentaje
 * la ignora. Una marca propia prueba que la sesión se dio, así que se suma. Sin
 * la señal del servidor se aproxima como «Mis notas»: la que ya pasó (hoy
 * incluido) o la que tiene marca.
 */
export function sesionesDadasParaEstudiante(
  servidor: ReadonlySet<string> | null,
  sesiones: readonly { id: string; session_date: string }[],
  conMarcaPropia: (sessionId: string) => boolean,
  hoyISO: string,
): Set<string> {
  const dadas = new Set<string>(servidor ?? []);
  for (const s of sesiones) {
    if (conMarcaPropia(s.id) || (!servidor && s.session_date <= hoyISO)) dadas.add(s.id);
  }
  return dadas;
}

/**
 * El vacío de una sesión que se dio. Cuenta como falta y así hay que mostrarlo,
 * en vez de un «Sin registro» que se lee como «no pasa nada».
 */
export const AUSENTE_SIN_MARCA = "ausente_sin_marca";

/** Cómo se muestra UNA sesión: su marca, `AUSENTE_SIN_MARCA`, o null si no se dio. */
export function estadoVisibleDeSesion(
  sessionId: string,
  dadas: ReadonlySet<string>,
  estado: (sessionId: string) => string | null | undefined,
): string | null {
  const st = estado(sessionId);
  if (st) return st;
  return dadas.has(sessionId) ? AUSENTE_SIN_MARCA : null;
}

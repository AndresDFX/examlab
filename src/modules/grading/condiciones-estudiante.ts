/**
 * Condiciones por estudiante en una actividad (taller o proyecto).
 *
 * Dentro de UNA misma actividad el docente le pone a uno o varios estudiantes
 * una condición propia —con un MOTIVO visible para el estudiante— para no tener
 * que abrir un recuperatorio ni reabrir la actividad para todo el curso. Tres
 * condiciones, combinables:
 *
 *  1. **Nota máxima (TOPE)**: la nota del estudiante en esa actividad no pasa de
 *     N en la escala del curso. El tope es `min(nota, N)`, NO proporcional: un
 *     5,0 con tope 4,0 queda en 4,0; un 3,0 sigue en 3,0. Se aplica sobre la
 *     nota YA convertida a la escala del curso.
 *  2. **Plazo propio**: el estudiante puede entregar hasta SU fecha aunque la
 *     actividad ya cerró para los demás.
 *  3. **Entrega individual autorizada**: en una actividad grupal estricta, el
 *     estudiante sin grupo puede entregar solo y queda registrado.
 *
 * ── Reversible, porque se aplica al LEER ───────────────────────────────────
 *
 * El tope NO reescribe ninguna nota en la base: se aplica cuando se LEE la nota.
 * Quitar la condición devuelve la nota original tal cual, sin recalcular nada.
 * La regla vive acá (módulo puro, con tests) y la aplican todas las pantallas
 * que leen la nota de un taller o proyecto por estudiante; su espejo en SQL es
 * `nota_relativa_items` (el acta la usa).
 *
 * ── Por integrante, aunque la entrega sea del grupo ────────────────────────
 *
 * Una entrega grupal es UNA fila compartida, pero la condición es por PERSONA:
 * dos integrantes del mismo grupo pueden tener topes distintos. Por eso el tope
 * se aplica recién al presentar la nota de CADA estudiante (donde ya se resolvió
 * cuál es su entrega), no sobre la fila de la entrega.
 */

export type TipoCondicion = "taller" | "proyecto";

export interface CondicionEstudiante {
  tipo: TipoCondicion;
  actividadId: string;
  userId: string;
  /** Tope de nota en la ESCALA DEL CURSO. `null` = sin tope. */
  notaMaxima: number | null;
  /** Plazo propio (ISO). `null` = sin plazo propio. */
  plazoPropio: string | null;
  /** Autorizado a entregar individual en una actividad grupal estricta. */
  entregaIndividual: boolean;
  /** Motivo visible para el estudiante. Nunca vacío (lo exige la base). */
  motivo: string;
}

/** La fila cruda de `condiciones_estudiante` tal como llega de PostgREST. */
export interface FilaCondicion {
  tipo?: string | null;
  actividad_id?: string | null;
  user_id?: string | null;
  nota_maxima?: number | string | null;
  plazo_propio?: string | null;
  entrega_individual?: boolean | null;
  motivo?: string | null;
}

/**
 * Aplica el tope sobre la nota YA en la escala del curso: `min(nota, N)`.
 *
 * - Sin nota (`null`) no hay nada que topar: devuelve `null`.
 * - Sin tope (`null`) la nota no cambia.
 * - Un tope no numérico se ignora (la nota no cambia): preferible a devolver una
 *   nota arruinada por un dato malo.
 */
export function aplicarTopeDeNota(
  notaEnEscala: number | null | undefined,
  notaMaxima: number | null | undefined,
): number | null {
  if (notaEnEscala == null) return null;
  if (notaMaxima == null) return notaEnEscala;
  const tope = Number(notaMaxima);
  if (!Number.isFinite(tope)) return notaEnEscala;
  return Math.min(notaEnEscala, tope);
}

/** ¿El plazo propio sigue vigente (es una fecha futura)? */
export function plazoPropioVigente(plazo: string | null | undefined, ahora: number): boolean {
  if (!plazo) return false;
  const t = Date.parse(plazo);
  return Number.isFinite(t) && t > ahora;
}

/** ¿Tiene al menos una de las tres condiciones puesta? */
export function tieneCondicion(c: CondicionEstudiante | null | undefined): boolean {
  if (!c) return false;
  return c.notaMaxima != null || c.plazoPropio != null || c.entregaIndividual;
}

/** Normaliza una fila de la base a `CondicionEstudiante` (o `null` si no sirve). */
export function normalizarCondicion(f: FilaCondicion | null | undefined): CondicionEstudiante | null {
  if (!f?.actividad_id || !f.user_id) return null;
  const n = f.nota_maxima == null ? null : Number(f.nota_maxima);
  return {
    tipo: f.tipo === "proyecto" ? "proyecto" : "taller",
    actividadId: f.actividad_id,
    userId: f.user_id,
    notaMaxima: n != null && Number.isFinite(n) ? n : null,
    plazoPropio: f.plazo_propio ?? null,
    entregaIndividual: !!f.entrega_individual,
    motivo: (f.motivo ?? "").trim(),
  };
}

/**
 * Índice `actividadId → condición` para UN estudiante. Las filas que llegan ya
 * vienen filtradas por `user_id`; si por error llegaran de varios estudiantes,
 * la última gana (no se mezclan topes de distintas personas en una actividad).
 */
export function indiceCondicionesPorActividad(
  filas: readonly FilaCondicion[] | null | undefined,
): Map<string, CondicionEstudiante> {
  const m = new Map<string, CondicionEstudiante>();
  for (const f of filas ?? []) {
    const c = normalizarCondicion(f);
    if (c) m.set(c.actividadId, c);
  }
  return m;
}

/**
 * Índice `"<userId>::<actividadId>" → condición`, para cuando se cargan las
 * condiciones de VARIOS estudiantes a la vez (el libro de notas, el diálogo del
 * docente). `clave(userId, actividadId)` arma la misma llave.
 */
export function indiceCondicionesPorEstudianteActividad(
  filas: readonly FilaCondicion[] | null | undefined,
): Map<string, CondicionEstudiante> {
  const m = new Map<string, CondicionEstudiante>();
  for (const f of filas ?? []) {
    const c = normalizarCondicion(f);
    if (c) m.set(claveCondicion(c.userId, c.actividadId), c);
  }
  return m;
}

/** La llave de `indiceCondicionesPorEstudianteActividad`. */
export function claveCondicion(userId: string, actividadId: string): string {
  return `${userId}::${actividadId}`;
}

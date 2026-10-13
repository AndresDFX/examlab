/**
 * ¿La nota de un corte está todavía POR DEFINIRSE para el estudiante?
 *
 * La nota de un corte se calcula RELATIVA a lo que ya se dio (ver
 * nota-relativa.ts): una actividad que sigue abierta no cuenta hasta cerrar, y
 * al cerrar, la que no se entregó cuenta 0. Entre esos dos momentos la nota del
 * corte SUBE —solo ve lo ya calificado y la asistencia— y se lee como «ganado».
 * Cuando la actividad cierra, el 0 entra y la nota cae sin aviso. Ese salto es
 * lo que originó el reporte: un corte que el estudiante veía aprobado terminó
 * por debajo al vencer un taller propio que nunca entregó.
 *
 * Este predicado marca el corte como PARCIAL mientras tenga un ítem que todavía
 * pueda moverlo, para que la pantalla no pinte la nota como definitiva. Es el
 * MISMO predicado por ítem con que `notaEsParcial` (nota-del-curso.ts) decide la
 * parcialidad del CURSO entero; vive acá, en un módulo puro, para que la señal
 * por corte de «Mis notas» y la del curso no puedan divergir. No cambia ningún
 * cálculo de nota: solo decide cómo se PRESENTA.
 */

import { diaDe } from "@/shared/lib/rango-de-fechas";

/** Lo mínimo de un ítem de nota para decidir si deja el corte por definirse. */
export interface ItemParaParcial {
  /** Corte al que pertenece en ESTE curso; `null` = no suma a ninguna nota. */
  cutId: string | null;
  /** Peso en la nota final (% de la nota del curso); `0` = no suma. */
  weight: number;
  /** La actividad ya se dio: cerró, venció, o es externa y tiene notas. */
  seDio: boolean;
  /** El estudiante presentó algo (el original o una recuperación). */
  entrego: boolean;
  /** Entra en la nota de este estudiante (resultado de `actividadCuenta`). */
  cuenta: boolean;
}

/**
 * Si este ítem con peso todavía puede mover la nota del estudiante:
 *  - sigue ABIERTO (no se ha dado), salvo en un curso finalizado, donde ya no
 *    va a cambiar; o
 *  - el estudiante ya lo ENTREGÓ y falta calificarlo (la espera es del docente).
 *
 * Un ítem sin corte o sin peso no mueve la nota: nunca la deja parcial.
 */
export function itemDejaNotaParcial(i: ItemParaParcial, cursoFinalizado: boolean): boolean {
  // `!(peso > 0)` y no `peso <= 0`: un peso que no es número tampoco mueve la nota.
  if (i.cutId == null || !(i.weight > 0)) return false;
  return (!cursoFinalizado && !i.seDio) || (!i.cuenta && i.entrego);
}

/**
 * El corte todavía no terminó: su fecha de fin es hoy o después. Puede recibir
 * actividades que el docente aún no creó, así que su nota sigue por definirse
 * aunque todo lo que existe ya esté calificado. Lo usan la señal por corte de
 * «Mis notas» y `notaEsParcial` (la del curso), para que no diverjan.
 */
export function corteNoTermino(endDate: string | null | undefined, ahora: number): boolean {
  const hoy = diaDe(new Date(ahora));
  const fin = diaDe(endDate ?? null);
  return fin != null && hoy != null && fin >= hoy;
}

/** ¿Algún ítem del corte deja su nota todavía por definirse? */
export function corteEsParcial(
  items: readonly ItemParaParcial[],
  cursoFinalizado: boolean,
): boolean {
  return items.some((i) => itemDejaNotaParcial(i, cursoFinalizado));
}

/**
 * Cursos EN MARCHA a los que todavía no se les designó vocero — helper PURO.
 *
 * El vocero es una casilla del Acuerdo Pedagógico, y el Acuerdo se firma al
 * ARRANCAR el curso. Cuando falta, el documento sale con el nombre, el
 * teléfono y el correo del vocero en blanco, y eso no se descubre al
 * designarlo sino meses después, cuando alguien abre el acta firmada. Medido
 * en producción: de 6 cursos activos, uno llegó sin vocero, y los otros cinco
 * lo tienen sin teléfono.
 *
 * Por qué se avisa solo de los que están EN MARCHA:
 *
 *  - Un BORRADOR todavía no existe para nadie. Pedir el vocero de un curso
 *    que quizá no se dicte convierte el aviso en ruido, y un aviso que se
 *    ignora deja de avisar.
 *  - Un curso FINALIZADO ya no tiene arreglo posible: el acuerdo se firmó (o
 *    no) y designar el vocero ahora no reescribe el documento — el HTML queda
 *    congelado al generarse. Insistir ahí es pedir una acción inútil.
 *  - Y uno cuya fecha de FIN ya pasó se trata como terminado aunque su
 *    `status` siga en `en_curso`: `deriveCourseDisplayState` mantiene ese
 *    estado a propósito hasta que el cron o el docente lo cierren, pero para
 *    ESTE aviso lo que importa es si designar al vocero todavía sirve de algo.
 *
 * Sin React, sin `Date.now()` interno, sin toast → testeable.
 */
import { deriveCourseDisplayState, type CourseLifecycleShape } from "./course-status";

/** Forma mínima del curso que necesita el aviso. */
export interface CursoParaAvisoVocero extends CourseLifecycleShape {
  id: string;
  name: string;
}

/**
 * Interpreta una fecha de la columna DATE (`YYYY-MM-DD`) o un timestamptz.
 *
 * Anclar a mediodía LOCAL es la misma defensa que aplica `course-status` y
 * `formatDateOnly`: `new Date('2026-06-15')` se lee como medianoche UTC, que
 * en es-CO (UTC-5) cae el día anterior a las 19:00 y adelantaría el cierre
 * del curso casi un día.
 */
function aMilis(fecha: string): number {
  return new Date(fecha.length === 10 ? `${fecha}T12:00:00` : fecha).getTime();
}

/**
 * ¿El curso sigue dentro de su ventana, o sea que designar vocero AÚN sirve?
 *
 * Un curso sin `end_date` cuenta como vigente: no hay fecha que lo cierre, y
 * callar el aviso por un dato que el docente nunca cargó lo dejaría sin
 * enterarse justamente en el curso peor configurado.
 */
export function dentroDeFechas(curso: CourseLifecycleShape, ahora: number): boolean {
  if (!curso.end_date) return true;
  const fin = aMilis(curso.end_date);
  if (!Number.isFinite(fin)) return true;
  // El día de fin se cuenta ENTERO: el ancla es mediodía, así que se corre al
  // cierre de esa jornada. Sin esto, el último día del curso el aviso
  // desaparece a mitad de la mañana.
  return ahora <= fin + 12 * 60 * 60 * 1000;
}

/**
 * Los cursos del docente que están en marcha y sin vocero, ordenados como
 * vienen. `voceroPorCurso` trae el id de cada curso que YA tiene vocero.
 */
export function cursosSinVocero(
  cursos: ReadonlyArray<CursoParaAvisoVocero>,
  conVocero: ReadonlySet<string>,
  ahora: number,
): CursoParaAvisoVocero[] {
  return cursos.filter(
    (c) =>
      !conVocero.has(c.id) &&
      deriveCourseDisplayState(c, ahora) === "en_curso" &&
      dentroDeFechas(c, ahora),
  );
}

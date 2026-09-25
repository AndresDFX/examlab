/**
 * ¿Esta nota aprueba? Fuente única del criterio y del COLOR con que se pinta.
 *
 * ── El bug que originó el módulo ──────────────────────────────────────
 * En el listado de exámenes del estudiante, el badge de la calificación se
 * pintaba rojo con triángulo de alerta **mirando el estado de la entrega, no
 * la nota**. Un alumno con 4,37 sobre 5 —aprobado con holgura— veía su nota en
 * rojo y con símbolo de advertencia porque su entrega había quedado marcada
 * como sospechosa por las advertencias de proctoring. El rojo de ese badge
 * dice «tu calificación está mal», y no era verdad.
 *
 * Son dos informaciones distintas y necesitan dos lugares distintos: la NOTA
 * la dice el badge, y si hubo algo que revisar en la entrega se dice aparte —
 * como ya hace el aviso de advertencias, con su propio ícono y su propio
 * texto. Mezclarlas hace que el alumno no sepa cuál de las dos cosas le están
 * señalando.
 *
 * ── El umbral ─────────────────────────────────────────────────────────
 * Sale de `courses.passing_grade`, que es el que la institución configuró; no
 * hay un segundo umbral que mantener. Cuando falta se usa 3, el mismo default
 * que ya aplica `report-context.ts` al armar actas y boletines: dos defaults
 * distintos harían que el acta y la pantalla se contradigan sobre el mismo
 * estudiante.
 */

/** El mismo default que usa el armado de actas y boletines. */
export const NOTA_APROBATORIA_POR_DEFECTO = 3;

/**
 * `true` aprobada, `false` reprobada, `null` cuando todavía no hay nota.
 *
 * El `null` es parte del contrato: sin nota no se puede decir «reprobó», y
 * tratar la ausencia como reprobada pinta de rojo a quien solo está esperando
 * que lo califiquen.
 */
export function estaAprobada(
  nota: number | null | undefined,
  notaAprobatoria?: number | null,
): boolean | null {
  if (nota == null || !Number.isFinite(nota)) return null;
  const umbral =
    notaAprobatoria != null && Number.isFinite(notaAprobatoria)
      ? notaAprobatoria
      : NOTA_APROBATORIA_POR_DEFECTO;
  return nota >= umbral;
}

/**
 * La variante de `Badge` que le corresponde a una nota.
 *
 * `destructive` SOLO cuando se sabe que reprobó. Sin nota, o aprobada, nunca
 * es rojo — que es exactamente la regla que faltaba.
 */
export function varianteDeNota(
  nota: number | null | undefined,
  notaAprobatoria?: number | null,
): "default" | "destructive" | "secondary" {
  const aprobada = estaAprobada(nota, notaAprobatoria);
  if (aprobada === null) return "secondary";
  return aprobada ? "default" : "destructive";
}

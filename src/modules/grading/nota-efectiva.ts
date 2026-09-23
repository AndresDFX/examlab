/**
 * La nota de una entrega que SE PUEDE usar para promediar.
 *
 * Todo el proyecto lee la nota de un taller como `final_grade ?? ai_grade`. Ese
 * fallback existe por una razón buena: hay entregas históricas donde la IA dejó
 * su nota en `ai_grade` y nadie cerró `final_grade`, y sin el fallback esas
 * entregas contarían CERO.
 *
 * Con la sustentación encendida ese mismo fallback se vuelve un agujero: el
 * estado NORMAL de una entrega recién calificada por la IA es `final_grade`
 * NULL (falta sustentar) con `ai_grade` poblado. Caer a `ai_grade` ahí es
 * exactamente lo contrario de lo que la sustentación existe para imponer —y no
 * se queda en la pantalla: esa nota alimenta el consolidado del curso, el CSV,
 * el boletín, la alerta temprana y **la emisión de certificados**, que compara
 * contra `passing_grade`. O sea que un taller sin sustentar podía empujar a un
 * estudiante por encima del corte y hacerle emitir un certificado.
 *
 * Por eso la decisión vive acá y no repetida en cada pantalla: lo encontró la
 * revisión de consistencia en CUATRO archivos a la vez, que es lo que pasa
 * cuando una regla se escribe a mano en cada sitio.
 *
 * **Proyectos NO pasa por acá todavía**, y es deliberado: allá la sustentación
 * es obligatoria para todos, así que aplicar esta regla cambiaría la nota
 * consolidada de cursos que HOY están cerrados en producción. Es una decisión de
 * producto, no un detalle de implementación. El hueco está documentado en el
 * CHANGELOG y en CLAUDE.md.
 */
export interface EntregaConNota {
  final_grade?: number | null;
  ai_grade?: number | null;
}

export function notaEfectivaDeTaller(
  sub: EntregaConNota | null | undefined,
  requiereSustentacion: boolean | null | undefined,
): number | null {
  if (!sub) return null;
  if (requiereSustentacion) {
    // Sin sustentación registrada no hay nota, y punto. `ai_grade` es la nota
    // del TRABAJO: usarla acá sería dar por cerrada una nota que el docente
    // todavía no cerró.
    return sub.final_grade ?? null;
  }
  return sub.final_grade ?? sub.ai_grade ?? null;
}

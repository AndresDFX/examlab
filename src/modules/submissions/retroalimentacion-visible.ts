/**
 * ¿El estudiante ya puede ver la retroalimentación de su entrega?
 *
 * Solo cuando está CALIFICADA. Mientras está «Por calificar», lo que hay en
 * `ai_feedback` es un resultado a medias —la IA calificó algunas preguntas,
 * o el docente todavía va a revisar— y mostrarlo hace que el estudiante
 * reclame sobre una nota que aún no existe.
 *
 * Talleres y proyectos: estado `calificado` o una nota final ya puesta.
 * Exámenes (no tienen estado `calificado`): cualquier nota, de la IA o del
 * docente.
 */
export function retroDeTallerVisible(
  s: { status?: string | null; final_grade?: number | null } | null | undefined,
): boolean {
  return !!s && (s.status === "calificado" || s.final_grade != null);
}

export function retroDeExamenVisible(
  s: { ai_grade?: number | null; final_override_grade?: number | null } | null | undefined,
): boolean {
  return !!s && (s.final_override_grade != null || s.ai_grade != null);
}

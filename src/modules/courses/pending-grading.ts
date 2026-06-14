/**
 * Agregación de "pendientes de calificación" por curso para el dashboard del
 * docente. Helper PURO (sin DB/React) para test directo.
 *
 * El caller resuelve qué entregas están pendientes (mismas reglas que el
 * dashboard Admin):
 *   - examen:   submissions.status ∈ {completado, sospechoso} y ai_grade NULL
 *   - taller:   workshop_submissions.status = 'entregado' y final_grade NULL
 *   - proyecto: project_submissions.status = 'entregado' y final_grade NULL
 * y pasa, por cada entrega pendiente, el id de su ACTIVIDAD (exam/workshop/
 * project). `activityToCourse` mapea actividad → curso (único; para talleres/
 * proyectos M:N el caller elige el curso ancla del docente). Así cada entrega
 * cuenta UNA sola vez y el total = suma de los conteos por curso.
 */
export type PendingGradingCourse = {
  courseId: string;
  courseName: string;
  count: number;
};

export function aggregatePendingGradingByCourse(
  courses: { id: string; name: string }[],
  activityToCourse: Map<string, string>,
  pendingSubmissionActivityIds: string[],
): { total: number; byCourse: PendingGradingCourse[] } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const activityId of pendingSubmissionActivityIds) {
    const courseId = activityToCourse.get(activityId);
    if (!courseId) continue; // actividad fuera de los cursos del docente
    counts.set(courseId, (counts.get(courseId) ?? 0) + 1);
    total += 1;
  }
  const nameById = new Map(courses.map((c) => [c.id, c.name]));
  const byCourse: PendingGradingCourse[] = [];
  for (const [courseId, count] of counts.entries()) {
    if (count <= 0) continue;
    byCourse.push({ courseId, courseName: nameById.get(courseId) ?? courseId, count });
  }
  byCourse.sort((a, b) => b.count - a.count || a.courseName.localeCompare(b.courseName, "es-CO"));
  return { total, byCourse };
}

/**
 * Ruta del docente para gestionar cursos. Reusa el componente
 * AdminCourses (definido en app.admin.courses) para tener paridad
 * total de funcionalidad con Admin: CRUD de cursos, matrículas,
 * docentes, cortes, pesos y duplicación.
 *
 * La RLS y el filtrado del UI imponen las únicas restricciones para
 * Docente:
 *  - course_teachers RLS: no puede insertar/borrar su propia fila.
 *  - El dialog de docentes filtra al usuario actual de la lista.
 *
 * Tener una ruta separada (/app/teacher/courses) en vez de mandar al
 * docente a /app/admin/courses evita la confusión de ver "admin" en
 * la URL cuando se está actuando como docente.
 */
import { createFileRoute } from "@tanstack/react-router";
import { AdminCourses } from "./app.admin.courses";

export const Route = createFileRoute("/app/teacher/courses")({
  component: AdminCourses,
});

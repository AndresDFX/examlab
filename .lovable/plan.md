## Objetivo

Alinear el módulo de **Proyectos** con el de Talleres/Exámenes en tres frentes:

1. **Asignación por curso** (auto-asignar a todos los matriculados, no solo uno-por-uno).
2. **Eliminar entregas** de proyecto desde la UI docente (igual que Talleres y Exámenes/Monitor ya lo permiten).
3. **Vista docente para calificar entregas** de proyecto (hoy no existe; solo se puede asignar).

---

## 1. Asignación de proyectos por curso

**Hoy**: el diálogo de asignar (`openAssignDialog` en `app.teacher.projects.tsx`) carga los estudiantes matriculados en los cursos vinculados y permite marcar uno por uno. Existe "Seleccionar todo / Quitar todo", pero no hay auto-asignación al publicar (a diferencia de `autoAssignWorkshop` en talleres).

**Cambios** en `src/routes/app.teacher.projects.tsx`:
- Añadir `autoAssignProject(projectId, courseIds[])` análogo a `autoAssignWorkshop`: lee `course_enrollments` de los cursos vinculados, calcula deltas contra `project_assignments`, e inserta los faltantes.
- Llamar a `autoAssignProject` automáticamente cuando el proyecto se guarda con `status = "published"` (en `save()`), usando `linked_course_ids`.
- En el diálogo de asignación, agregar selector visual de cursos vinculados (chips/checkboxes) para filtrar la lista de estudiantes mostrados; "Seleccionar todo" actuará sobre los visibles. Esto permite asignar masivamente por curso cuando el proyecto está vinculado a varios cursos.
- Añadir botón **"Asignar a todos los del curso"** por cada curso vinculado, que dispare la auto-asignación solo de ese subgrupo.

## 2. Eliminar entregas de proyecto

**Hoy**: Talleres tiene `deleteSubmission` (`workshop_submissions.delete`). Monitor de exámenes tiene `delete` sobre `submissions`. Proyectos no tiene UI de entregas → no hay forma de borrar.

**Cambios**: la opción de eliminar entrega vivirá dentro del nuevo diálogo de calificación (sección 3), reusando el patrón de Talleres:
- Botón papelera por fila de entrega → `confirm` → `db.from("project_submissions").delete().eq("id", subId)`.
- Las RLS ya permiten DELETE a Docente/Admin (`Docentes/Admins delete project submissions`).
- El borrado en cascada de `project_submission_files` y `project_submission_attachments` debe estar garantizado: añadir migración solo si las FK no son `ON DELETE CASCADE`. Verificaremos en la migración; si ya están, omitir.

## 3. Vista docente para calificar entregas de proyecto

**Hoy**: el docente puede crear el proyecto, definir archivos esperados y asignarlo, pero no hay pantalla para ver/calificar las entregas. La calificación de cada caja la hace la IA al enviar (en `StudentProjectTaker`), pero el docente no puede revisar, sobreescribir, ni recalificar.

**Cambios** en `src/routes/app.teacher.projects.tsx`:
- Nuevo botón **"Entregas"** (icono `ClipboardList`) por fila en la tabla de proyectos.
- Nuevo diálogo `gradingOpen` que carga:
  - `project_submissions` del proyecto + perfiles de los estudiantes.
  - `project_files` (definición de las cajas esperadas).
  - `project_submission_files` (contenido + `ai_grade` + `ai_feedback` + `ai_likelihood`) por entrega.
- Por cada entrega, mostrar acordeón con:
  - Estado, nota final, fecha de envío, % probabilidad IA.
  - Por cada `project_file`: contenido del estudiante (read-only mono), `ai_grade` editable, `ai_feedback` editable, botón **"Recalificar con IA"** (reusa edge function `ai-grade-submission` con `projectFileGrading: true` ya existente).
  - Botón **"Guardar nota"**: persiste el override en `project_submission_files`, recalcula `final_grade` sumando puntos / max y normalizando contra `max_score`, actualiza `project_submissions.final_grade` + `status = "calificado"`.
  - Botón **"Eliminar entrega"** (sección 2).
- Toda la lógica imita la del módulo de talleres (`openGrading`, `recomputeFinalGrade`, `saveAnswerGrade`, `aiRegradeAnswer`, `deleteSubmission`).

---

## Detalles técnicos

**Archivos a modificar**:
- `src/routes/app.teacher.projects.tsx` — añadir `autoAssignProject`, mejorar diálogo de asignación, añadir diálogo de entregas/calificación, añadir delete.

**Archivos a crear** (opcional, para mantener el archivo manejable):
- `src/components/ProjectGrading.tsx` — extraer el panel de calificación si crece demasiado.

**Migración SQL** (`supabase/migrations/<ts>_project_cascade.sql`) — solo si las FK actuales no cascadean:
```sql
-- Garantizar borrado en cascada al eliminar project_submissions
ALTER TABLE project_submission_files
  DROP CONSTRAINT IF EXISTS project_submission_files_submission_id_fkey,
  ADD CONSTRAINT project_submission_files_submission_id_fkey
    FOREIGN KEY (submission_id) REFERENCES project_submissions(id) ON DELETE CASCADE;

ALTER TABLE project_submission_attachments
  DROP CONSTRAINT IF EXISTS project_submission_attachments_psf_fkey,
  ADD CONSTRAINT project_submission_attachments_psf_fkey
    FOREIGN KEY (project_submission_file_id) REFERENCES project_submission_files(id) ON DELETE CASCADE;
```

**Recálculo de nota final** (igual al de talleres):
```ts
const totalPoints = files.reduce((s, f) => s + Number(f.points || 0), 0);
const earned = files.reduce((s, f) => {
  const ans = answers.find(a => a.file_id === f.id);
  return s + Math.min(Number(ans?.ai_grade ?? 0), Number(f.points));
}, 0);
const finalGrade = Number(((earned / totalPoints) * project.max_score).toFixed(2));
```

**RLS**: ya permiten todas las operaciones necesarias (Docentes/Admins manage en `project_assignments`, `project_submissions`, `project_submission_files`).

**Sin cambios** en: rutas de estudiante, edge functions, schema (excepto la migración cascade si aplica).

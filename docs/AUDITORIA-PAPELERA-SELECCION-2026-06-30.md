# Auditoría — papelera no seleccionable en ningún flujo (2026-06-30)

**Objetivo (directiva del usuario):** verificar que ninguna de las 8 entidades
con soft-delete (`deleted_at`) — `courses, exams, workshops, projects,
attendance_sessions, whiteboards, generated_contents, polls` — aparezca
**disponible para selección** ni sea **usable** en ningún flujo/rol cuando está
en la papelera.

**Método:** workflow multi-agente (8 finders, uno por entidad, + verificación
adversaria). El límite de sesión de subagentes cortó 7 verificaciones; esos 7
sospechosos se recuperaron de los transcripts y se adjudicaron + corrigieron
manualmente en el loop principal. Se complementó con spot-checks directos de los
pickers/deep-links de mayor valor.

## Hallazgos confirmados y corregidos

### Cliente (selección) — requieren Lovable Publish

| # | Archivo | Problema | Fix | Commit |
|---|---|---|---|---|
| 1 | `app.student.whiteboards.index.tsx` | El filtro `<Select>` por curso se poblaba del embed `course_enrollments→courses` SIN `deleted_at`; un curso en papelera (alumno aún matriculado) salía como opción y sus pizarras seguían listándose. | Embed trae `deleted_at`; se saltan cursos en papelera del filtro y se ocultan sus pizarras. | `8b9e7054` |
| 2 | `app.forum.$courseId.tsx` | Deep-link resuelve el curso por id sin `deleted_at` → foro de curso en papelera accesible por link/bookmark. | `.is("deleted_at", null)` + early-return con `ErrorState` "curso no disponible" si el curso resuelve a null. | `8b9e7054` |
| 3 | `app.forum.$courseId.$forumId.tsx` | Idem #2 (archivo hermano). | Idem #2. | `8b9e7054` |

### Servidor (RPCs SECURITY DEFINER) — vía CI · mig `20261016000000`

| # | Función | Problema | Fix |
|---|---|---|---|
| 4 | `clone_exam` | Clonaba un examen origen en papelera (auth pasa porque el row borrado existe). | Guard `deleted_at IS NULL` tras la auth. |
| 5 | `clone_workshop` | Idem. | Guard. |
| 6 | `clone_project` | Idem. | Guard. |
| 7 | `teacher_open_attendance_check_in` | (Re)abría check-in sobre una sesión en papelera. | Guard → `session_not_found`. |
| 8 | `update_session_whiteboard_scene` | Escribía la pizarra de una sesión en papelera. | Guard → RAISE "está en la papelera". |

**Verificado contra prod** (transacción con ROLLBACK): cada guard rechaza la
entidad en papelera y el happy-path (entidad activa) sigue funcionando.

### BUG pre-existente detectado en la auditoría (no es de papelera)

`clone_workshop` y `clone_project` **NO** insertaban `created_by`, pero
`workshops.created_by` / `projects.created_by` son **NOT NULL sin default ni
trigger** → **"Duplicar taller" y "Duplicar proyecto" SIEMPRE fallaban** con
violación de NOT NULL. `clone_exam` sí lo seteaba. Corregido en la misma
migración (`created_by = auth.uid()`, paridad con `clone_exam`). Verificado: con
el fix el happy-path crea la copia OK.

## Verificado limpio (ya filtraban `deleted_at`)

Spot-checks directos que confirman al finder (devolvieron 0 sospechosos):

- **Pickers "asociar a sesión":** `ActivitySessionSelect` (reusable), poll
  `app.teacher.polls.tsx` → ambos `.is("deleted_at", null)`.
- **Exam-take deep-link** `app.student.take.$examId.tsx` → resuelve el examen con
  `.is("deleted_at", null)` (un alumno no puede tomar un examen en papelera).
- Diálogos de snippet/pizarra de sesión leen una sesión YA elegida desde la grilla
  de asistencia (que filtra) por `eq(id)` — no son contextos de selección.

## Estado

Iteración completa. Pendiente: 2º pase complementario (RPCs/edges que resuelven
las 8 entidades server-side + embeds/vistas derivadas, todos los roles) cuando el
límite de subagentes se reinicie (16:40 America/Bogota) — patrón "completeness
critic" para maximizar cobertura.

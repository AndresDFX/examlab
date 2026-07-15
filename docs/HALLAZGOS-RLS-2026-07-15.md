# Hallazgos RLS — revisión general 2026-07-15

Revisión de RLS enfocada en **cursos↔estudiantes** (a pedido) + barrido general del mismo patrón
(workflows `rls-overperm-sweep`). Todo verificado empíricamente contra PROD con `SET ROLE
authenticated` + jwt claims en transacciones con rollback (patrón de la memoria `rls-self-tamper-class`).

## Clase de bug encontrada (sistémica)

**Sobre-permiso de GESTIÓN del docente**: varias policies `*_staff_manage` (FOR ALL) usaban
`<x>_in_my_tenant(...)` (CUALQUIER curso del tenant) + `has_role('Docente')`, cuando la intención
—y el SELECT correspondiente— es `_teaches_course` (solo los cursos que el docente **dicta**).
**Efecto**: un docente podía **crear/editar/borrar y gestionar datos de cursos de OTRO docente de la
misma institución** (no es leak cross-tenant, pero sí de autorización intra-institución). El molde de
fix correcto ya existía en `intro_videos` (mig 20261039): Admin→tenant, Docente→dicta, SA→todo.

## Estado

| # | Tabla / policy | Sev | Estado | Evidencia / fix |
|---|---|---|---|---|
| 1 | `courses` (docente_manage) | alta | ✅ **fixed** `c78fa3bc` (mig 20261180000000) | UPDATE/DELETE→`_teaches_course`; INSERT tenant-scoped (crear). Verificado 5/5. |
| 2 | `course_enrollments` (docente_manage) | alta | ✅ **fixed** `c78fa3bc` | gestión→`_teaches_course` (antes tenant). Docente ya no matricula en cursos ajenos. |
| 3 | `exams` (staff_manage) | alta | ✅ **fixed** `b3cb05bf` (mig 20261190000000) | Docente→`_teaches_course(course_id)`. |
| 4 | `workshops` (staff_manage) | alta | ✅ **fixed** `b3cb05bf` | idem. |
| 5 | `projects` (staff_manage) | alta | ✅ **fixed** `b3cb05bf` | idem. |
| 6 | `attendance_sessions` (staff_manage) | alta | ✅ **fixed** `b3cb05bf` | Docente→`_teaches_course`. |
| 7 | `questions` (staff_manage) | **alta** | ✅ **fixed** `b3cb05bf` | Docente→`_teaches_exam`. Antes: editar respuesta correcta+rúbrica de exámenes ajenos. |
| 8 | `workshop_questions` (staff_manage) | alta | ✅ **fixed** `b3cb05bf` | Docente→`_teaches_workshop`. |
| 9 | `project_files` (staff_manage) | alta | ✅ **fixed** `b3cb05bf` | Docente→`_teaches_project`. |
| 10 | `attendance_records` (staff_manage) | alta | ✅ **fixed** `b3cb05bf` | Docente→`_teaches_attendance_session`. |
| 11 | `exam_assignments` (staff_manage) | media | ✅ **fixed** `20261200000000` | Docente→`_teaches_exam(exam_id)`. Verificado: docente NO asigna alumno a examen ajeno. |
| 12 | `workshop_groups` + `workshop_group_members` | media | ✅ **fixed** `20261200000000` | Docente→`_teaches_workshop` / `_teaches_workshop_group`. |
| 13 | `project_groups` + `project_group_members` | media | ✅ **fixed** `20261200000000` | Docente→`_teaches_project` / `_teaches_project_group`. |
| 14 | `generated_contents` (owner, WITH CHECK) | baja | ⬜ **a revisar** | El WITH CHECK del `_owner` es owner-based (`teacher_id=auth.uid()`) — probablemente OK; confirmar que un docente no cambie `teacher_id`/`course_id` a uno ajeno. |

## Helpers agregados (mig 20261190000000)

`_teaches_exam(uuid)`, `_teaches_workshop(uuid)`, `_teaches_project(uuid)`,
`_teaches_attendance_session(uuid)` — `EXISTS(padre WHERE id=$1 AND _teaches_course(padre.course_id))`,
`SECURITY DEFINER`, `STABLE`. Reutilizables para cerrar los pendientes #11–#13.

## No son findings (verificados OK)

- `submissions` / `*_submissions` / `workshop_submission_answers`: bien scopeados (dueño/grupo +
  `course_teachers` + `is_admin_of_course_tenant`).
- El **estudiante** solo ve sus propias matrículas (`course_enrollments` SELECT = `user_id=auth.uid()`)
  y no ve entregas/notas ajenas. El SELECT de cursos es catálogo del tenant (metadata, por diseño).
- Endurecimientos previos siguen vigentes: `generated_contents` release-gate + storage teacher-only
  (mig 20261160/20261170), `tenant_email_settings` (20261140), barridos 20260929/20260945/20261045-48.

## Cierre

La clase sistémica quedó **totalmente cerrada** (#1–#13, migraciones 20261180/20261190/20261200):
toda gestión de curso/evaluación/sesión/grupo del **Docente** exige ahora `_teaches_course`/
`_teaches_*` (solo lo que dicta); Admin conserva alcance de tenant; SuperAdmin, todo. Helpers
`_teaches_{course,exam,workshop,project,attendance_session,workshop_group,project_group}` reutilizables.

Único ítem abierto: **#14** `generated_contents_owner` (baja) — el WITH CHECK es owner-based
(`teacher_id=auth.uid()`), probablemente correcto; confirmar en una próxima pasada que un docente no
pueda reasignar `teacher_id`/`course_id` a uno ajeno vía UPDATE.

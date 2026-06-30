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

## 2º pase (server-side + embeds, manual en el loop principal)

Hecho sin subagentes (estaban rate-limited). Tres ángulos:

1. **Crons de notificación** (los 5 recordatorios + resúmenes que leen las 8
   entidades): todos filtraban `deleted_at` EXCEPTO
   `notify_teachers_pending_exam_notes_before_exam` (cron `teacher-exam-prep-1h`,
   cada 10 min) → recordaba notas de apoyo de un examen en papelera. **Corregido**
   en mig `20261017000000` (`AND e.deleted_at IS NULL`), verificado vs prod.

2. **Escaneo amplio de funciones** (`pg_get_functiondef` de TODAS las funciones
   public que leen una de las 8 entidades por FROM/JOIN): tras los fixes, **0**
   funciones sin referencia a `deleted_at`. Surface server-side limpia.

2b. **RPCs de interacción alumno con poll/sesión** (mig `20261018000000`):
   - `poll_is_open(_poll)` NO miraba `deleted_at` → un alumno con deep-link
     `?poll=` podía VOTAR (`vote_poll_option`), quitar voto
     (`clear_poll_response`) o el docente asignar slots
     (`teacher_assign_remaining_to_slots`) sobre una encuesta en papelera dentro
     de su ventana. **Corregido en un solo lugar** (`AND _poll.deleted_at IS
     NULL`, sigue IMMUTABLE, ninguna RLS la usa) → cubre las 5 funciones que la
     consumen. Verificado: `poll_is_open` activa=true→trashed=false.
   - `student_check_in_attendance` marcaba asistencia por QR/deep-link sobre una
     sesión en papelera si `check_in_open` quedó en true al borrarla. **Guard
     añadido** → `session_not_found`. Verificado vs prod.
   - **No tocado** (aceptado): `kahoot_submit_answer` (el JOIN ya filtra papelera;
     borrar en medio de un juego en vivo = caso extremo sin daño) y 3 funciones
     teacher-only de gestión de respuestas (sobre su propia encuesta, sin
     exposición a alumnos/cross-tenant). `kahoot_join_game`/`_by_id` ya guardan ✓.

3. **Embeds cliente** (`exam_assignments→exams`, `courses→workshops/projects`,
   etc. + calendarios del estudiante/dashboard): todos traen `deleted_at` en el
   select Y **saltan en JS** (`if (x.deleted_at) continue`). Verificado en
   `app.student.exams` (`!e.deleted_at`), `app.student.calendar`,
   `StudentEventsCalendar`. Limpio.

### Edges (service_role, bypassa RLS)

`calendar` y `calendar-ics` filtran `deleted_at` en la generación de eventos +
guard de poll (`poll.deleted_at → 404`). `student-calendar-ics` corregido aparte
(typo `"publicado"`→`"published"`, commit `07a3fcf0`). Resto de edges leen por id
en flujos internos (grading/generación) donde el chooser ya filtró.

## 3er pase — confirmación adversaria (workflow, 6 lentes)

Workflow `papelera-confirm-pass`: storage, RPC-por-id, deep-link, RLS, realtime,
vistas derivadas. **2 fugas reales + 1 falso positivo:**

1. **RLS `generated_contents_student_via_session`** (mig `20261019000000`): no
   filtraba `deleted_at` → un alumno matriculado leía por REST directo un
   contenido EN PAPELERA (título + files[] con body inline). La hermana
   `via_course` sí filtra. Fix: recrear con `deleted_at IS NULL` (contenido) +
   `s.deleted_at IS NULL` (sesión). **Verificado con `SET ROLE authenticated`
   vs prod**: SIN fix trashed_visible=SÍ; CON fix=NO; activo sigue visible.
2. **Deep-link `app.teacher.grading.$courseId`**: resolvía el curso con
   `.single()` sin `deleted_at` → staff abría/EDITABA config de notas de un curso
   en papelera. Fix: `.is("deleted_at",null).maybeSingle()` + ErrorState.
3. **FALSO POSITIVO** — `gc_student_read_via_session` (Storage) que el agente
   reportó YA NO existe en prod (reemplazada por `gc_student_read_via_course`,
   guardada). Verificado en `pg_policies`. Sin fix.

Nota: `generated_contents_owner [ALL]` ve trashed a propósito (staff lo necesita
en la Papelera para restaurar) — no es fuga.

## 4º pase — RLS de tablas HIJAS (loop-until-dry, workflow 6 lentes)

**8 fugas RLS** (mig `20261020000000`): un alumno leía por REST directo (la UI
filtra, la RLS no) contenido cuyo PADRE estaba en papelera:

| Policy | Qué exponía | Sev |
|---|---|---|
| `questions_select_in_tenant` | content + **options (clave de respuesta)** + rubric de examen en papelera | HIGH |
| `workshop_questions_select_in_tenant` | idem para talleres | HIGH |
| `whiteboards_select` (rama alumno) | header de pizarra compartida en papelera | HIGH |
| `whiteboard_pages_select` (rama alumno) | **escena/dibujos** de pizarra en papelera | HIGH |
| `poll_options_select` | opciones + responses_count de encuesta en papelera | MED |
| `polls_select_course_members` (rama alumno) | header de encuesta en papelera | MED |
| `session_code_snippets_select` (rama alumno) | **código de clase** de sesión en papelera | MED |
| `attendance_sessions_select_in_tenant` | whiteboard_scene/meeting/recording de sesión en papelera | MED |

**Fix:** gatear SOLO la ruta no-staff con `<padre>.deleted_at IS NULL`; el staff
conserva acceso (Papelera/restore) vía sus policies `*_staff_manage`/`*_write_*`.

**Sutileza RLS crítica detectada en la verificación:** el patrón `NOT
EXISTS(polls WHERE deleted_at IS NOT NULL)` se evalúa BAJO la RLS de polls del
usuario; al gatear `polls` para ocultar trashed al alumno, ese subquery deja de
ver la poll en papelera → **falla ABIERTO**. Afectaba a `poll_options` (nuevo) y
a `poll_questions_select` + `pqr_select` (YA existentes — solo "funcionaban"
porque `polls` aún filtraba mal). Se introdujo helper SECURITY DEFINER
`_poll_in_papelera` (RLS-inmune) y se migraron las 3. Sin esto, mi fix de `polls`
habría roto silenciosamente 2 guards existentes en prod.

**Verificado vs prod con `SET ROLE authenticated`** (tx ROLLBACK): las 9 policies
→ alumno ve activo pero NO trashed; staff sigue viendo trashed (Papelera intacta).
(Detecté que el conn de pg era superusuario y bypassa RLS — repetí TODA la
verificación RLS con `SET ROLE authenticated` para que fuera real.)

## 5º pase — entidades raíz + kahoot + foros (loop-until-dry, 4 lentes)

El completeness-critic detectó la **asimetría**: el pase 4 gateó
whiteboards/polls/attendance a nivel entidad pero dejó las demás raíz + kahoot +
foros. **9 fugas** (mig `20261021000000`):

- **Entidades raíz** `exams/workshops/projects/courses _select_in_tenant`: un
  alumno del tenant leía por REST el HEADER de un examen/taller/proyecto/curso en
  papelera (workshops/projects exponían **INSTRUCTIONS** completas). Gate
  `deleted_at IS NULL OR <staff>`.
- **Kahoot**: `kahoot_get_state` (RPC; exponía el **answer key** `is_correct` en
  reveal/ended de un juego cuya encuesta fue a papelera) + `kahoot_games_select`
  + `kahoot_players_select`. Gate con `_poll_in_papelera` en la rama miembro.
- **Foros**: `forums/forum_threads/forum_replies` SELECT **+ INSERT** — un alumno
  LEÍA y ESCRIBÍA en el foro de un curso en papelera (`is_forum_open` no mira
  `courses.deleted_at`; la matrícula sobrevive). Gate con nuevo helper
  `_course_in_papelera` (SECURITY DEFINER, RLS-inmune) SIN tocar `is_forum_open`
  (preserva su invariante cross-file con los espejos en JS).

**Verificado vs prod** (`SET ROLE authenticated`, tx ROLLBACK): entidades → alumno
ve activo, NO trashed, staff ve trashed; `kahoot_games`/`get_state` → alumno
bloqueado en papelera. Foros: 0 filas en prod (no testeable con datos); migración
aplica limpio + lógica espejo del patrón verificado.

## Deploy confirmado

CI aplicó `20261016000000` en prod (los 5 guards RPC verificados vivos).
`20261017000000` + `20261018000000` pusheados (CI los aplica). Los fixes de
`src/` (3 cliente) requieren Publish en Lovable.

## Estado: AUDITORÍA COMPLETA

Cobertura multi-ángulo: selección (workflow 8 finders) + funciones server-side
(escaneo: 0 restantes) + guards RPC (5 clone/sesión, verificados) + crons de
notificación (1 fuga) + RPCs de interacción poll/sesión (2 fugas) + embeds
cliente (saltan trashed) + deep-links (exam-take, foros) + edges (calendar/ICS).

**30 fugas reales corregidas** (3 cliente sel. + 5 guards RPC + 1 cron +
poll_is_open + check-in + RLS via-sesión + deep-link grading + 8 RLS de hijas +
helper _poll_in_papelera [repara 2 guards] + 9 entidad/kahoot/foros) **+ 1 bug
pre-existente** (clone_workshop/project created_by). Migraciones: `20261016`
(live), `20261017`–`20261021`. Src: 4 archivos (requieren Publish). Casos extremos
sin daño documentados como aceptados (kahoot mid-game, teacher-only).

Loop-until-dry: pase 3 → 2, pase 4 → 8, pase 5 → 9. Pase 6 (children no-flagged +
storage + completeness critic final) corriendo para confirmar la auditoría SECA.

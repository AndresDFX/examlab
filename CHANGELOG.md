# Changelog

> **Protocolo de trabajo (flujo)** — para Claude y cualquier colaborador:
>
> 1. **Antes de empezar una tarea**, leer este archivo y verificar que lo pedido
>    **no contradiga** una decisión ya tomada (sección "Decisiones / invariantes"
>    abajo). Si contradice, avisar al usuario y proponer cómo reconciliar antes de
>    implementar.
> 2. **Tomar contexto** de este archivo (qué ya se hizo, qué migraciones existen,
>    qué reglas aplican) y de `CLAUDE.md` antes de tocar código.
> 3. **Al terminar una tarea**, agregar una entrada en "Historial" con: qué se
>    pidió, qué se hizo, commit(s), migraciones, y cualquier decisión nueva (que
>    además debe subirse a "Decisiones / invariantes" si es una regla durable).
>
> Formato de fechas: AAAA-MM-DD. Las entradas más recientes van arriba.

---

## Decisiones / invariantes vigentes

Reglas que las tareas futuras NO deben contradecir sin acuerdo explícito:

- **Roles / cursos**
  - Al loguearse, un usuario multi-rol abre por DEFECTO como **Docente** (Docente > Admin > Estudiante). Admin puro abre como Admin. (`AppLayout`, commit `523ffb5`)
  - Un **Docente ve sólo SUS cursos** (los de `course_teachers`) cuando el rol ACTIVO es Docente; Admin/SuperAdmin ven todo el tenant. (`app.admin.courses.tsx`, `fb40899`)
  - Un Docente **no puede auto-asignarse** como docente de un curso existente (RLS `20260966` + filtro UI por rol activo `520a40b`). PERO un Docente que **crea** un curso queda como su docente automáticamente (trigger `tg_course_add_creator_teacher`, `20260963`, SECURITY DEFINER).
- **Estados de curso** (`courses.status`: `borrador | en_curso | finalizado`, mig `20260964`, commit `afbaf99`)
  - `finalizado` se llega SÓLO explícitamente (manual vía `set_course_status`, o cron diario `auto_finalize_courses` cuando `end_date` pasó). NO se infiere "finalizado" de una fecha pasada en la vista.
  - `proximo` es una sub-vista por fecha DENTRO de `en_curso` (no es un estado persistido).
  - Finalizar es acción de docente del curso o Admin/SuperAdmin (validado en la RPC).
- **Filtros de grids**: el filtro de ESTADO abre por defecto en lo vigente/activo (no "Todos"); el usuario puede cambiar a Todos/cerrados. (`c3271a5`)
- **Papelera (soft-delete)**: lo que está en papelera (`deleted_at`) NO se muestra ni cuenta en NINGÚN flujo ni rol (query directa, embed+skip, count, RPC, realtime, edges). (`a4edf79`, mig `20260962`)
- **Escala de calificación**: se hereda de la asignatura/curso; las actividades y la vista de calificaciones deben usar la **escala del curso**, no 100 fijo. *(en progreso — ver Pendientes)*
- **Contenido**: el label de un contenido en el tablero ES el **nombre (`display_name`)**, no el tema (`topic`) — `display_name?.trim() || topic`. El contenido puede asociarse a >1 curso (`content_course_assignments`, vía `ManageContentCoursesDialog`) y a la sección "General" del curso (sin sesión, destino del upload del tablero). El grid de Contenidos muestra filas de **altura estándar** (una línea: nombre + estado + conteos; sin subtítulo del tema). (`f4c396d` + #22)
- **Multi-tenant / RLS**: nunca `USING(true)` ni `has_role()` sin scope de tenant en tablas con datos de tenant (ver `CLAUDE.md`). Migraciones envuelven `ALTER` en guard `to_regclass`.
- **Demo**: tenant `ExamLab Demo` (`729b3114-…`) tiene un curso "Curso de pruebas" con TODOS sus usuarios como docentes (mig `20260965`) — porque los docentes no pueden auto-asignarse.

---

## Historial

### 2026-06-14

Sesión de mejoras amplia (cada ítem = un `/goal` del usuario). Commits sobre `main`.

- **Export Excel de calificaciones — fila de grupo por corte** (#9): `toXLSX` acepta
  `options.groupHeader` opcional → fila extra arriba del header que mapea cada columna
  de item al nombre de su corte. Sólo Excel (CSV sin cambios). `GradeColumn.cutId`
  cargado. Sin items con corte → sin fila de grupo. tests xlsx 15/15.
- **Contenido / tablero**: labels por `display_name` (no `topic`) en tablero docente y
  estudiante; multi-curso vía `ManageContentCoursesDialog` (un contenido en >1 curso,
  visible en cada tablero); destino "General" del upload (ya existía) verificado
  end-to-end. Sin migración de datos (era de visualización). — `f4c396d`
- **Grid de Contenidos a altura estándar**: fila de UNA línea (nombre + estado +
  conteos); se quitó el subtítulo del tema (queda en el tooltip) y el alto fijo h-16. — (#22)
- **CHANGELOG.md** + protocolo: validar contra decisiones previas antes de cada tarea. — `492555a`
- **Diagnóstico (cohortes)**: verificado que la tab Cohortes YA lista el detalle de
  actividades sin cohorte asignada (actividad + cohortes faltantes + alumnos afectados);
  sólo falta Publish. (#24, sin cambio de código)
- **Filtro de estado por defecto = vigente** en grids con filtro de estado
  (estudiante exámenes/talleres/proyectos → "available"; Admin Cursos → nuevo
  filtro con default "en_curso"; Soporte → "active"; Errores → "nuevo"). Conserva
  "Todos"/cerrados. — `c3271a5`
- **Filtro de auto-asignación de docentes por rol ACTIVO** (multi-rol Admin+Docente
  actuando como Docente no ve su checkbox). — `520a40b`
- **Estados de ciclo de vida de curso** (borrador/en curso/finalizado) + auto-finalize
  por fecha (cron) o manual (RPC) + UI (badge, acciones, 5 stat cards) + tab integrada.
  Mig `20260964`. — `afbaf99`
- **Docente no puede auto-asignarse** (drop policy "Docentes manage own course_teachers").
  Mig `20260966`. — `c621cd7`
- **Curso de pruebas demo** con todos los usuarios como docentes (ExamLab Demo).
  Mig `20260965`. — `f487072`
- **Foros**: no muestran sesión en papelera ni la listan en el picker. — `6709b9c`
- **Docente ve sólo sus cursos** + puede editar pizarras de su curso (rama RLS
  course-teacher) + trigger auto-docente al crear curso. Mig `20260963`. — `fb40899`
- **Rol por defecto = Docente** al loguearse (multi-rol). — `523ffb5`
- **Auditoría de papelera** (59 fugas: 27 archivos frontend + edges + RPCs).
  Mig `20260962`. tsc 0, suite 1855/1855. — `a4edf79`
- **Diagnóstico de curso**: tab "Cobertura de pesos" (% sin asignar por corte/bucket
  + total del curso). — `c1545a4`
- **Export de calificaciones**: agrupado por cohorte + % de cada item en encabezados
  (CSV + Excel). — `191e633`
- **Dashboard Admin**: "Por calificar" y "Cursos" excluyen cursos en papelera. — `ed3b4e7`
- **Conteo "por calificar"**: no contar exámenes ya calificados a mano (`final_override_grade`)
  ni talleres/proyectos calificados por IA. — `48f2cfe`
- **Datos Camacho**: removido usuario huérfano `e8b3c430` (sin perfil) de course_teachers
  + course_enrollments de 2 cursos → 1 docente / 17 estudiantes (vía REST como Admin).
- **Local**: fuente Nerd Font del terminal VS Code (`settings.json` → MesloLGLDZ Nerd Font Mono).

#### En progreso / pendiente (workflows en cola)

- Contenido: usable en >1 curso a nivel de tablero + label por `display_name` (no `topic`)
  + asociar a sección "General" + corregir datos FESNA. *(workflow en curso)*
- Grid de Contenidos: filas a altura estándar (recortar info redundante).
- Export Excel de calificaciones: fila que agrupe cada entregable por su corte.
- Validación front: fecha fin ≥ fecha inicio en todos los flujos (iguales permitido).
- Aviso "¿seguir editando?" (cambios sin guardar) en todos los flujos de crear/editar.
- Admin: ver el diagnóstico de TODOS los cursos del tenant.
- Generar Kahoot con IA leyendo el contenido del curso (de una sesión o todo) + asociar a sesión.
- Consistencia de escala: actividades/calificaciones siempre en la escala del curso (no 100) + migrar datos.
- Editar el peso/corte por curso de talleres/proyectos asociados a >1 curso (como en creación).

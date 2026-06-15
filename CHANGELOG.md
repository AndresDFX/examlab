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
- **Escala de calificación**: se hereda de la asignatura/curso; la vista de calificaciones muestra SIEMPRE la escala del curso. La "Nota" usa `toScale(raw, max_score)`; el "Puntaje" se normaliza a `grade_scale_max` en PRESENTACIÓN (`rescaleScore`), sin tocar datos. NO normalizar `max_score` de items legacy por migración masiva (riesgo de re-interpretar notas bajas de items /100). Items nuevos default `max_score = grade_scale_max`.
- **Finalizar curso exige SIN pendientes de calificación** (mig 20260972): `set_course_status`→finalizado RAISE si hay pendientes; `auto_finalize_courses` (cron) no finaliza cursos vencidos con pendientes y notifica a sus docentes. "Pendiente" = lógica del Diagnóstico (`course_pending_grading_count`). Esa función es **interna** (SECURITY DEFINER, SIN GRANT a `authenticated` desde mig `20260974` — los callers internos la conservan); NO invocarla desde el cliente.
- **Items SIN corte (`cut_id NULL`)**: cuentan en la NOTA FINAL del curso con su peso, tanto en el gradebook docente como en la vista del estudiante (paridad con el número del certificado). La tarjeta "Sin corte" del estudiante es informativa pero su nota SÍ entra al weighted avg. (`app.teacher.gradebook.tsx`, `app.student.grades.tsx`, fix #0)
- **Informes: Plantilla ≠ Informe generado** (mig `20260975`). La **Plantilla** (`report_templates`) es el blueprint reutilizable; el **Informe generado** (`generated_reports`) es la instancia con datos reales (snapshot HTML, descargable Word/PDF), persistida con historial. "Generar" produce el archivo descargable (Word vía MSO-HTML `.doc` o PDF vía impresión), es acción de DOCENTE (RLS: docente del curso / Admin del tenant / SA; el estudiante nunca lo ve; inmutable). Los saltos de página de Word se preservan al importar `.docx` y se ven como divisor "Salto de página" en pantalla + corte real en PDF/Word (marcador `.examlab-page-break`). UI del docente en 2 tabs: "Plantillas" / "Informes generados". **Importar `.docx`** captura cuerpo + **cabecera + pie** con **imágenes embebidas como data URI** (`parseDocxBundle` → `header_html`/`footer_html`/`body_html`); el preview del editor se renderiza como **hojas de página** ("Página N") y la exportación incluye el documento original completo + las `{{variables}}` (no sólo lo nuevo).
- **Item compartido (M:N) en >1 curso**: su nota debe verse en CADA curso al que pertenece (`workshop_courses`/`project_courses`), no solo en el curso ancla; el peso/corte es por curso. *(en refinamiento — #30/#31)*
- **Contenido**: el label de un contenido en el tablero ES el **nombre (`display_name`)**, no el tema (`topic`) — `display_name?.trim() || topic`. El contenido puede asociarse a >1 curso (`content_course_assignments`, vía `ManageContentCoursesDialog`) y a la sección "General" del curso (sin sesión, destino del upload del tablero). El grid de Contenidos muestra filas de **altura estándar** (una línea: nombre + estado + conteos; sin subtítulo del tema). (`f4c396d` + #22)
- **Multi-tenant / RLS**: nunca `USING(true)` ni `has_role()` sin scope de tenant en tablas con datos de tenant (ver `CLAUDE.md`). Migraciones envuelven `ALTER` en guard `to_regclass`.
- **Demo**: tenant `ExamLab Demo` (`729b3114-…`) tiene un curso "Curso de pruebas" con TODOS sus usuarios como docentes (mig `20260965`) — porque los docentes no pueden auto-asignarse.

---

## Historial

### 2026-06-15

**Auditoría funcional #39 (workflow) — fixes de seguridad y correctitud.** El
workflow halló 53 candidatos → 36 confirmados. Se corrigió el subconjunto de
ALTA + las MEDIA de seguridad/correctitud + cheap-code; el resto (safe-failing
o de mayor riesgo) queda registrado abajo como **diferido**.

Corregido (commit pendiente):

- **#0 ALTA — divergencia nota final docente↔estudiante con items SIN corte**:
  el gradebook docente incluye TODOS los items en la nota final (y el
  certificado usa ese número), pero la vista del estudiante excluía los items
  con `cut_id NULL` (vivían en "Sin corte" como informativos). Ahora el
  estudiante también los suma al weighted avg → paridad con docente/certificado.
  (`app.student.grades.tsx`)
- **#1/#25 MEDIA — fuga cross-tenant**: `course_pending_grading_count(uuid)`
  (mig `20260972`) era SECURITY DEFINER + GRANT authenticated SIN authz → cualquier
  autenticado leía el conteo de pendientes de cualquier curso/tenant. `REVOKE`
  (los llamadores internos SECURITY DEFINER conservan EXECUTE). Mig `20260974`.
- **#3 MEDIA — `content_course_assignments`**: políticas WRITE/SELECT con
  `has_role` SIN scope de tenant → Admin de tenant A podía asociar material a
  curso de tenant B. Scopeadas con `course_in_my_tenant`. Mig `20260974`.
- **#4 MEDIA — `workshop_courses`**: la política tenant-scoped de `20260528`
  nunca se aplicó (la tabla se creó después, en `20260704`) → quedó viva la WRITE
  bare-`has_role` (leak cross-tenant de binding taller↔curso + weight/cut).
  Re-aplicado el scope (`workshop_courses_staff_manage`/`_select_in_tenant`).
  Mig `20260974`.
- **#16 MEDIA — `get_course_cohort_weights` mostraba DRAFT**: el tablero del
  estudiante listaba actividades/% aún no publicadas (las filas `*_assignments`
  existen desde la creación, incluso en borrador). Filtro `status <> 'draft'`.
  Mig `20260974`.
- **#21/#27 BAJA — curso demo oculto**: el "Curso de pruebas" se sembró sin
  `status` → heredó `borrador` y quedaba oculto bajo el filtro por defecto
  `en_curso`. `UPDATE` a `en_curso` (idempotente). Mig `20260974`.
- **#28/#30 BAJA — TZ off-by-one en `deriveCourseDisplayState`**: DATE-only se
  parseaba como medianoche UTC → en es-CO un curso que empieza "hoy" se
  clasificaba mal las primeras horas. Anclado a mediodía local (patrón
  `formatDateOnly`). + test de regresión TZ-independiente. (`course-status.ts`)
- **#19 BAJA — columna "Asistencia (0%)" espuria** en export: `cutHasAttendance`
  usaba `!= null` en vez de `> 0`. (`app.teacher.gradebook.tsx`)
- **#9 MEDIA — `.xlsx` inválido por chars de control**: `xmlEscape` no eliminaba
  los caracteres prohibidos por XML 1.0 (un nombre con control char tras CSV mal
  formado generaba un archivo que Excel no abría). Strip antes de escapar.
  (`xlsx.ts`)

Diferido (registrado, no corregido en este commit):

- **#5/#29 — colisión de claves en export Excel/CSV** cuando 2 items comparten
  label (mismo título+peso+tipo en cortes distintos): requiere refactor de
  `toXLSX` para usar id estable como key y label sólo como header.
- **#6/#8 — atribución de items COMPARTIDOS/GRUPO** en dashboards y gradebook
  (un workshop/project compartido se atribuye a UN solo curso; entregas de grupo
  sólo cuentan al "último editor"). Pre-existente, más visible con la feature de
  cursos compartidos.
- **#10/#11/#17 — validación/resolución de peso POR-CURSO** en talleres/proyectos
  multi-curso usa columnas legacy en vez de `*_courses` (sólo afecta validación
  de bucket y el caso `weight NULL` en curso secundario).
- **#12–#15 — `useDirtyDialog`**: spurious-dirty al abrir para editar (polls,
  EditExternalContent) + estados fuera de `form` no observados (videos intro,
  cursos, pesos por-curso en workshops/projects). Safe-failing (peor caso: prompt
  "¿descartar?" de más o guardia omitida — nunca corrupción). Requiere verificar
  timing de hidratación por diálogo.
- **#2 — `notify_teachers_daily_summary`** cuenta entregas con status en inglés
  (`'submitted','in_progress'`) que nunca matchean el dominio español → el conteo
  de talleres/proyectos del digest diario es siempre 0. Pre-existente; bajo impacto.
- Varios BAJA de borde: #18/#31 (presentación de items external/`max_score=0`),
  #20/#22/#23/#24/#26/#32/#33/#34/#35.

Validación: `tsc` EXIT 0; tests afectados (xlsx + course-status + cohort-weights)
verdes (course-status 13/13 con el nuevo test TZ).

**Refactor del módulo Informes — Plantilla ≠ Informe generado, claridad de
páginas, descarga Word/PDF.** (commit pendiente)

- **Páginas claras al editar un .docx**: el importador (`docx-import.ts`) ahora
  detecta los saltos de página de Word (`<w:br w:type="page"/>` y el hint
  `<w:lastRenderedPageBreak/>`) y los traduce a un marcador
  `<div class="examlab-page-break">`. `composeTemplateHtml` lo convierte en un
  corte REAL en impresión/PDF/Word (`page-break-after`) y en un divisor visible
  "Salto de página" en pantalla (`@media screen`) — antes el .docx se veía como
  un bloque continuo sin saber dónde cambiaba la página. + tests.
- **"Generar" = archivo descargable (Word o PDF)**: nuevo
  [report-download.ts](src/modules/reports/report-download.ts) — Word vía técnica
  HTML-como-Word (MSO, sin librerías, `.doc` editable que respeta `@page` +
  saltos) y PDF vía impresión en iframe oculto. El generador ahora muestra
  "Vista previa" + "Descargar Word" + "Descargar PDF" (antes sólo "Imprimir/PDF").
  El flujo es de DOCENTE, nunca de estudiante (RLS lo refuerza).
- **Plantilla vs Informe generado**: nueva tabla `generated_reports` (mig
  `20260975`) que persiste cada informe generado (plantilla + curso/estudiante/
  periodo + snapshot HTML + quién/cuándo). RLS: sólo docente del curso / Admin
  del tenant / SA (scopeada con `course_in_my_tenant`); inmutable (sin UPDATE);
  el estudiante NO la ve. La pantalla del docente se reorganizó en 2 **tabs**:
  "Plantillas" (gestionar blueprints) e "Informes generados" (actas + historial
  con re-descarga Word/PDF + eliminar). Persistir ocurre al descargar (una fila
  por generación, dedupe Word+PDF del mismo preview).

Validación: `tsc` EXIT 0; tests de reports 85/85; locale-parity 7/7 (17 claves
nuevas en es+en).

**Importar .docx — cabeceras con imagen, páginas claras y export completo.**
(commit pendiente) Refuerza el flujo de IMPORTAR un Word a una plantilla:

- **Cabeceras/pies con imágenes**: el importador (`docx-import.ts`) ahora
  extrae también la CABECERA y el PIE del .docx (vía `<w:sectPr>` →
  `headerReference`/`footerReference`, o fallback `header1.xml`/`footer1.xml`)
  y **embebe las imágenes** (logo institucional) como data URI — resolviendo
  rId → rels → `word/media/*` y base64. Las celdas de tabla se renderizan con
  su contenido real (imágenes + negrita + alineación `<w:jc>`), no sólo texto;
  los bordes se respetan sólo si la tabla/celda los declara. Así una cabecera
  "logo | título | versión" aparece en el preview y al exportar. `parseDocxBundle`
  devuelve `{ bodyHtml, headerHtml, footerHtml }`; los handlers de importar
  (docente + admin) pueblan `header_html`/`footer_html`, no sólo `body_html`.
- **Páginas claras al editar**: el preview del editor (`composePreviewHtml`) se
  rediseñó como **hojas de página** separadas (una por bloque entre saltos),
  cada una con etiqueta "Página N", tamaño real de hoja (mm según size/orient.)
  y cabecera/pie repetidos — antes se veía todo el contenido junto sin saber
  qué texto caía en cada página.
- **Export = antiguo + nuevo**: al poblar `header_html`/`footer_html` en la
  importación (y persistirlos en `report_templates`), la generación/exportación
  (`composeTemplateHtml` → `<header>`+`<main>`+`<footer>`) ahora incluye el
  documento ORIGINAL completo (logo/cabecera/cuerpo del .docx) MÁS las
  `{{variables}}` que agregó el docente. Antes sólo exportaba lo nuevo porque
  la cabecera/pie nunca se importaban.

Validación: `tsc` EXIT 0; tests de reports 97/97 (docx-import con casos de
cabecera+imagen+alineación; preview con hojas de página); locale-parity 7/7.

### 2026-06-14

Sesión de mejoras amplia (cada ítem = un `/goal` del usuario). Commits sobre `main`.

> ⚠️ **PENDIENTE DE PUBLISH (Lovable):** varios fixes son de código/migración y
> sólo se ven tras **Publish**. En particular el fix de **talleres COMPARTIDOS**
> (`6912b4b`) resuelve #35/#36 (la nota del Taller Final no aparecía en Seminario)
> — el dato está sano, falta deploy. Migraciones nuevas: 20260962–20260973.

- **Colores en el Excel de calificaciones** (#38): estilos OOXML opcionales en
  xlsx.ts (6ª parte sólo si se usan; byte-idéntico sin estilos) + encabezado/grupo/
  verde-aprobado/rojo-reprueba como el grid. — `b8fe520`
- **i18n: consolidación** de 35 claves defaultValue de la sesión en es+en (7680/7680). — `81b2a76`
- **Aviso "cambios sin guardar"** (#11b) extendido a 12 diálogos de crear/editar. — `0dce3be`
- **Tablero del estudiante: evaluación por cohorte** (#33): RPC SECURITY DEFINER
  get_course_cohort_weights + helper + panel (qué actividades/% aplican a cada
  cohorte). Mig 20260973. — `c1e3d63`
- **Item COMPARTIDO muestra nota en AMBOS cursos** (#30/#31/#35/#36): talleres se
  cargaban por ancla legacy; ahora via workshop_courses (grades + gradebook +
  cut-detail). Datos VetCare/Taller Final sanos. — `6912b4b` *(requiere Publish)*
- **Crash al ordenar grilla de talleres por Corte** (#32, TDZ cuts) — `1f681e8`. +
  fix `<strong>` literal en weightBucketDesc/weightAvailable (#27/#34) — `3162b8a`,`985ccba`.
- **Finalizar curso exige sin pendientes** (#29, mig 20260972) — `b1ef9cd`.
- **Datos Camacho**: Taller Final compartido a 2 cursos (Corte 3, 15% c/u) vía REST (#28).

> **Paralelización (#25):** desde acá los workflows con archivos de código DISJUNTOS
> corren EN PARALELO usando `t(..., {defaultValue})` (sin editar locales) para no
> chocar en `es.json`/`en.json`; un pase final consolida las claves. Se corrieron
> hasta 3 workflows a la vez.

- **Kahoot con IA desde el contenido del curso** (#18): elegir curso + fuente
  (una sesión / todo); la edge lee el material real y genera las preguntas; si es
  de una sesión, el Kahoot queda asociado a ella. — `d5f084f`
- **"Puntaje" siempre en escala del curso** (#19, presentación, sin tocar notas) +
  **editar peso por curso** en talleres compartidos (#21). — `917d134`.
  ⚠️ **Se DESCARTÓ** la migración que normalizaba `max_score` a la escala del curso:
  su heurística ("notas ≤ escala se asumen ya en escala del curso") podía
  RE-INTERPRETAR notas bajas de items /100 (4/100 ≈ 0,2/5 → 4/5), cambiando notas
  finales. El fix de presentación resuelve el síntoma sin riesgo. Si se quiere
  normalizar `max_score`, hacerlo per-tenant verificando que no haya notas 0<g≤escala
  en items /100.
- **Finalizar curso (auto/manual) exige no tener pendientes de calificación** (#29):
  manual → RAISE; auto (cron) → no finaliza + notifica a los docentes. Mig 20260972. — `b1ef9cd`
- **Fix #27**: `weightBucketDesc` mostraba `<strong>` literal (i18n vía t() escapa); tags
  quitados en es+en. — `3162b8a`
- **Validación fecha fin ≥ fecha inicio** (#10, iguales permitido): helper
  `isValidDateRange` + aplicado en cortes/curso, exámenes (create+edit), talleres,
  proyectos, periodos académicos. — `b30101e`
- **Excel calificaciones: cortes COMBINADOS** (#26): `mergeCells` por corte +
  columna de asistencia por corte + etiqueta "Corte N (peso%)". — `41f0e37`
- **Dashboard Admin: diagnóstico de TODOS los cursos del tenant** (#8): stat
  "Por calificar" clickeable → modal con todos los cursos → CourseDiagnosticDialog. — `567935d`
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

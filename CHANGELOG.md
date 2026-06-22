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
  - **Cascade al finalizar** (mig `20260991000000`): un trigger `AFTER UPDATE OF status` cierra en cascada lo asociado — exámenes/pizarras (`status='closed'`), talleres/proyectos/encuestas (cerrados SOLO si NINGÚN otro curso ligado sigue `<> 'finalizado'` — caveat M:N), foros (`manually_closed_at`), juegos Kahoot en vivo (`ended`), ventanas de check-in QR. NO cierra sesiones de asistencia ni contenidos/videos (histórico/consultable). NO auto-reabre al reabrir el curso. Funciones `close_*_for_course` son `SECURITY DEFINER` y **REVOCADAS de PUBLIC** (internas). Al agregar una entidad nueva ligada a curso con estado cerrado, sumar su `close_*` al orquestador.
- **Filtros de grids**: el filtro de ESTADO abre por defecto en lo vigente/activo (no "Todos"); el usuario puede cambiar a Todos/cerrados. (`c3271a5`)
- **Papelera (soft-delete)**: lo que está en papelera (`deleted_at`) NO se muestra ni cuenta en NINGÚN flujo ni rol (query directa, embed+skip, count, RPC, realtime, edges). (`a4edf79`, mig `20260962`)
- **Escala de calificación**: se hereda de la asignatura/curso; la vista de calificaciones muestra SIEMPRE la escala del curso. La "Nota" usa `toScale(raw, max_score)`; el "Puntaje" se normaliza a `grade_scale_max` en PRESENTACIÓN (`rescaleScore`), sin tocar datos. NO normalizar `max_score` de items legacy por migración masiva (riesgo de re-interpretar notas bajas de items /100). Items nuevos default `max_score = grade_scale_max`.
- **Finalizar curso exige SIN pendientes de calificación** (mig 20260972): `set_course_status`→finalizado RAISE si hay pendientes; `auto_finalize_courses` (cron) no finaliza cursos vencidos con pendientes y notifica a sus docentes. "Pendiente" = lógica del Diagnóstico (`course_pending_grading_count`). Esa función es **interna** (SECURITY DEFINER, SIN GRANT a `authenticated` desde mig `20260974` — los callers internos la conservan); NO invocarla desde el cliente.
- **Items SIN corte (`cut_id NULL`)**: cuentan en la NOTA FINAL del curso con su peso, tanto en el gradebook docente como en la vista del estudiante (paridad con el número del certificado). La tarjeta "Sin corte" del estudiante es informativa pero su nota SÍ entra al weighted avg. (`app.teacher.gradebook.tsx`, `app.student.grades.tsx`, fix #0)
- **Informes: Plantilla ≠ Informe generado** (mig `20260975`). La **Plantilla** (`report_templates`) es el blueprint reutilizable; el **Informe generado** (`generated_reports`) es la instancia con datos reales (snapshot HTML, descargable Word/PDF), persistida con historial. "Generar" produce el archivo descargable (Word vía MSO-HTML `.doc` o PDF vía impresión), es acción de DOCENTE (RLS: docente del curso / Admin del tenant / SA; el estudiante nunca lo ve; inmutable). Los saltos de página de Word se preservan al importar `.docx` y se ven como divisor "Salto de página" en pantalla + corte real en PDF/Word (marcador `.examlab-page-break`). UI del docente en 2 tabs: "Plantillas" / "Informes generados". **Importar `.docx`** captura cuerpo + **cabecera + pie** con **imágenes embebidas como data URI** (`parseDocxBundle` → `header_html`/`footer_html`/`body_html`); el preview del editor se renderiza como **hojas de página** ("Página X de N") con las **variables YA RESUELTAS** (datos de muestra o la marca real del tenant — el logo se ve, no `{{tokens}}`), y la exportación incluye el documento original completo + las `{{variables}}` (no sólo lo nuevo). La **Generación IA** vive en el panel de Variables disponibles (derecha) e inserta el contenido EXACTAMENTE en el cursor (`onAiGenerate` + `RichTextEditor.insertHtml`), NO como botón global que reemplaza el cuerpo. Su system prompt es **configurable** (`ai_prompts.use_case='report_generation'`, mig `20260976`), resuelto por el edge `ai-generate-report` (course→tenant→platform→FALLBACK). El texto default DEBE quedar **byte-idéntico** en 4 lugares: `DEFAULT_REPORT_GENERATION_PROMPT` (template-engine.ts), el seed de la mig `20260976`, el `FALLBACK_REPORT_PROMPT` del edge, y el `defaultPrompt` del `AdminPromptsPanel`. La generación inline manda `draftText:""` (fragmento, no reescritura) para no exceder el tope de 200K del edge (`prompt_too_large`). El **preview usa DATOS REALES** de un curso/estudiante elegido (selector en la pestaña Vista previa; estudiante seleccionable en scope estudiante), no mock. La **descarga Word es `.docx` OOXML real** (`html-to-docx.ts`): cabecera en `word/header1.xml` (área de encabezado, se repite por página), pie en `word/footer1.xml`, imágenes en `word/media/*`, tablas con `tblGrid`/`gridSpan`. El PDF pone header/footer `position:fixed` en `@media print`. En el editor visual, las variables/IA insertadas se marcan con `.examlab-added` (color sólo en el editor). Nombres de plantilla únicos (auto-sufijo) + nombre de archivo de informe con `fileStamp`.
- **Item compartido (M:N) en >1 curso**: su nota debe verse en CADA curso al que pertenece (`workshop_courses`/`project_courses`), no solo en el curso ancla; el peso/corte es por curso. *(en refinamiento — #30/#31)*
- **Contenido**: el label de un contenido en el tablero ES el **nombre (`display_name`)**, no el tema (`topic`) — `display_name?.trim() || topic`. El contenido puede asociarse a >1 curso (`content_course_assignments`, vía `ManageContentCoursesDialog`) y a la sección "General" del curso (sin sesión, destino del upload del tablero). El grid de Contenidos muestra filas de **altura estándar** (una línea: nombre + estado + conteos; sin subtítulo del tema). (`f4c396d` + #22)
- **Multi-tenant / RLS**: nunca `USING(true)` ni `has_role()` sin scope de tenant en tablas con datos de tenant (ver `CLAUDE.md`). Migraciones envuelven `ALTER` en guard `to_regclass`.
- **Demo**: tenant `ExamLab Demo` (`729b3114-…`) tiene un curso "Curso de pruebas" con TODOS sus usuarios como docentes (mig `20260965`) — porque los docentes no pueden auto-asignarse.

---

## Historial

### 2026-06-19

**Validación e2e post-Publish + hotfix de seguridad del cascade.**
Tras publicar, validé en vivo (Demo Global Corp) lo que estaba pendiente:
- **Kahoot P0** ✓: responder durante el splash "¡Prepárate!" ahora se **rechaza**
  ("La pregunta aún no está abierta", HTTP 400); tras el lead se acepta normal.
- **Kahoot P1** ✓: `kahoot_my_live_games` devuelve el juego con título (el banner
  ya descubre Kahoots aunque estén en borrador).
- **Cascade** ✓ (7/7): finalizar un curso cerró su examen (`status=closed`),
  pizarra (`status=closed`) y encuesta (`closed_manually=true`).
- 🔴 **Hallazgo de seguridad → hotfix** (mig
  [20260993000000](supabase/migrations/20260993000000_cascade_close_revoke_authenticated.sql)):
  las 7 funciones `close_*_for_course` (SECURITY DEFINER, internas) eran
  **ejecutables por `authenticated`** pese al `REVOKE FROM PUBLIC` — en Supabase
  `authenticated`/`anon` tienen EXECUTE concedido aparte. Cualquier usuario podía
  cerrar contenido de otro curso/tenant (escritura cross-tenant). Fix: `REVOKE`
  también de `authenticated` y `anon`. El trigger sigue funcionando (corre como
  owner). **Requiere un nuevo Publish.**

**Revisión e2e por módulo (loop "siguiente módulo y rol") — Asistencia + Foros.**
Pasadas de revisión e2e en vivo (Demo Global Corp, sin IA/costo):
- **Asistencia** (docente+estudiante): el invariante crítico `compute_attendance_code`
  (SQL) ↔ `computeAttendanceCode` (JS) verificado **bit-a-bit** en 5 casos; RPCs
  `teacher_open/close_attendance_check_in` + `student_check_in_attendance` vivas; el
  guard `check_in_closed` funciona. **Limpio, sin cambios.**
- **Foros** (docente+estudiante): el invariante de "foro abierto" en 3 capas
  (`is_forum_open` SQL ↔ `isForumOpen` ↔ `computeForumState`) verificado en vivo
  (4 estados: abierto/programado/auto-cerrado/cierre-manual, SQL==JS) y estático.
  Único hallazgo: `src/modules/forum/forum-state.ts` no tenía tests (helper puro
  correctness-critical) → se agregaron ([forum-state.test.ts](src/modules/forum/forum-state.test.ts), 8 casos).

**Kahoot — fixes de la auditoría adversarial de los 6 ajustes (workflow + e2e).**
Una auditoría por workflow (1 agente por ajuste) + e2e live (Demo Global Corp)
destapó 3 issues reales en los ajustes ya implementados (commit `2fbfd291`):
- **P0 (integridad de puntaje)** — `kahoot_submit_answer` no rechazaba responder
  mientras `now() < question_started_at`. Con el lead de 3s de "¡Prepárate!"
  (mig `20260989`), responder durante el splash daba **puntaje máximo**
  (`elapsed = GREATEST(0, now-started) = 0`). Fix: guard `IF now() <
  question_started_at THEN RAISE` (mig
  [20260992000000](supabase/migrations/20260992000000_kahoot_audit_fixes.sql)).
- **P1 (banner inoperante en el caso típico)** — `KahootLiveBanner` y
  `KahootJoinCard` descubrían juegos con embed `poll:polls(...)`, pero la RLS de
  `polls` del alumno exige `is_published=TRUE` y un Kahoot se hospeda **en
  borrador** → el embed volvía `null` y se descartaba el juego: la notificación
  **nunca aparecía** (ni el botón reconectar). Fix: nueva RPC
  `kahoot_my_live_games()` `SECURITY DEFINER` (trae los juegos vivos de mis
  cursos con título, bypassa esa RLS, guard de papelera + `_poll_has_member`);
  el banner y el card ahora la usan.
- **P2 (default 20s incompleto)** — dos flujos reinyectaban `time_limit_seconds=10`
  saltándose el DEFAULT: el edge `ai-generate-questions` (ahora omite la columna)
  y `add_questions_from_bank_to_kahoot` (CREATE OR REPLACE en `20260992` que omite
  la columna → hereda el DEFAULT 20).
- **Menores**: gate del splash con `nowMs>0` (evita un frame con número gigante);
  tests de `getReadySecondsLeft`; 4 claves i18n del banner (es+en).
- **Confirmado OK por la auditoría** (sin cambios): animaciones (tw-animate-css),
  responders-by-option (privacidad host-only server-side), gating del banner. El
  join 1-click sin PIN se confirma como decisión de producto intencional.

**Cascade de cierre al finalizar un curso.**
Cuando un curso pasa a `status='finalizado'` (por `set_course_status` manual O
por el cron `auto_finalize_courses` — ambos hacen `UPDATE courses.status`), todo
lo asociado pasa a su estado CERRADO, sobre todo para que en cada módulo **lo
cerrado deje de aparecer en los listados activos** por defecto. Diseño vía
workflow (8 agentes mapearon entidad×vista). Mig
[20260991000000](supabase/migrations/20260991000000_cascade_close_on_course_finalized.sql):
- **UN trigger** `AFTER UPDATE OF status ON courses WHEN (NEW='finalizado' AND
  OLD IS DISTINCT FROM 'finalizado')` → 7 funciones `close_*_for_course`
  (`SECURITY DEFINER`, **REVOKE de PUBLIC** — internas; sin eso un authenticated
  podría cerrar contenido de otro curso/tenant). Cada paso en su propio
  `BEGIN/EXCEPTION`: un fallo de cascade NUNCA aborta la finalización del curso.
- **Cascadea**: exámenes (1:1) y pizarras (1:1) → `status='closed'`; talleres,
  proyectos y encuestas/Kahoot (**M:N**) → cerrados SOLO si ningún otro curso
  ligado sigue `<> 'finalizado'`; Kahoot en vivo → `status='ended'`; foros →
  `manually_closed_at` (bloquea postear, el historial se sigue leyendo);
  ventanas de check-in QR abiertas → cerradas (NO se borran/cierran sesiones —
  su histórico es necesario para la nota por corte).
- **NO cascadea**: `attendance_sessions` (date-based, sin estado closed; el
  histórico debe preservarse), `generated_contents`/`videos` (sin estado closed;
  desvincular sería destructivo y el material debe seguir consultable).
- **NO auto-reabre**: la transición `finalizado→en_curso` no dispara nada
  (reabrir es granular y deliberado por ítem). Idempotente (re-finalizar no
  re-toca). Defensiva `to_regclass` en cada función + en el `CREATE TRIGGER`.
- **Front**: los grids docentes de exámenes/talleres/proyectos/pizarras ya
  ocultan `closed` por defecto (`matchesActivityStatus`) → caen solos al
  cerrarse. Se agregó filtro de estado (Abiertas/Cerradas/Todas, default
  "abiertas") al grid docente de encuestas ([app.teacher.polls.tsx](src/routes/app.teacher.polls.tsx))
  — era el único módulo docente que no ocultaba lo cerrado.
- **Nota de producto**: cerrar encuestas con `results_visible_to_students='after_close'`
  revela los conteos al alumno (esperable en un curso finalizado; documentado).

**Pizarras — estado (borrador / activa / cerrada).**
Las pizarras (`whiteboards`) ahora tienen `status` con el MISMO vocabulario que
exámenes/talleres/proyectos (`draft | published | closed`, mig
[20260990000000](supabase/migrations/20260990000000_whiteboards_status.sql),
DEFAULT `published` → las existentes quedan activas sin backfill). Esto reusa el
filtro compartido `matchesActivityStatus` (default oculta cerradas), el
`StatusBadge` y el `ActivityStatusSelect`.
- **Docente** ([app.teacher.whiteboards.index.tsx](src/routes/app.teacher.whiteboards.index.tsx)):
  filtro de estado (Activos/Cerrados/Todos, default oculta cerradas) + columna
  `StatusBadge` + acción de fila **Cerrar / Reabrir** (alterna published↔closed) +
  4ª stat-card "Cerradas" (reemplaza "En curso"). Cerrar saca la pizarra del
  listado activo sin borrarla (para archivar de verdad está la Papelera).
- **Estudiante** ([app.student.whiteboards.index.tsx](src/routes/app.student.whiteboards.index.tsx)):
  una pizarra cerrada NO se le muestra (nullish ⇒ published).
- Base para que al cerrar un curso, sus pizarras (y demás) pasen a `closed` y
  desaparezcan del listado activo.

**Pizarra (Excalidraw) — paleta de figuras estilo draw.io (categorías + miniaturas).**
El panel "Figuras" agrupaba por tema pero era una lista de TEXTO en un panel
angosto — no se veía qué era cada figura ni quedaba claro qué grupo es para un
diagrama de clases. Rehecho ([WhiteboardEditor](src/modules/whiteboard/WhiteboardEditor.tsx)
+ [excalidraw-libraries.ts](src/modules/whiteboard/excalidraw-libraries.ts)):
- **Secciones por TIPO DE DIAGRAMA** con ícono + nombre explícito + descripción
  "para qué sirve" + conteo, **colapsables** (acordeón). Orden: **Diagrama de
  clases (UML)** primero (clase/interfaz/abstracta/enum/herencia), luego Diagrama
  de flujo, Entidad–Relación / BD, Estructuras de datos, Arquitectura AWS.
- **Miniatura SVG de cada figura** (se VE qué es, como en draw.io). Helper PURO
  `libraryItemPreview(elements, boxW, boxH)` que escala los elementos del template
  a una caja, mantiene aspecto y mapea rect/ellipse/diamond/line/arrow/text a
  primitivas SVG (sin rough.js ni dependencias). Strokes con `currentColor`
  (respeta tema claro/oscuro). Tests del helper + metadata de categorías.
- Panel más ancho (`w-72`), grilla de 2 columnas, responsive (`max-w-[calc(100vw-1rem)]`).
- Sin migración ni cambios de DB — es solo front de la pizarra.

**Kahoot en vivo — experiencia mejorada (5 frentes).**
- **Notificación global persistente + "login directo"** ([KahootLiveBanner](src/modules/polls/KahootLiveBanner.tsx), montado en [AppLayout](src/shared/components/AppLayout.tsx)): cuando hay un Kahoot en vivo en un curso del alumno, una barra animada arriba (en CUALQUIER pantalla) lo invita a entrar con **un click** — su cuenta institucional ES la credencial (matrícula), sin teclear PIN. Nueva RPC `kahoot_join_game_by_id` (mismos guards que `kahoot_join_game`: tenant, matrícula, host presente + lobby para nuevos, papelera, ended) — el PIN sigue para el QR / ingreso manual. La barra se auto-oculta dentro de la vista del juego y no aparece durante un examen.
- **Cuenta regresiva "¡Prepárate!" + más animaciones** (Parts 3): `kahoot_advance_game` fija `question_started_at` 3s en el FUTURO; mientras tanto host y alumno ven un splash animado de cuenta regresiva (sin opciones). El cronómetro y la ventana de respuesta del servidor arrancan recién en ese instante, así que la espera NO le come tiempo a nadie (`secondsLeft` devuelve el límite completo; el server computa `elapsed=GREATEST(0,…)`). Transiciones de fase con `animate-in` (fade/zoom/slide) + pulso del cronómetro en los últimos 5s. Helper `getReadySecondsLeft` en [kahoot.ts](src/modules/polls/kahoot.ts).
- **Tiempo por defecto 20s** (Part 4): `kahoot_questions.time_limit_seconds` DEFAULT 10→20 + `blankQuestion()` del editor a 20.
- **Por opción, quién respondió** (Part 5): `kahoot_get_state` agrega `responders_by_option` (SOLO host; se atribuye por `option_ids`, cubre single y multi) → el host ve bajo cada opción los nombres de quienes la eligieron, en vivo y al revelar. Los alumnos NO lo reciben (no se filtran respuestas ajenas).
- Migración [20260989000000_kahoot_live_experience.sql](supabase/migrations/20260989000000_kahoot_live_experience.sql) (default 20s + lead de inicio en `kahoot_advance_game` + `kahoot_join_game_by_id` + `responders_by_option` en `kahoot_get_state`).
- Fix colateral: anotación de tipo en el `.map` del filtro de cursos en papelera de [app.teacher.polls.tsx](src/routes/app.teacher.polls.tsx) (implicit-any que rompía `tsc`, introducido en `6a1977b6`).

### 2026-06-18

**Encuestas MIXTAS — nuevo `poll_type='mixed'` con mix de preguntas (abiertas + cerradas).**
Una encuesta puede ahora tener N preguntas de distintos tipos, como un taller:
`abierta` (texto libre, con tope opcional de caracteres) y `cerrada` (opción
única). El modelo plano legacy (`single`/`multiple`/`slot`/`kahoot` sobre
`poll_options`/`poll_responses`/`kahoot_*`) **coexiste intacto — cero migración
de datos**; `poll_type` bifurca a las tablas hijas nuevas.
- **DB** (migs `20260983000000` enum `mixed` aislado + `20260984000000` tablas
  `poll_questions`/`poll_question_responses` + RLS, + `20260985000000` RPCs/triggers):
  RLS reusa los helpers `_poll_*` AÑADIENDO guard de papelera (`deleted_at`).
  Respuestas con **write directo DENEGADO** (solo vía RPC). `poll_question_responses`
  NO se publica a realtime ni tiene `REPLICA IDENTITY FULL` (privacidad de las
  respuestas abiertas). RPCs `submit_poll_question_response` (guards: papelera,
  publicada, abierta, matrícula multi-curso vía `_poll_has_member`,
  `allow_change_response` SOLO para cerradas ANTES del upsert, rango de
  `selected_index`), `clear_poll_question_responses`,
  `teacher_clear_poll_question_response_for_user`. Triggers: una mixta NO se
  publica con 0 preguntas (`BEFORE INSERT OR UPDATE OF is_published`) + choices/tipo
  inmutables si la pregunta ya tiene respuestas.
- **Docente** ([PollQuestionsEditor.tsx](src/modules/polls/PollQuestionsEditor.tsx)
  + [app.teacher.polls.tsx](src/routes/app.teacher.polls.tsx)): tipo `mixed` en el
  form (nace en borrador, abre el editor de preguntas al crear); editor de
  preguntas abiertas/cerradas (choices read-only con respuestas); "Preguntas" en el
  menú de fila; `auto_close` oculto para mixed; tipo bloqueado en edición; resultados
  por pregunta (cerradas = conteo, abiertas = lista con autor, nombres por 2-query,
  borrar por alumno, aviso "solo el docente ve las abiertas"); duplicar copia las
  preguntas (flag `copyQuestions`).
- **Estudiante** ([app.student.polls.tsx](src/routes/app.student.polls.tsx),
  `MixedPollCard`): responde cada pregunta con autosave (abierta = textarea al salir
  del campo, cerrada = botones de opción única); hidrata sus respuestas; "Quitar mis
  respuestas" si abierta + `allow_change_response`.
- v1 difiere: `cerrada_multi`, realtime de respuestas abiertas, quiz (correct_index),
  auto-cierre "todos respondieron" para mixed.

**Difusión (notificaciones masivas) — no mostrar/usar cursos en la papelera.**
El selector de cursos del diálogo de difusión (`/app/messages`) no filtraba
`deleted_at`, así que aparecían cursos en la papelera. Fix en 3 capas (regla
universal soft-delete — no usable en NINGÚN flujo):
- **Front** ([app.messages.tsx](src/routes/app.messages.tsx)): ambas queries del
  selector (Admin = todos, Docente = los que dicta) filtran `.is("deleted_at", null)`.
- **Edge** `broadcast-course-message`: la verificación de cursos excluye los
  soft-deleted → si llega un curso en papelera (stale, o enviado a la papelera
  entre abrir el diálogo y el envío) aborta con 404 (sin difusiones parciales).
- **Difusión programada** (mig `20260982000000`, `dispatch_scheduled_messages`):
  si algún curso del broadcast quedó en papelera entre programar y despachar,
  aborta la fila (`failed`) — consistente con la edge inmediata.

**IA — respetar SIEMPRE la cola en modo batch + resolver el modo por tenant.**
Revisión funcional (lectura del entorno de prueba) que destapó dos bugs en el
despacho de IA:
- **Admins se saltaban la cola en batch**: `AiAuthorizationGate.ensureAuthorized`
  hacía `if (isAdmin) return "proceed-sync"` ANTES de mirar el modo → un
  Admin/SuperAdmin generando con IA corría inline aunque el modo global fuera
  `async` (batch). Ahora la decisión es pura y testeable (`resolveAiGateDecision`
  en [ai-grading.ts](src/modules/ai/ai-grading.ts)): el admin sigue SIN ver el
  dialog (no es ruido) pero en batch **encola** (`proceed-async`) en vez de
  inline. Invariante: en batch nadie corre inline salvo modo `sync` o código
  "IA inmediata" vigente. +tests.
- **`getProcessingMode` ignoraba el tenant**: con `ai_model_settings` per-tenant
  (una fila activa por tenant + platform-default `tenant_id IS NULL`), el
  `.eq("is_active",true).maybeSingle()` rompía con >1 fila → `data` null → caía
  a `async` SIEMPRE, ignorando el modo del tenant (un tenant en `sync` quedaba
  forzado a la cola; ej. los docentes de FESNA no podían generar inline). Ahora
  resuelve como el edge `getActiveAiModel`: prefiere la fila del propio tenant
  sobre la platform-default (`order tenant_id NULLS LAST, limit 1`).

`ai_model_settings` es GLOBAL/per-tenant (no se tocó dato en prod); el fix es de
código. Validado local: tsc 0, IA 18/18.

**Pizarra — imágenes pegadas PERSISTEN + panel de figuras categorizado.**
- **Persistencia de imágenes**: `WhiteboardEditor.onChange` solo capturaba
  `(elements, appState)` y descartaba el 3er arg de Excalidraw, `files` (los
  binarios de las imágenes pegadas). Resultado: la imagen se veía mientras la
  pizarra estaba abierta y DESAPARECÍA al recargar (su element referenciaba un
  `fileId` sin datos). Ahora se capturan y persisten los `files` en la escena
  (`scene_json` / RPC `update_session_whiteboard_scene`; `initialData.files` ya
  los cargaba). Dedup sigue sobre elements+appState (no stringificar MB de
  base64 en cada trazo). El broadcast en vivo va SIN files (reenviar MB cada
  200 ms saturaría Realtime; los peers ven la imagen al recargar desde DB).
- **Figuras organizadas**: el panel "Library" nativo de Excalidraw es una grilla
  plana. Se agregó un panel propio categorizado (Diagramas de flujo · Bases de
  datos/E-R · POO/UML · Estructuras de datos · AWS) que inserta la figura
  centrada en el viewport al click (`instantiateLibraryElements`: clona con
  ids/seed nuevos + groupId común). Helpers puros con tests
  (`LIBRARY_CATEGORIES`, `instantiateLibraryElements`, `shortLibraryItemName`).

**Auditoría móvil (375–428px) + manejo de errores.** Revisión a detalle del
diseño móvil contra las reglas del design system: el `DialogContent` base ya
acota ancho (`w-[calc(100%-1rem)]`), alto (`dvh`) y padding (`p-4 sm:p-6`); no
hay grids forzando 2/3 columnas en móvil, ni `max-h` en `vh` (solo `dvh`), ni
touch targets <32px, y los elementos `fixed bottom` (bottom-nav, FAB) ya llevan
`env(safe-area-inset-bottom)`. Corregido lo encontrado:
- `flex-wrap` en los `CardHeader` (título + acción) de `AdminAcademicSubjectsPanel`,
  `ActasManager` y `SupabaseCronPanel` — quedaban sin envolver (a diferencia de
  los paneles hermanos), arriesgando overflow del título/botón a 375px.

(Manejo de errores y bug de foros se commitearon aparte el mismo ciclo.)

**Grids del docente: por defecto se ven activos + borradores; los completados se
ocultan.** Antes los grids de actividades mostraban todo sin distinción de
estado, y cursos abría en "En curso" (sin borradores). Ahora, al abrir, el
filtro por defecto muestra lo vigente Y los borradores; los cerrados/finalizados
solo aparecen al cambiar el filtro a "Cerrados"/"Finalizados" o "Todos".
- **Actividades** (exámenes, talleres, proyectos): nuevo filtro de estado en la
  barra (`ActivityStatusSelect` en el slot `extra` de `ListFilters`), default
  **"Activos y borradores"** (= no cerrados). Helper puro
  [status-filter.ts](src/shared/lib/status-filter.ts) (`matchesActivityStatus`,
  `DEFAULT_ACTIVITY_STATUS_FILTER`) con tests. El empty-state ya distingue
  "sin resultados" (filtro) de "crea el primero" (sin datos).
- **Cursos** ([app.admin.courses.tsx](src/routes/app.admin.courses.tsx)): opción
  "Activos y borradores" (= todo lo NO finalizado: en curso + próximos +
  borradores) como **default** (antes "En curso"). Los finalizados se ven con
  "Finalizados" o "Todos".
- El filtro se añade al `resetKey` de la paginación y `useMultiSelect` sigue
  operando sobre lo filtrado (seleccionar-todo no abarca filas ocultas).

**La fecha FIN de una actividad nunca supera la fecha fin de su curso (front +
datos).** Al asociar un examen/taller/proyecto a un curso con `end_date`, su
fecha fin se topa automáticamente a ese día; si ya era menor, se deja igual. No
salta la validación existente inicio < fin (sigue aplicando sobre el valor ya
topado).
- **Helper** `capEndToCourseEnd` / `courseEndOfDay` / `earliestCourseEnd` en
  [date-range.ts](src/shared/lib/date-range.ts) (puros, con tests). El fin del
  curso (columna DATE) se interpreta como 23:59 hora local es-CO. Multi-curso →
  se topa al curso que termina ANTES (cabe en todos).
- **Front**: al elegir/cambiar el curso (toggle) y al guardar, los 3 forms
  (`app.teacher.exams.index` `end_time`, `app.teacher.workshops` /
  `app.teacher.projects` `due_date`) topan la fecha fin. **Externos no se topan**
  (la fecha es marcador del evento ya ocurrido; en examen además end=start).
- **Datos** (mig `20260981000000`): trigger BEFORE INSERT/UPDATE que CLAMPa
  `end_time`/`due_date` al fin del día del curso (America/Bogota, espejo del
  front). Cubre import CSV, clonado, RPC y API directa. Helper SQL
  `_course_end_instant`. Externos exentos.

**Kahoot — reconexión: el jugador vuelve a la pregunta ACTUAL tras caída de
internet.** Supabase Realtime no re-emite los eventos perdidos al reconectar el
socket, así que `useKahootGame` (que solo recargaba en cada `postgres_changes`)
dejaba al jugador CONGELADO en la pregunta que tenía cuando se cayó la red, sin
saltar a la actual hasta que el host volvía a tocar la DB. Además un `reload()`
fallido (poll sin internet) podía voltear la pantalla a estado de error.
Ajuste (client-side, `use-kahoot-game.ts`):
- Re-sincroniza el snapshot (`kahoot_get_state`) al (re)suscribir el canal
  (status `SUBSCRIBED`, incluye reconexión), en `online`, al volver el foco/
  visibilidad de la pestaña, y con un poll de respaldo cada 5 s.
- Un `reload()` fallido ya NO descarta el último estado bueno: la pantalla se
  mantiene y converge a la pregunta en vivo en cuanto la red regresa.
- Server sin cambios: los jugadores no se podan al desconectar (solo el host
  tiene heartbeat), `kahoot_join_game` upsertea y `kahoot_get_state` devuelve la
  pregunta actual + `me` por `auth.uid()` — bastaba con re-pedir el snapshot.

**Recordatorio de entregas: "1 hora antes", parametrizable y UNA sola vez.**
Antes `notify_students_{workshop,project}_due_soon(24)` corría cada 2h con
ventana de 24h y dedup de solo 6h → el alumno recibía el aviso al entrar en las
24h y luego otra vez cada 6h hasta el cierre (varios correos por la misma
entrega). Ajuste (mig `20260980000000`):
- **Ventana = lead configurable** (`app_settings.due_reminder_lead_hours`,
  default **1 h**, rango 1–168). El arg explícito de la función sigue ganando
  (compat); si es NULL lee el setting; si no hay, cae a 1.
- **Dedup PERMANENTE**: un único aviso por (alumno, entrega) — ya no se repite.
- **Cron** reagendado a cada 15 min (`workshop-due-reminder` / `project-due-reminder`,
  reemplazan a `*-due-24h`); como el dedup es permanente, el alumno recibe UN
  solo recordatorio aunque el cron corra seguido. Descripciones actualizadas en
  el panel SuperAdmin.
- **UI**: campo "Recordatorios de entregas → Avisar (horas antes)" en
  Configuración → Parámetros (`AdminGeneralSettingsPanel`).
- Solo aplica a talleres/proyectos no entregados (entrega = submission). El
  recordatorio de inicio de examen (`*_exam_starting_soon`) no se tocó.

**Correos — lista de SUPRESIÓN (rebotes / bandeja llena).** Reportado (tenant
Camacho): la cuenta remitente recibe "Mail Delivery Subsystem" todo el tiempo
porque ExamLab sigue mandando notificaciones a una dirección con el buzón lleno
(`452 4.2.2 out of storage` / `5.2.2 mailbox full`). El rebote es ASÍNCRONO
(Gmail acepta con 250 y rebota un NDR horas después al remitente), así que el
edge nunca lo ve en el envío. Fix: lista de supresión.
- **Tabla `email_suppressions`** (mig `20260979000000`): el edge `send-email` NO
  envía a direcciones de la lista (enforcement GLOBAL por dirección; in-app/push
  siguen). RLS: SA todo; Admin su tenant. Email normalizado a minúsculas
  (trigger) + índice único por (email, tenant). **Sembrada** `sebasegar2006@gmail.com`
  (global) para alivio inmediato — el SA la quita del panel cuando el buzón se libere.
- **Auto-supresión** en el edge: si el handshake SMTP rebota PERMANENTEMENTE
  (5.x.x de buzón/usuario) agrega la dirección sola. NUNCA por 4.x transitorio.
  Helper `isPermanentMailboxError` con tests (fuente de verdad en
  `src/modules/notifications/email-bounce.ts`, réplica en el edge).
- **UI**: sección "Direcciones suprimidas" en el panel de Config. de correos
  (Admin + SuperAdmin) para agregar/quitar direcciones. `friendlyError` mapea el
  índice único ("ya está en la lista").

### 2026-06-15

**Informes — TODA variable `{{…}}` se resalta en el editor visual (no sólo las
insertadas).** Antes el color sólo se aplicaba a lo insertado desde el catálogo,
envuelto en un `<span class="examlab-added">` por `execCommand("insertHTML")` —
frágil (no garantiza preservar la clase) y, sobre todo, NO coloreaba las
variables ya horneadas en el `.docx` importado ni las tipeadas a mano (caso
reportado: `{{curso.nombre}}` en la celda "Asignatura" salía en negro).
- `RichTextEditor` ahora **decora todo token `{{…}}`** del DOM (incluye
  `{{#each}}`/`{{/each}}`) preservando el caret por offset de texto; guard de IME.
- El `body_html` que se **guarda y exporta va LIMPIO**: `stripVarDecoration` quita
  los wrappers al emitir (también los `span.examlab-added` viejos de plantillas
  previas). El resaltado es 100% del editor — el `.docx`/PDF conservan el formato
  del template. Los bloques de IA (`div.examlab-added`) sí persisten, como antes.
- El insert desde el catálogo mete texto/markup PLANO; el editor lo colorea.
- Helpers `decorateVars`/`stripVarDecoration` con tests (round-trip, importadas,
  bloques de control, atributos con llaves, limpieza de legacy).

**Informes — cabecera de CUADROS DE TEXTO reconstruida (caso Camacho).** Con el
.docx real (`diagnostico.docx`) se halló que la cabecera NO es una tabla sino 3
**cuadros de texto flotantes** (`<w:drawing>`+`<w:txbxContent>`, anclados con
`<wp:positionH>`): logo (inline) + título + versión. El importador los aplanaba
a párrafos apilados → la exportación quedaba desfasada.
- **`reconstructPositionedBoxes`** (docx-import): detecta cuadros de texto, los
  agrupa por posición horizontal y los reconstruye como una **fila de tabla** —
  una columna por cuadro, ordenadas izquierda→derecha, ancho proporcional a su
  tamaño. Verificado contra el archivo real: logo 26% | título 55% | versión 19%,
  título centrado/negrita, logo embebido. + tests con cabecera sintética.
- **Dedup de imágenes** (mc:AlternateContent DrawingML+VML ya no duplica el logo).
- **Tope de tamaño de imagen en el .docx** (`html-to-docx`): el logo se acota al
  ancho de SU columna/página (en .docx no hay `max-width` → un logo grande
  desbordaba y rompía el layout). Verificado E2E: el `.docx` del archivo real
  produce un `<w:tbl>` de 3 celdas en `word/header1.xml` con el logo embebido.

**Informes — fidelidad de estilos del .docx + variables en ambos scopes + iterar
estudiantes en preview.**
- **Estilos del .docx copiados con más fidelidad**: el importador ahora preserva
  tamaño de fuente (`w:sz`→pt), color (`w:color`), fuente (`w:rFonts`), subrayado,
  alineación vertical de celda (`w:vAlign`) y sombreado (`w:shd`). La exportación
  `.docx` (`html-to-docx`) los lleva al run (`w:sz`/`w:color`/`w:rFonts`/`w:u`) y a
  la celda (`tcBorders` POR CELDA — la del título sí, el logo no — `w:shd`,
  `w:vAlign`). + tests.
- **Variables de la derecha en AMBOS scopes**: `reportCatalogForScope` ya no
  oculta grupos — los muestra TODOS, sólo reordena (lo relevante al scope
  primero). Así, aunque el informe sea por estudiante, aparecen las variables del
  curso para referenciar (y los escalares del alumno en uno por curso).
- **`{{#each estudiantes}}` ahora itera en la vista previa**: insertar un bloque
  de control (`{{#each}}`/`{{#if}}`) en el editor visual lo metía en un `<span>`
  inline que partía el par de tokens y rompía la iteración. Ahora se inserta como
  BLOQUES (apertura / línea editable / cierre) con el par intacto → el preview
  itera con datos reales/de muestra.
- El resaltado de lo agregado en la plataforma (variables/IA/bloques) sigue
  siendo SÓLO del editor; la exportación conserva el formato del template (sin
  color). *Nota: colorear texto libre tecleado vs original requiere control de
  cambios y queda fuera de alcance; lo insertado (variables/IA) sí se resalta.*

**Acta oficial — "No se pudo generar el acta" CORREGIDO (workflow).** Un workflow
de diagnóstico (14 hallazgos, 7 confirmados) halló la causa: `generate_course_acta`
hacía un INSERT plano sobre `course_actas`, que tiene UNIQUE (course_id,
COALESCE(period_id, zero-uuid)); al **regenerar** un acta ya existente lanzaba
23505 → toast genérico. Fix (mig `20260978`, recrea el RPC):
- **ON CONFLICT DO UPDATE** → "Generar" ahora REGENERA (reemplaza) el acta del
  curso/periodo con las notas actuales, sin pedir borrar a mano. Diálogo
  actualizado.
- **Talleres vía `workshop_courses`** (M:N, peso/corte por curso): antes el RPC
  leía `workshops.course_id` (modelo viejo) y OMITÍA los talleres COMPARTIDOS
  (p. ej. el "Taller Final" de Camacho) del acta.
- Filtros `deleted_at IS NULL` (papelera) en exámenes/talleres/proyectos; RAISE
  claro si el curso no tiene estudiantes; `search_path` incluye `extensions`.
- `friendlyError` mapea `idx_course_actas_unique` + el toast de acta muestra el
  detalle real (message/hint) — ya no oculta la causa.

**Informes — nombre único también al IMPORTAR + diagnóstico del fallo de acta.**
- El nombre único de plantilla ahora se aplica tanto a las creadas de 0 (en
  guardar) como a las **importadas** desde `.docx` (docente y admin): si ya
  existe una con ese nombre se crea una NUEVA con sufijo "(N)" — nunca se entra
  en modo edición de la existente.
- `ActasManager`: el fallo "No se pudo generar el acta" ahora **muestra el
  detalle real** (message/hint) en el toast + `console.error`, para diagnosticar
  (antes el toast genérico ocultaba la causa). La descarga Word ya es `.docx`
  real (commits previos `925c8a6`/`d2f9916`) — el `.doc` que se ve aún es la
  versión sin Publish.

**Informes — variables y prompt IA según el TIPO de informe (scope).** El panel
de variables de la derecha y el contexto de la IA dependen ahora del scope:
- `reportCatalogForScope(scope)` (template-engine): por **estudiante** muestra
  variables del alumno único (`estudiante.*`, notas, asistencia) + curso/docente/
  institución; por **curso** muestra el consolidado `{{#each estudiantes}}` +
  totales. El editor (`TemplateEditor`) usa el catálogo según `value.scope`.
- La **IA** recibe ese mismo catálogo (`buildAiReportPrompt({ catalog })`) y los
  datos reales según scope: curso → datos del curso completo; estudiante →
  datos de ese estudiante (vía `studentId` en `buildReportContext`).
- El editor **pide PRIMERO el tipo de informe** (scope), full-width y con nota
  de que de él dependen variables + datos. + tests de `reportCatalogForScope`.

**Informes — exportación .docx REAL (cabecera en el área de encabezado),
resaltado de lo agregado por la plataforma, y nombres únicos.** (commit pendiente)

- **Descarga Word ahora es `.docx` OOXML real** (no `.doc` MSO-HTML que Word
  re-interpretaba y cambiaba el formato). Nuevo `html-to-docx.ts` (fflate +
  DOMParser, sin libs): el cuerpo va en `word/document.xml`, **la cabecera en
  `word/header1.xml`** (área de encabezado de página, referenciada en
  `<w:sectPr>` → se repite arriba en cada página, ya NO al inicio del cuerpo),
  el pie en `word/footer1.xml`, imágenes embebidas en `word/media/*`, tablas con
  anchos de columna (`tblGrid`/`gridSpan`), headings/negrita/itálica, saltos de
  página. + 7 tests de estructura OOXML (incl. que la cabecera NO queda en el
  cuerpo).
- **PDF**: header/footer con `position:fixed` en `@media print` → van al área de
  encabezado/pie de cada página (1 pág exacto; multi-pág se repiten). Pantalla
  sin cambios. Para fidelidad total de encabezado, la descarga `.docx` es la vía.
- **Resaltado de lo agregado en la plataforma**: en el editor VISUAL, lo que el
  docente inserta (una `{{variable}}` o contenido de IA) se envuelve en
  `.examlab-added` y se ve en otro color (violeta) — sólo en el editor (la clase
  no tiene estilo en el preview ni en el `.docx`/PDF), distinguiéndolo del
  template original.
- **Nombres únicos**: las plantillas (docente y admin) auto-sufijan "(2)", "(3)"…
  si el nombre choca; los informes generados llevan una **marca temporal** en el
  nombre de archivo (`fileStamp`) para que dos descargas no se sobrescriban.

Validación: `tsc` EXIT 0; reports 113/113 + locale-parity 7/7.

**Informes — saltos de página visibles en el editor visual + fidelidad de la
cabecera del .docx al exportar.** (commit pendiente)

- **Editor visual muestra dónde empieza/termina cada página**: el marcador
  `examlab-page-break` se decora en el contentEditable (regla global en
  `styles.css`, sólo afecta al editor — las previsualizaciones son iframes con
  su propio doc) como divisor "Salto de página". Antes sólo se veía el conteo
  total de páginas, no las divisiones.
- **La cabecera del .docx ya no se DESFASA al exportar**: el importador ahora
  preserva los anchos de columna del `<w:tblGrid>` (cada `<w:gridCol>` →
  `width:%`) + `gridSpan` (→ `colspan` + suma de anchos) + `table-layout:fixed`.
  Sin esto, una cabecera "logo | título | versión" reflowaba a columnas
  automáticas y la estructura quedaba distinta al original. + tests
  estructurales ("e2e" del flujo importar→exportar: docx con grid → bundle →
  `composeTemplateHtml` conserva tabla/anchos/logo/título centrado).

Validación: `tsc` EXIT 0; reports 99/99.

**Diagnóstico (workflow) + fix: tormenta de correos "de notificaciones que ya
pasaron" en el tenant Camacho.** Un workflow de auditoría (32 hallazgos, 19
confirmados) identificó las causas. Causa raíz de los CORREOS de eventos
pasados: `dispatch_scheduled_messages()` seleccionaba `status='pending' AND
send_at <= now()` SIN tope inferior → un mensaje programado vencido (outage de
cron / send_at pasado) se disparaba RETROACTIVAMENTE; como `broadcast` emaila,
mandaba un correo a CADA estudiante de un aviso ya pasado.

- **Fix (mig `20260977000000`)**: `dispatch_scheduled_messages` ahora (1) cancela
  de entrada los pendientes vencidos >24h, (2) sólo despacha lo vencido en las
  últimas 24h (nunca retroactivo), (3) limpieza one-shot de los acumulados. El
  resto del cuerpo (direct/broadcast + GUC) idéntico a `20260709000000`.
- **Corrección de un over-flag del audit**: las funciones cron de recordatorio de
  estudiante NO tienen un "leak cross-tenant" real (notifican a cada alumno de SU
  propio curso); agregarles `tenant_id = current_tenant_id()` (NULL bajo
  service_role) ROMPERÍA todos los recordatorios — NO se aplicó.
- **Otras causas confirmadas (relevadas, fix recomendado, no aplicado aún)**:
  dedup por TÍTULO exacto en recordatorios (se reabre al editar el título → usar
  dedup por id de entidad); remoción del rate-limit de mensajería (`20260531`,
  decisión de producto — kill-switch `email_settings.enabled_kinds.messages`);
  `notify_send_email` re-dispara en UPDATE/re-insert (guard `TG_OP='UPDATE'` /
  `email_delivered_at IS NOT NULL`); `notify_teachers_pending_grading` duplica
  notificación DIARIA en la CAMPANA (no correo: kind='system') → falta guard
  `created_at::date = CURRENT_DATE`. SQL diagnóstico entregado al usuario para
  confirmar cuál(es) están activas en Camacho.

**Informes IA — fix `prompt_too_large`, prompt configurable y preview con datos reales.**
(commit pendiente)

- **`prompt_too_large` (413) corregido**: la Generación IA inline mandaba el
  CUERPO COMPLETO del informe como `draftText` (que tras importar un .docx
  incluye imágenes base64 → >200K chars, el tope del edge). Ahora la generación
  inline manda `draftText: ""` (es un FRAGMENTO para el cursor, no una
  reescritura). Además `buildAiReportPrompt` elimina los data URIs y acota el
  resumen del curso (12K) y el borrador (8K) — defensa anti-tamaño.
- **Prompt configurable** (`ai_prompts.use_case = 'report_generation'`): el
  system prompt de la Generación IA dejó de estar hardcodeado en el front; ahora
  vive en el módulo de Prompts (Admin → IA → categoría "Informes"), editable por
  el SuperAdmin (PLATFORM DEFAULT) y disponible para todos los tenants vía el
  resolver del edge (`ai-generate-report` resuelve course→tenant→platform→
  FALLBACK, igual que el Tutor). Mig `20260976000000` (CHECK + seed). El front
  manda el `user` dinámico; el edge resuelve el `system`.
- **Vista previa con DATOS REALES (no mock)**: el editor ahora previsualiza con
  los datos reales de un curso que el docente elige (selector de curso en la
  pestaña Vista previa). En scope **estudiante** aparece además un selector de
  ESTUDIANTE para "situar" las variables con ese alumno; en scope **curso** las
  iteraciones (`{{#each estudiantes}}`) traen TODOS los estudiantes reales. La
  Generación IA usa ese mismo curso/estudiante como fuente de datos (ya no un
  selector aparte). Hasta elegir curso, cae al contexto de muestra/marca.

Validación: `tsc` EXIT 0; reports 95/95 + locale-parity 7/7.

**Editor de informes — preview renderizado, números de página y Generación IA al cursor.**
(commit pendiente) Mejora el editor de plantillas (flujo de importar .docx):

- **Vista previa RENDERIZADA**: el preview del editor ya NO muestra los
  `{{placeholders}}` crudos — los resuelve con datos de MUESTRA (o la marca real
  del tenant: `useTenant()` → logo + nombre), así se ve el documento como
  quedará (el logo institucional aparece, las notas se ven). `composePreviewHtml`
  ahora usa `renderTemplate` + `buildSampleReportContext` (nuevo, en
  template-engine) en vez de resaltar tokens. Render resiliente (un bloque sin
  cerrar no rompe el preview).
- **Números de página claros**: cada hoja del preview se titula "Página X de N"
  (badge), y el tab Cuerpo muestra un contador "N página(s)".
- **Generación IA al cursor**: se quitó el botón inferior global "Generar con IA"
  (que reemplazaba todo el cuerpo). Ahora hay un botón "Generación IA" arriba en
  el panel de **Variables disponibles** (derecha): el docente sitúa el cursor en
  el cuerpo, abre un prompt (curso de referencia + instrucción) y la IA inserta
  el contenido EXACTAMENTE donde está el cursor (`RichTextEditor.insertHtml` +
  selección guardada al abrir el diálogo). El edge `ai-generate-report` y el
  fallback a portapapeles se conservan. `TemplateEditor` recibe `onAiGenerate`,
  `aiCourses` y `previewContext`.

Validación: `tsc` EXIT 0; tests de reports 95/95 + locale-parity 7/7 (15 claves
nuevas en es+en del editor).

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

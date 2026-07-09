# Plan vivo de errores — ExamLab

> Documento de seguimiento de la revisión sistemática de bugs. **Propósito**: registrar
> hallazgos verificados por módulo/rol, su estado (fixeado / pendiente / descartado) y
> cómo seguir. Se actualiza en cada ronda de revisión.
>
> **Metodología**: workflow `find→verify` adversarial por módulo (finders leen el código
> real; cada hallazgo se verifica contra el data-path completo, default = refutar, solo
> se confirma lo reproducible). Los fixes se aplican con `tsc` EXIT=0 + tests dirigidos +
> migraciones verificadas en tx rolled-back y aplicadas live a prod (`docker/restore.env`).
>
> **Última actualización**: 2026-07-08 (rondas 1-7 CERRADAS; ronda 7: `email.failed` 421 en ráfaga → retry-with-backoff + jitter en `send-email`; ronda 6: Papelera-en-selección 5 fixes `courses` + `RangeError` toISOString del editor de examen).

---

## Estado de `audit_logs` (prod) — 2026-07-04

Sin errores accionables nuevos en 48h. Lo registrado es stale o normal:

| acción | n | estado |
|---|---|---|
| `user.bulk_password_reset_failed` | 60 | **Stale** — lote FESNA pre-fix ("Database error loading user"). 0 tokens NULL restantes tras mig `20261049`; un reintento del docente funcionaría. |
| `user.bulk_import_row_failed` | 56 | **Stale** — import FESNA pre-fix (`personal_email=''`), resuelto por mig `20261040`. |
| `email.failed` (421) | 17 | **Infra transitoria** — Gmail "Temporary System Problem". No es bug de código. (Mejora futura: retry con backoff en 4xx/5xx transitorios.) |
| `course.deleted`, `user.password_changed` | 1 c/u | Operaciones normales auditadas. |

**Regla**: revisar `audit_logs WHERE severity IN ('error','warning')` en cada ronda para
detectar bugs que solo aparecen en runtime (no en lectura de código).

---

## Ronda 1 — ✅ CERRADA (22 bugs, 5 commits)

Workflow `w37inulmk` (13 módulos) + validación `w1ouuwc0j` (22/22 RESOLVED tras refix M6).

| commit | bugs |
|---|---|
| `f1369242` | edges: calendar-ics, student-calendar-ics, detect-plagiarism, ai-generate-report |
| `8e7bdc10` | certificados (tenant scope + matrícula), video_views, support_tickets (trigger anti-tamper) |
| `4b653c8d` | Papelera: OpenFeedbackModal oculta threads de entidades en papelera |
| `23223036` | RLS `has_role` sin scope: 7 tablas (leak REAL en `ai_override_activations`) |
| `1343d248` | RPCs SECURITY DEFINER: `system_*`/`tenant_role_count` REVOKE, `count_ai_errors_*` scope |
| `2c1f9c78`,`f8bcba62` | funcionales: FINAL_FOR_REGRADE, nota final estudiante, timer poll add_time, snippets multi-file, pizarra imágenes, mensajes dead-end, signOut scope, FraudPanel, override rol, reset error, papelera restore, fechas UTC |
| `8d13d298`,`9f1f45aa`,`6ef622b9` | edges (python `#`, tutor tenant, calendar guard, bulk import tenantId) + migraciones (cert link, voto atómico, tenant_user_counts, humanizar tags, code_executions) + refix M6 |

---

## Ronda 2 — ✅ CERRADA (3 HIGH + 14 pendientes, 3 commits)

Workflow `wq81qewnn` (10 módulos) → 18 confirmados (0 critical, 3 HIGH, 8 med, 7 low).
Validación `w7ybkai3e` (9/14 por workflow, 0 problemas; 3 migs por DB + M9/M7 self-verify).

| commit | bugs |
|---|---|
| `16363496` | **3 HIGH**: re-calificación async con respuestas viejas (enqueue refresh body) · branding de certificado de otro tenant (`resolve_certificate_settings` scope) · sync offline pisa respuestas nuevas (`__saved_at`) |
| `719cf64c` | cliente: tiempo extra en realtime del examen · bypass proctoring tras reload · `visibilitychange` · filtro periodo académico · estudiantes únicos dedup · `{{aprobado}}` informes · push cleanup logout · "0/max" async · PDF /verify · cierre manual foros programados · guard opciones Kahoot (cliente) |
| `cdfdbb0b` | migraciones: cascade cierra foros programados · gracia TOTP simétrica check-in · guard server-side opciones Kahoot |

**Descartado (L#13)**: comentario obsoleto sobre `last_activity_at` en migración inmutable
`20260520100000_forum.sql` — no es bug funcional (desajuste de doc); el "bump on edit" es
decisión de producto, no corrección.

---

## Ronda 3 — ✅ CERRADA (5 HIGH + 14 med/low, workflow `wyjc0fh78`, 19 confirmados)

Módulos: cron · email · storage · realtime · trabajo en grupo · actividades externas ·
duplicar · import/export · videos+gate · i18n. **0 critical, 5 HIGH, 8 medium, 6 low.**

### ✅ HIGH cerrados (commit `5851be25`; acta `20261060` live)
- **H1/H2/H3 [trabajo en grupo]** — la entrega grupal tiene `user_id`=solo el "último editor";
  los demás miembros se resolvían por `user_id` → su taller/proyecto grupal contaba como 0.
  Fix en las 3 vías de consolidación: acta/certificado (`generate_course_acta` por membresía),
  gradebook docente (celda vacía), "Mis calificaciones" del alumno.
- **H4 [estadísticas]** — `statistics.ts` seleccionaba `exams.max_score` (inexistente) → 400 →
  todos los exámenes desaparecían de las estadísticas. Quitada la columna + `max_score`=escala.
- **H5 [import sustentaciones]** — template con factor `0,8` (coma) en CSV coma-delimitado →
  fila desalineada → factor 0 → nota final 0 SILENCIOSA. Template a `0.8` + guard de columnas.

### ✅ MEDIA cerradas (8) — commits del 2026-07-07
- **cron** `admin_list_cron_jobs` recreado con `description` + LEFT JOIN a `cron_job_descriptions` — mig `20261067000000` (DROP+CREATE por cambio de RETURNS), live. `43ac6e06`.
- **email** `kind='support'` agregado a `CRITICAL_KINDS` del edge + cliente (el gate on/off sigue upstream en `_notification_kind_emails` vía `platform_settings`). `64591fd3`.
- **realtime** `useRealtimeTimer` — `onPause/onResume/onTimeAdded` movidos a refs; el efecto de suscripción depende solo de `[examId, userId]` (no re-suscribe cada segundo). `99da03ba`.
- **trabajo en grupo (mixto)** trigger `tg_block_{ws,pr}_group_member_with_individual` bloquea (P0001) asignar a grupo a quien ya tiene entrega individual — mig `20261068000000`, live + verificado. `ddbd8443`.
- **actividades externas** `statistics.ts` — items `is_external` usan `max_score = grade_scale_max` (reescalado identidad, su nota está en escala del curso). `99da03ba`.
- **import** `parseCSV` reescrito como parser RFC 4180 char-a-char (estado de comillas cruza saltos de línea) + tests. `9337e3e4`.
- **video** `IntroVideoGate` — `onError` en video directo con "Reintentar" + "Continuar de todos modos" (no bloquea la entrega). `99da03ba`.
- **i18n/fecha** helper `todayLocalISO()` para el default de fecha de nueva sesión (era UTC). `99da03ba`.

### ✅ BAJA cerradas (6) — commits del 2026-07-07
- **email** `kind='attendance'` agregado al predicado SQL `_notification_kind_emails` — mig `20261066000000`, live. `64591fd3`.
- **storage** borrar comentario de feedback ahora remueve sus adjuntos del bucket. `66f61a5c`.
- **storage** reemplazar/quitar logo de tenant remueve el objeto anterior de `tenant-logos` al guardar. `66f61a5c`.
- **import** `BulkImportDefensesDialog` usa helper `readCsvFile` (detección UTF-8 → Windows-1252) — sin mojibake. `99da03ba`.
- **video** `toEmbedUrl` idempotente con URLs ya-embed de Vimeo (`player.vimeo.com/video/<id>`) + tests. `9337e3e4`.
- **i18n** toasts de `AdminEmailSettingsPanel` migrados a `t()`. `99da03ba`.

_Detalle completo (repro + fix) en el output del workflow `wyjc0fh78`. Todas las migraciones aplicadas
live; los cambios de cliente/edge requieren **Publish** en Lovable._

---

## Ronda 4 — ✅ RLS profundo (barrido empírico cross-tenant, 5 leaks cerrados, 2026-07-07)

Metodología: como un estudiante real (tenant FESNA, matriculado en 1 curso), contar filas visibles
en cada tabla hija de curso vía `SET LOCAL ROLE authenticated` + jwt claims (tx rolled-back). Todo
lo course-specific de cursos ajenos = leak. Fixes verificados ANTES→DESPUÉS + aplicados live.

- **forum_upvotes** `SELECT USING (true)` → cualquiera leía todos los upvotes cross-tenant. Fix:
  `user_id = auth.uid() OR is_super_admin()`. `913fbc1d`.
- **exams / workshops / projects** `*_select_in_tenant`: rama estudiante era `course_in_my_tenant AND
  no-borrada` (sin asignación) → veía TODOS los del tenant (probado: 6 talleres sin asignación). Fix:
  rama estudiante exige `EXISTS(*_assignments.user_id = auth.uid())`. `783a8fe4`.
- **course_enrollments / course_teachers** `USING (course_in_my_tenant)` → estudiante veía las 195
  matrículas del tenant + 4 asignaciones docente. Fix: propias + Admin(tenant) + docente-del-curso /
  matriculado, con helpers SECDEF `_teaches_course` / `_is_enrolled_in_course` (evitan recursión RLS).
  `bb176730`.

Barrido round 2 (submissions, workshop/project_submissions, attendance_records, poll_responses,
similarity_pairs, session_code_snippets, kahoot_*, generated_reports, exam_assignments,
tutor_chat_messages, group_chats): **todos 0** (bien scopeados). `whiteboard_pages` (4) y
`report_templates` (5) verificados legítimos (páginas del curso matriculado / plantillas globales).
`ai_prompts` (29) abierto by-design. Suman a whiteboards (`20261061`) + attendance_sessions
(`20261065`) de esta misma sesión.

## Ronda 5 — ✅ find→verify sobre lo agregado esta sesión (6 bugs, commit `79867952`, 2026-07-07)

Workflow `find→verify` adversarial (5 áreas, 12 agentes) sobre las features/cambios nuevos de la
sesión (soporte IA chat + remediación, Tablero, i18n `${}→{{}}`, monitor/timer/statistics). Confirmó
6 (todos introducidos esta sesión) + refutó 1 correctamente (friendlyError del import del Tablero).

- **[high→media] platform_support_messages sin policy DELETE** → "Limpiar conversación" borraba 0 filas
  sin error (default-deny) → UI decía éxito, los mensajes reaparecían. Migración `20261072` con policy
  DELETE del dueño. Live + verificada.
- **[media] ErrorsPanel "Analizar con IA"** visible al Admin pero el edge (mode=error) es SA-only → botón
  muerto. Gateado por `isSuperAdmin`.
- **[media] Tablero draft leak**: salir de edición tocando el form de creación arrastraba título/URLs de
  la sesión editada al crear. Handlers ahora llaman `cancelEdit()`.
- **[baja] platform-support-chat**: validaba vacío pre-slice → mensaje de solo espacios sobre el cap
  violaba el CHECK (500). Valida sobre `trimmedMessage`.
- **[baja] support-ai-suggest**: `sanitizeSuggestion` devolvía disculpa no-vacía → se mostraba como
  sugerencia "lista". Ahora `""` → el cliente muestra error.
- **[baja] use-realtime-timer**: el poll aplicaba pause/resume sin emitir el toast → alumno no se enteraba
  si Realtime perdía el evento. Emite solo en transición (ref last-notified, sincronizado en el load).

audit_logs de prod: 0 errores accionables nuevos (solo 1 `app.runtime_error` genérico stale).

## Ronda 6 — ✅ Papelera-en-selección + audit_logs (2026-07-07)

### a) Auditoría "Papelera no debe verse/seleccionarse" (workflow `find→verify`, 84 archivos, commit `123ec5a2`)
Barrido de la regla universal soft-delete sobre TODA lectura de las 8 entidades (courses/exams/
workshops/projects/attendance_sessions/whiteboards/generated_contents/polls) que alimente un
**selector, picker, lista, calendario, dashboard, reporte o vista en vivo**. 221 lecturas revisadas,
**5 confirmados (todos `courses`, en features añadidas tras los barridos previos):**
- **AdminProgramOverviewPanel** — query directa de cursos + embeds de matrículas/docentes sin
  `deleted_at` → el "Resumen institucional" inflaba conteos con cursos en papelera. Fix: `.is(deleted_at,null)` + embed+skip JS.
- **app.index (dashboard alumno)** — el `<Select>` del ranking de Reto en vivo listaba cursos en
  papelera. Fix: embed `deleted_at` + skip; `enrolledCourseIds` derivado de la lista ya filtrada.
- **app.teacher.calendar** — el `<Select>` de "Sincronizar horarios" dejaba cursos en papelera
  elegibles. Fix: embed + skip.
- 3 finders fallidos por conexión revisados a mano (board-content-upload, WorkshopQuestions,
  SessionWhiteboardDialog) → **limpios** (escrituras / read-by-PK). Resto de course-pickers ya filtran.
  Detalle en `docs/AUDITORIA-PAPELERA-SELECCION-2026-06-30.md`.

### b) Revisión de `audit_logs` de prod (2026-07-07)
- **[fix] `RangeError: Invalid time value` en `/app/teacher/exams/$examId`** (`app.unhandled_rejection`,
  2026-06-30) — el save handler hacía `new Date(exam.start_time).toISOString()` con start/end vacío o
  inválido (draft sin fecha o campo limpiado en el picker) → excepción async no capturada que tumbaba
  la pantalla. Fix: helper `safeIso()` (null en vez de lanzar) en el payload + guard `Number.isNaN` en
  el `onChange` del picker. `tsc` EXIT=0. **Requiere Publish.**
- **`app.runtime_error` requestFullscreen** (WhiteboardEditor, 2026-06-10) → **ya resuelto** (detecta
  soporte de Fullscreen API + `typeof req === "function"`; comentario en el código lo documenta). Stale.
- **`app.runtime_error` en whiteboards, textarea** (2026-07-07, `percentages-*.js`) → stack de **vendor**
  (Excalidraw), 1 sola ocurrencia, sin frame de código propio → **monitoreo**, no accionable hoy.
- `user.bulk_password_reset_failed` (60) · `user.bulk_import_row_failed` (56) · `email.failed` (17) →
  **stale/infra** ya documentados (migs `20261040`/`20261049`; Gmail 421 transitorio). React #418
  (2026-06-19) y driver.js SSR (dev localhost) → stale/no-prod.

## Ronda 7 — ✅ email.failed 421 en ráfaga (revisión de audit_logs, 2026-07-08)

Revisión de `audit_logs` de prod. Hallazgo NUEVO y de alto impacto:

- **[alto→media] `email.failed` explotó a 325 en 14 días** (antes ~17), con una **ráfaga hoy**
  (2026-07-08): Gmail responde `421 4.3.0 Temporary System Problem` para correos `kind=workshop`.
  Causa: notificar a todo un curso (p. ej. FESNA, ~190 estudiantes) dispara ~190 invocaciones
  concurrentes de `send-email` → ~190 conexiones SMTP a Gmail en el mismo instante → throttle
  transitorio → el correo se marcaba `failed` **sin reintentar** (los alumnos no recibían la
  notificación). Era el ítem del backlog, ahora urgente.
  **Fix** (`send-email/index.ts`): (1) **pre-jitter** 0–1200 ms para desincronizar la ráfaga;
  (2) **retry-with-backoff** hasta 3 intentos SOLO para errores TRANSITORIOS (`isTransientSmtpError`:
  421/4.x.x/timeout/conexión/throttle) con backoff exponencial + jitter (~1s, ~3s); los permanentes
  (5.x.x mailbox) siguen fallando de una + auto-supresión. El audit registra `attempts`/`retried`.
  **Requiere Publish.**
- Resto sin novedad accionable: `bulk_password_reset_failed`/`bulk_import_row_failed` (stale,
  Jul 1-2, resuelto por migs previas — limpia al re-ejecutar); `app.unhandled_rejection` toISOString
  del editor de examen (Jun 30) ya arreglado en Ronda 6 (`safeIso`, pending Publish); `app.runtime_error`
  whiteboards (Jul 7, `percentages-*.js` en handler de textarea) → stack de **vendor** (Excalidraw),
  1 ocurrencia, monitoreo; React #418 / driver.js SSR / ResizeObserver / sw.js → stale/ruido.

### Follow-up find→verify sobre el wiring nuevo de red + el retry (no visible en audit_logs — sin desplegar)
Workflow `find→verify` (6 áreas) sobre el código recién agregado. 8 bugs confirmados y arreglados:
- **[alta] Fuga de conexión SMTP**: en el nuevo `attemptSmtpSend`, `client.send()` + `client.close()`
  sin try/finally → ante el 421 que gatilla el retry, `close()` se saltaba y filtraba el socket
  (agravando el throttle que el backoff mitiga). Fix: payload extraído + `try { send } finally { close }`.
- **[media] Doble-entrega / falso email.failed**: si `close()` lanzaba tras un `send()` exitoso, el
  error (transitorio) reintentaba (duplicado) o marcaba failed pese a la entrega. El mismo try/finally
  con `close()` best-effort (no propaga) lo resuelve.
- **[media] Auto-supresión sobre-agresiva** (pre-existente): un 5.x.x de UNA dirección suprimía AMBOS
  RCPT (institucional + personal). Fix: suprimir solo las atribuibles (única, o la que aparece en el error).
- **[media] gradeNetwork sin aislar**: una respuesta de red malformada podía lanzar y abortar la
  calificación de TODA la entrega (edge examen + cliente taller/proyecto). Fix: try/catch → earned 0 + feedback.
- **[media] red_gui en revisión ocultaba el direccionamiento**: `NetworkTopologyEditor` readOnly solo
  mostraba el diagrama, no las IP/máscara/estado (lo que se califica). Fix: resumen read-only del direccionamiento.
- **[media] Preguntas de red locales no refrescaban** si el flujo de IA del resto se cancelaba/iba a cola.
  Fix: `load()` tras insertarlas.
- **[baja] Select de IA-masiva del taller omitía `red_gui`** (indentación). Agregado.
- **[baja, DEFERIDO] guard de "cambios sin guardar" del banco no ve ediciones del escenario JSON** —
  fix riesgoso (falso-dirty por el effect de siembra); se acepta por ahora.
tsc EXIT=0 · tests de red 47/47. **Requiere Publish.**

## Cómo seguir

1. **Cada ronda**: (a) revisar `audit_logs` de prod; (b) lanzar workflow `find→verify` sobre
   los módulos que falten o los recién tocados; (c) fixear críticos/altos de inmediato,
   presentar medios/bajos para aprobación; (d) validación de completitud adversarial; (e)
   actualizar este doc.
2. **Prioridad**: `critical`/`high` (pérdida de datos, nota/cert incorrecto, crash, seguridad)
   se solucionan sin esperar aprobación; `medium`/`low` se listan aquí y se resuelven por lote.
3. **Cierre a prod**: migraciones DB ya se aplican live; cliente/edge requieren **Publish** en Lovable.

## Backlog / mejoras (no bugs)
- ~~Retry con backoff para `email.failed` transitorios (421/4xx/5xx) en `send-email`.~~ ✅ Ronda 7.
- Cleanup de archivos de Storage al purgar la Papelera (huérfanos — TODO v2 conocido).

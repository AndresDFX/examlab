# ExamLab — Claude Context

## Plataforma y despliegue

- **Hospedado en Lovable** (lovable.dev). Lovable gestiona Supabase automáticamente.
- El usuario **NO tiene acceso directo al dashboard de Supabase**.
- Flujo de despliegue: `git push origin main` → usuario da click en **Publish** en Lovable.
- Las migraciones van en `supabase/migrations/*.sql` — Lovable las aplica en Publish.
- Remote git: `git@github-vivetori:vivetori/examlab.git` (nombre: `origin`)

## Stack

- React 18 + TanStack Router v1 + TypeScript
- UI: shadcn/ui (Card, Button, Badge, Dialog, Alert…) + design system propio (ver abajo)
- DB: Supabase (PostgreSQL + RLS)
- i18n: react-i18next (es-CO default)
- Offline: idb-keyval (IndexedDB)
- Toast: sonner
- AI grading: Lovable AI Gateway → `google/gemini-2.5-flash` / `gemini-2.5-pro`

---

## Regla de UI: usar el design system propio SIEMPRE

Antes de añadir markup nuevo o tocar estilos en una pantalla, **revisar primero si existe un componente del design system propio que cubra el caso**. Si existe, usarlo. Si no existe pero el patrón se va a repetir, **proponer crear el componente y agregarlo a este CLAUDE.md** antes de implementarlo inline en una sola pantalla.

Ej: estoy por agregar una nueva tabla → en el empty state usar `<TableEmpty>`, en el loading state usar `<TableSkeleton>`, en las acciones por fila usar `<RowAction>`. NO escribir `<Button variant="ghost" size="sm" title="...">` para acciones de fila.

### Catálogo del design system

Vive en `src/components/ui/`. Componentes propios (encima de shadcn):

| Componente | Para qué |
|---|---|
| `Label` (con prop `required`) | Forms con asterisco rojo en campos obligatorios |
| `DecimalInput` | Inputs numéricos con coma como separador (siempre). Bloquea el punto, lo auto-convierte a coma. Emite `number \| null` con punto al padre. |
| `RowAction` | Botones de acción icon-only en grids/listas. Tooltip + aria-label automáticos. Soporta `tone="destructive"` y `asChild` (para Link). |
| `StatusBadge` | Estados de exam/workshop/project/submission con variant + ícono unificado. `sospechoso/requiere_revision` → destructive con AlertTriangle, etc. |
| `EmptyState` / `TableEmpty` | "Sin datos" con padding y tono consistente. `TableEmpty` se usa como fila dentro de `<TableBody>` con `colSpan`. Soporta prop `action` para CTA tipo "Crear primer X". |
| `Spinner` | Wrapper sobre `Loader2` con tamaños semánticos (`xs`/`sm`/`md`/`lg`/`xl`). Reemplazo de `<Loader2 className="h-4 w-4 animate-spin" />` directo. |
| `SectionLoader` / `PageLoader` | Placeholders "Cargando…" para secciones / páginas completas. |
| `TableSkeleton` / `ListSkeleton` | Placeholders pulsantes para grids/listas mientras cargan datos. Mejor UX que "Cargando…" sobre tabla vacía. |
| `PageHeader` | Header de páginas de detalle: breadcrumb "← Volver" arriba (no compite con el título), `title` h1, `subtitle`, slot `actions` opcional, slot `icon` opcional. |
| `ErrorBoundary` | React error boundary global, montado en `__root.tsx`. Captura errores fuera de rutas. Errores DENTRO de rutas los maneja `defaultErrorComponent` del router. |
| `useMultiSelect` + `MultiSelectHeaderCheckbox` / `MultiSelectCheckbox` / `MultiSelectToolbar` / `BulkDeleteDialog` ([multi-select.tsx](src/components/ui/multi-select.tsx)) | Multi-selección + bulk delete para grids/tablas. Hook devuelve `{ selectedIds, toggle, toggleAll, isSelected, allSelected, indeterminate, count, clear }`. Toolbar aparece arriba cuando `count > 0`. BulkDeleteDialog muestra conteo + lista expandible (preview 5, expansible al resto) y ejecuta `.delete().in('id', ids)` atómico. Aplicado en grids de Usuarios, Cursos, Exámenes, Talleres y Proyectos. |
| `ListFilters` ([list-filters.tsx](src/components/ui/list-filters.tsx)) | Barra estándar de búsqueda + filtro por curso para grids docente (talleres, proyectos, exámenes). Search input con ícono lupa + Select con "Todos los cursos" como default + botón "Limpiar" cuando hay filtros activos. Presentacional: el padre arma `filteredItems = useMemo(...)` y los pasa a `useMultiSelect` para que "seleccionar todo" abarque solo lo visible. |
| `HelpHint` ([help-hint.tsx](src/components/ui/help-hint.tsx)) | Icono `?` con tooltip para texto de ayuda inline. Uso: `<Label>Campo <HelpHint>explicación detallada</HelpHint></Label>`. Reemplaza el patrón anterior `<span className="text-xs text-muted-foreground font-normal">(explicación)</span>`. Self-contained con su propio TooltipProvider. Soporta `side` y `align`. |

### Helpers utilitarios (`src/lib/`)

| Helper | Para qué |
|---|---|
| `formatDate(d)` | "30 sep 2026" |
| `formatDateLong(d)` | "30 de septiembre de 2026" |
| `formatDateShort(d)` | "30 sep" (sin año, para tiles angostos) |
| `formatDateTime(d)` | "30 sep 2026, 14:30" |
| `formatTime(d)` | "14:30" |
| `formatWeekday(d)` | "lunes, 30 de septiembre" |
| `formatDateOnly("2026-09-30")` | Para columnas DATE sin TZ — ancla a 12:00 local para evitar el bug de descontar un día por UTC |
| `formatDuration(90)` | "1h 30m" |

Locale es-CO hardcodeado en `Intl.DateTimeFormat` para que la app se vea igual independiente del SO/navegador del usuario.

### Patrones de comportamiento

- **`useConfirm()`** (de `ConfirmDialog`): para confirmaciones destructivas o de cambio importante. Retorna `Promise<boolean>`. NO construir Dialogs custom para esto.
  - Reglas de tono: `destructive` (eliminar), `warning` (acción reversible pero ojo: cerrar sesión, descartar cambios, entregar con preguntas en blanco), `default` (info).
  - Toda confirm destructive debe terminar con `"Esta acción no se puede deshacer."` o equivalente ("permanente").
- **Confirmación al entregar con respuestas en blanco**: examen, taller y proyecto detectan respuestas vacías antes de entregar y usan `confirm({ tone: "warning" })`.
- **`StatusBadge` para estados**: nunca pintar un Badge con clases ad-hoc para un estado. Usar `<StatusBadge status={x} />` que ya tiene el mapeo variant + ícono.

---

## Archivos clave

| Archivo | Propósito |
|---------|-----------|
| `src/routes/app.student.take.$examId.tsx` | Pantalla de toma de examen (estudiante) |
| `src/routes/app.student.exams.tsx` | Lista de exámenes del estudiante |
| `src/routes/app.student.review.$examId.tsx` | Revisión de resultados |
| `src/routes/app.student.grades.tsx` | Vista de notas por curso del estudiante |
| `src/routes/app.teacher.gradebook.tsx` | Gradebook docente con consolidado por corte + export CSV |
| `src/routes/app.teacher.monitor.$examId.tsx` | Monitor en vivo del examen |
| `src/components/CutsEditor.tsx` | Editor de cortes evaluativos del curso |
| `src/components/ExternalGradesEditor.tsx` | Notas de actividades externas (presencial / otra plataforma) |
| `src/components/FraudPanel.tsx` | Análisis IA + detección de copia entre estudiantes |
| `src/integrations/supabase/types.ts` | Tipos generados de Supabase (no editar a mano) |
| `src/lib/offline-sync.ts` | IndexedDB sync (`clearLocalAnswers`, `setupOfflineSync`) |
| `src/lib/format.ts` | Helpers de formato de fechas/duraciones (es-CO) |
| `src/utils/proctoring.ts` | `MAX_WARNINGS=3`, `warningLabel`, `shouldMarkSuspicious` |
| `src/utils/grade.ts` | `computeWeightedGrade(items)` — núcleo del cálculo de notas |

---

## Modelo de pesos / cortes (post-migración 20260507100000)

Cada item (examen, taller, proyecto) y la asistencia de un corte tienen un peso que es **% de la nota final del curso**, no relativo dentro de un bucket.

```
cut.weight              = % de la nota final que aporta el corte (cuts suman 100)
cut.workshop_weight     = bucket: cuánto del corte vale TODOS los talleres juntos
cut.exam_weight         = bucket: cuánto del corte vale TODOS los exámenes juntos
cut.project_weight      = bucket: cuánto del corte vale TODOS los proyectos juntos
cut.attendance_weight   = bucket: cuánto del corte vale la asistencia
exam.weight             = % de la nota final para ese examen (cap = exam_weight bucket)
workshop.weight         = % de la nota final para ese taller (cap = workshop_weight bucket)
project.weight          = % de la nota final para ese proyecto (cap = project_weight bucket)

REGLA: workshop_weight + exam_weight + project_weight + attendance_weight = cut.weight.
       Y items del mismo tipo no pueden exceder su bucket. CutsEditor valida ambas
       y los forms de cada item muestran "te queda X disponible" del bucket.
```

Migración 20260507130000 hizo backfill: para cada cut puso `workshop_weight = sum(workshops.weight asignados al corte)` etc, así que el comportamiento previo se preserva.

**Cálculo** (`computeWeightedGrade(items)`): weighted average. Items con `score=null` **cuentan como 0** con su peso original (NO se reescalan). Eso refleja la realidad del estudiante: lo que debe y todavía no entregó/no tiene nota es nota perdida hasta que aparezca. Solo retorna `null` (UI muestra "—") cuando NINGÚN item del set tiene score. Misma regla en `computeCutGrade` y `computeCourseFinalGrade`.

**Asistencia → corte**: `attendance_sessions` NO tiene `cut_id`. La pertenencia se deriva por fechas: una sesión cuenta para el corte X si `session_date` está entre `cut.start_date` y `cut.end_date`. El score de asistencia del corte es `presentes / sesionesEnCorte` escalado a la escala del curso, y entra al weighted avg con `weight = cut.attendance_weight`. Implementado idéntico en `app.student.grades.tsx` y `app.teacher.gradebook.tsx`.

**Forms de items**: input de Peso disabled cuando no hay corte; max = `cut.weight`.

---

## Módulo de examen estudiantil — decisiones de diseño

### Session lock (sin migración DB)
Usa `answers.__session_id` (dentro del JSONB existente) + `updated_at` como heartbeat implícito (autosave cada 1.5s). Ventana de expiración: 10s. No se necesitan columnas adicionales.

```ts
// localStorage key: examlab_exam_session_${examId}
function getOrCreateLocalSession(examId: string): string { ... }
```

### Proctoring — `recordWarning(type)`
Definida dentro del proctoring `useEffect` con deps `[started, performSubmit]`. Usa `blurLockUntil` (debounce 500ms) para evitar strikes rápidos. Hace fire-and-forget a Supabase + el autosave de 1.5s recoge lo que falle.

**IMPORTANTE:** Para el botón "Atrás" del navegador, el modal de confirmación hace `await supabase.update(...)` antes de `navigate()` — esto es crítico porque el componente se desmonta al navegar y el autosave timer se cancela.

### Esc bloqueado durante el examen
El listener `onKeyDown` global (capture phase) intercepta Escape con `preventDefault + stopPropagation`. Eso impide que cierre dialogs del SPA o cancele otros defaults del navegador. **NO evita que el navegador salga de fullscreen al pulsar Esc** — esa salida la maneja el SO/browser y JavaScript no puede interceptarla. Cuando ocurre, `fullscreenchange` dispara y `recordWarning("fullscreen_exit")` suma el strike.

### Navegación secuencial vs libre
- `exam.navigation_type === "secuencial"`: botón "Anterior" siempre deshabilitado; botón "Siguiente" abre modal de confirmación cada vez (warning sobre que no podrá regresar).
- `libre`: comportamiento normal, "Anterior" disabled solo en `currentIdx === 0`.
- Siempre se renderiza una sola pregunta a la vez (`const visible = [questions[currentIdx]].filter(Boolean)`).

### Timer
Solo `computeSecondsLeft(exam?.end_time)`. El hook `useRealtimeTimer` inicializa una sola vez cuando `initialSeconds > 0`. No intentar calcular tiempo efectivo por estudiante.

### Offline sync
`clearLocalAnswers(examId)` debe llamarse antes de crear una nueva fila de submission, para evitar el toast "X respuesta(s) sincronizada(s)" cuando el docente borra la sesión anterior.

### Suspensión / entrega — fire-and-forget
`performSubmit` await SOLO el `submissions.update` (la entrega real). La notificación al docente vía RPC y la calificación con IA (`ai-grade-submission` edge function, ~5-15s) se disparan con `void` sin await. El alumno ve "Examen suspendido/entregado" en ~300ms en vez de ~10s. El servidor termina las tareas en background aunque el cliente navegue a otra ruta.

---

## Features adicionales

### Actividades externas (`is_external` en exams, workshops y projects)
Para parciales/talleres/proyectos que ya pasaron fuera de la plataforma (presencial o virtual en otra herramienta) y solo se registran notas. Toggle en el dialog de creación esconde campos sin sentido (duración/navegación/proctoring/preguntas para examen, archivos esperados/instrucciones para proyecto). El editor de notas externas (`ExternalGradesEditor`) lista a los matriculados con columnas Nota + **Observación** (campo libre por estudiante), y guarda en `submissions.{final_override_grade, teacher_feedback}` / `workshop_submissions.{final_grade, teacher_feedback}` / `project_submissions.{final_grade, teacher_feedback}`. La columna `submissions.teacher_feedback` la agregó la migración 20260507130000.

### Detección de fraude (FraudPanel)
- **Análisis IA por entrega**: cada calificación con IA puebla `submissions.ai_detected_score / ai_detected_reasons` (0..1 + razones). Threshold 0.6 marca `ai_detected = true` y status `sospechoso`.
- **Plagio entre estudiantes**: edge function `detect-plagiarism` compara entregas pares vía Gemini, persiste en tabla `similarity_pairs (kind, ref_id, score, reasons)`. RLS solo docente/admin.
- `<FraudPanel kind refId>` reutilizable en monitor de examen, dialog de calificación de taller, dialog de entregas de proyecto.

### Selección de modelo de IA (tabla `ai_model_settings`)
Una sola configuración global activa a la vez (UNIQUE PARTIAL idx sobre `is_active=true`). Solo Admin escribe.

- Providers V1: `lovable` (Gemini via gateway) y `openai` (gpt-4o, gpt-4o-mini, etc).
- API keys NO se guardan en DB — viven como env vars en Lovable (`LOVABLE_API_KEY`, `OPENAI_API_KEY`). La tabla solo elige `provider` + `model`.
- Edge function lee la fila activa via `getActiveAiModel()` y construye URL/auth/header según provider en el helper `aiChatCompletion(body)`. Ambos providers hablan el mismo formato OpenAI chat-completions, así que el body (messages/tools/tool_choice) viaja idéntico — solo cambia `model`.
- UI Admin en `app.admin.ai-prompts.tsx` con tabs: **Prompts** (editor de los 5 use_cases globales) + **Modelo** (provider + model). El path se mantuvo por compatibilidad.

### Prompts de IA customizables (tabla `ai_prompts`)
Sistema de overrides de prompts para los modelos de IA, separado por **caso de uso** (no por módulo):

- 5 use cases: `workshop_full`, `workshop_question`, `project_file`, `project_full`, `exam_question`.
- Una fila por `(use_case, course_id)`. `course_id IS NULL` = prompt global del sistema (lo edita Admin). `course_id` no-null = override del curso (lo edita el docente del curso).
- El edge `ai-grade-submission` resuelve via `resolveSystemPrompt(useCase, courseId, fallback)`: course override gana al global, fallback al texto hardcodeado si la tabla está vacía.
- **Solo se persiste el system prompt** (rol/criterios). Los datos dinámicos (rúbrica, respuesta, idioma, puntaje máx.) se inyectan en el `user` message desde el código — el admin/docente no puede romper el contrato olvidando un placeholder.
- UI: `app/admin/ai-prompts.tsx` (CRUD globales, restaurar default), `app/teacher/ai-prompts.tsx` (selector de curso, ver global de referencia, override editable, "Volver al global" elimina la fila).
- RLS: SELECT abierto a authenticated; INSERT/UPDATE/DELETE de globales solo Admin; de overrides solo docente del curso (vía `course_teachers`) o Admin.

### Asistencia self check-in con QR rotativo (TOTP-like)
Los estudiantes se marcan presentes solos para que el docente no tenga que llamar uno a uno.

- **DB**: `attendance_sessions.check_in_open` (visible a todos) + tabla privada `attendance_check_in_state(session_id, seed, rotation_seconds, opened_at, closes_at)` con RLS Docente/Admin only — la **seed nunca llega al estudiante**.
- **Código**: derivación TOTP-like — `sha256(seed || ":" || period)[:7 hex] % 1000000` con `period = floor(epoch/rotation_seconds)`. La función SQL `compute_attendance_code(seed, period)` y el JS `computeAttendanceCode()` en [src/lib/attendance-code.ts](src/lib/attendance-code.ts) **deben coincidir bit-a-bit**.
- **Validación**: el estudiante llama `student_check_in_attendance(session_id, code)` SECURITY DEFINER, que acepta el código del período actual y el anterior (gracia de rotación). Verifica matrícula, ventana abierta, no expirada.
- **UI Docente** ([AttendanceCheckInProjector](src/components/AttendanceCheckInProjector.tsx)): overlay fullscreen vía Fullscreen API con QR + código + countdown + contador realtime de presentes (Supabase channel sobre `attendance_records` filtrado por `session_id`). Botón "Cerrar check-in" → opcional confirm "marcar pendientes como ausentes" → RPC `teacher_mark_pending_absent`.
- **UI Estudiante** ([AttendanceQRScanner](src/components/AttendanceQRScanner.tsx)): `html5-qrcode` (~50KB) escanea QR. Fallback input manual de 6 dígitos. Card "Check-in disponible" arriba de la vista de asistencia cuando hay sesiones con `check_in_open=true`.
- **Deep-link**: el QR codifica `https://<host>/app/student/attendance?session=X&code=Y`. Si el estudiante lo abre así (cámara nativa o desde la app), el effect en `app.student.attendance.tsx` parsea, llama RPC y limpia la URL con `history.replaceState`.
- **Parametrización**: cada inicio de check-in toma `duration_minutes` (default 10, rango 1-240) y `rotation_seconds` (default 60, rango 15-600) desde un dialog. No hay default global todavía — se agrega cuando se necesite.

### Proyectos: sustentación + link al repo obligatorio
La nota final del proyecto = `submission_grade × defense_factor`. Sin sustentación, `final_grade=null` (el estudiante ve "Falta sustentación").

- **DB** (migración 20260507170000): `project_submissions.submission_grade`, `defense_factor` (0..1, CHECK), `defense_notes`, `defense_at`, `repository_url`. Backfill: para entregas ya calificadas pone `submission_grade = final_grade` y `defense_factor = 1` para preservar el comportamiento previo.
- **Estudiante**: el `submit` exige un link `https?://...` (validación en cliente, columna NULLABLE en DB para no romper históricos). La IA califica → llena `submission_grade`, deja `final_grade=null`. UI explica que la nota final llega tras la sustentación.
- **Docente**: en el dialog de calificación se muestra el link prominente con borde ámbar y advertencia "verificar fechas vs entrega". Cada submission tiene un `<DefensePanel>` con: nota entrega + input factor 0–1 + preview de nota final + notas + botón "Guardar sustentación". Al guardar persiste `defense_factor`/`defense_notes`/`defense_at` y recalcula `final_grade = submission_grade × factor`.
- **Verificación de fechas vs commits**: el sistema solo persiste el link y la fecha de entrega — la comparación contra fechas de modificación del repo es manual del docente. La verificación automática vía API de GitHub/Drive queda como mejora futura (requiere OAuth y casos edge).

### Proyectos: entrega de código completo en ZIP (`type='codigo_zip'`)
Slot adicional en `project_files` para que el estudiante suba un ZIP con todo su código fuente. Diagramas y documentos siguen entregándose en preguntas separadas (tipo `abierta`/`diagrama`/etc).

- **DB** (migración 20260507160000): bucket `project-files` (100MB max), columna `project_submission_files.zip_path`, nuevo tipo `codigo_zip` permitido en `project_files.type`. RLS de Storage: estudiante sube/lee/borra los suyos; docente/admin lee todos.
- **UI Docente** ([ProjectFiles.tsx](src/components/ProjectFiles.tsx)): nuevo item "Código completo (ZIP)" en el selector de tipo del slot. La generación con IA NO ofrece este tipo — debe configurarse manualmente.
- **UI Estudiante**: input `<input type="file" accept=".zip">` cuando el slot es `codigo_zip`. Al enviar, sube a `project-files/<user_id>/<submission_id>/<file_id>.zip` y persiste `zip_path` en `project_submission_files`.
- **Edge function** (`ai-grade-submission`, modo `projectCodeZipGrading`): descarga el ZIP via `adminClient.storage.from('project-files').download()`, descomprime con `fflate`, **filtra por whitelist de extensiones de código** (.java, .py, .js/.ts/.tsx, .c/.cpp, .cs, .go, .rs, etc + makefile/dockerfile), trunca archivos >50KB, tope global 200K chars, concatena con encabezado `─── path ───` y manda al modelo. Usa el system prompt `project_full`.
- **Caso vacío**: si el ZIP no contiene archivos de código reconocidos, retorna grade=0 con feedback claro al estudiante.

### Trabajo en grupo en talleres y proyectos (V1: teacher_assigned, modo MIXTO)
Para que un grupo de N estudiantes comparta UNA misma entrega y reciba la misma nota. Replicado idéntico en talleres y proyectos.

- **DB** (migraciones 20260507150000 talleres y 20260507180000 proyectos): `workshops.group_mode` / `projects.group_mode` (`individual` | `teacher_assigned` | `self_signup` — V1 expone solo individual y teacher_assigned). Tablas `{workshop|project}_groups(id, {workshop|project}_id, name, signup_code)` + `{workshop|project}_group_members(group_id, user_id)` con trigger que evita estar en >1 grupo del mismo taller/proyecto. Columna `{workshop|project}_submissions.group_id` (cuando hay grupo, la submission pertenece al grupo).
- **RLS**: groups y members con SELECT abierto + write Docente/Admin. `*_submissions` extendido a "dueño O miembro del grupo de la submission O Docente/Admin" en SELECT/INSERT/UPDATE — eso permite que cualquier miembro del grupo edite la misma fila.
- **Modo MIXTO**: en un mismo taller/proyecto con `group_mode != 'individual'` pueden coexistir estudiantes con grupo (entregan en grupo, comparten una sola entrega y nota) y sin grupo (entregan individual). El estudiante sin grupo NO se bloquea — entrega normalmente. La UI no muestra warnings de "espera a tu grupo".
- **UI Docente**: toggle "Trabajo en grupo" en el form (solo cuando NO es externo). Botón "Grupos"/"Activar grupos" en el grid (icono UsersRound) — siempre visible para items no-externos. Click sin grupos activos auto-activa `teacher_assigned`. Abre [WorkshopGroupsEditor](src/components/WorkshopGroupsEditor.tsx) o [ProjectGroupsEditor](src/components/ProjectGroupsEditor.tsx) con **drag & drop nativo** (HTML5 drag API, sin librería) — arrastrar tarjeta de estudiante entre "Sin grupo" y los grupos creados; ring visual en drop target.
- **UI Estudiante**: en `app.student.workshops.tsx` y `app.student.projects.tsx` la query de submission filtra por `group_id` cuando aplica (cualquier miembro ve la misma entrega), y por `user_id` cuando no (modo individual o mixto sin grupo). Card "Tu grupo: X" arriba solo si `myGroup != null`.
- **Submission compartida**: `StudentWorkshopTaker` y `StudentProjectTaker` aceptan prop `groupId`. La query existente y el INSERT incluyen `group_id` cuando hay grupo. `user_id` se mantiene como "último editor".
- **Notificación de calificación**: `saveGrade` lee `submission.group_id`; si existe, inserta una notificación por cada miembro del grupo. Caso individual: solo al `user_id`.
- **Self-signup**: queda para V2. La columna `signup_code` ya está en la tabla para no migrar después.

### Notificaciones realtime + push
`use-notifications.ts` hace polling cada 15s + Supabase realtime + refetch al volver al tab. Toast aparece en first-load detection. Set de IDs a nivel de módulo deduplica entre múltiples instancias del hook (sidebar bell + mobile header bell + dashboard). Si tab oculto, push via Service Worker.

---

## Convenciones de código

- **Toda fecha visible al usuario** debe pasar por los helpers de `src/lib/format.ts`. NO usar `new Date(x).toLocaleString()` directo en JSX.
- **Decimales en inputs de notas**: usar `<DecimalInput>`. Texto de ayuda "Decimales con coma (ej. 4,5)" cerca del input.
- **Acciones de fila en tablas/grids**: `<RowAction label icon onClick />`. NO `<Button variant="ghost" title>`.
- **Loaders**: `<Spinner size>` o `<SectionLoader>` / `<PageLoader>`. NO `<Loader2 className="h-4 w-4 animate-spin">` directo.
- **Estados de submission/workshop/etc.**: `<StatusBadge status>`. NO `<Badge>` con clases ad-hoc.
- **Confirmaciones**: `useConfirm()`. NO Dialog custom para confirmar.
- **Patrón de campos desactivados** (memoria de feedback): cuando un flag UI desactiva un grupo de campos, **omitirlos del INSERT/UPDATE** payload en lugar de mandar dummies. Evita errores tipo "Could not find the 'X' column in schema cache" cuando hay schema cache stale.
- **Headers de páginas de detalle**: usar `<PageHeader backTo title subtitle actions />`. NO duplicar el patrón Volver+h1 inline.

## Notas de git

- Al agregar archivos con `$` en el nombre, usar comillas simples:
  ```bash
  git add 'src/routes/app.student.take.$examId.tsx'
  ```
- `git push origin main` después de commit. NO `--force`. Si remote avanzó (Lovable empuja a veces), `git pull --rebase origin main` antes de pushear.
- Warnings tipo "LF will be replaced by CRLF" son normales en Windows — ignorar.

# Barrido de UI/UX, traducción y manejo de errores — 2026-08-23

Workflow `barrido-ui-i18n-errores` (9 agentes, 4 frentes con verificación adversarial).
32 sobrevivieron; 2 descartados.

> Sobrevivió el 94%, alto para un pase adversarial. Tratar como CANDIDATOS.
> Los marcados como verificados por mí llevan nota en el CHANGELOG.

## Plan priorizado

# Lista de trabajo priorizada

## ALTA

### 1. `.github/workflows/deploy-edge-functions.yml:264` — el deploy resetea `verify_jwt` de 11 edge functions
**Qué ve el usuario:** nada, y por eso es lo primero. Están muertos en producción: el cron de reintento de calificaciones IA (una entrega con error transitorio queda "Error IA" para siempre), el drenado por cron de las dos colas (`ai-grading-worker`, `ai-generation-worker`), el backup semanal de la base y la sync de grabaciones del calendario. En Cola IA → Generaciones el docente ve `HTTP 401: UNAUTHORIZED_INVALID_JWT_FORMAT`. El workflow termina en verde.

**Fix:** el heredoc de 264-272 escribe un `config.toml` a mano con solo 2 bloques y el CLI despliega desde `/tmp/sb-deploy`, así que las otras 11 vuelven a `verify_jwt=true`. Generar ese archivo DESDE `supabase/config.toml` (parsear los bloques `[functions."x"]` y emitir su `verify_jwt`; si las claves viejas rompen al CLI, emitir solo `project_id` + los bloques `[functions.*]`). Agregar un guard que **falle el run** si alguna función con `verify_jwt=false` en el repo no quedó en el config generado. Verificar post-deploy con `GET` sin header `Authorization`: debe responder el handler, no `UNAUTHORIZED_NO_AUTH_HEADER`.

**Cross-file:** esto crea de hecho un invariante nuevo `supabase/config.toml` ↔ `deploy-edge-functions.yml`. Si se resuelve derivando el config, el invariante desaparece; si se deja la copia a mano, hay que documentarlo en la tabla de CLAUDE.md, porque tres commits distintos (640c6e8b, e52596d3, c5881ff1) agregaron `verify_jwt=false` y ninguno llegó al remoto.

---

### 2. `src/routes/app.index.tsx:857, 1039, 1062` — el dashboard del docente muestra los cursos de otros docentes
**Qué ve el usuario:** el docente entra a `/app` y en "Próximas clases" ve clases de cursos que no dicta, en "Próximos exámenes" exámenes de otros docentes, y el tile "Sesiones hoy" cuenta las sesiones de toda la institución.

**Fix:** `const ids = await scopedCourseIds(activeRole, roles, userId)` de `src/modules/courses/course-scope.ts`. `null` → no acotar; `[]` → setear vacío y **no consultar** (un `.in(col, [])` devuelve TODAS las filas); con ids, `.in("course_id", ids)` en las tres queries. Borrar los comentarios "RLS recorta a sus cursos" (1036) y "RLS filtra por mis cursos" (~845): son la razón por la que el bug se repite en cada pantalla nueva. Las policies `attendance_sessions_select_in_tenant` (20261065) y `exams_select_in_tenant` (20261070) son tenant-wide para el Docente a propósito, no van a salvar.

**Cross-file:** es la regla dura "ALCANCE DE DATOS del docente → SIEMPRE por `course-scope.ts`" de CLAUDE.md. Agregar el dashboard a la lista de pantallas aplicadas.

---

### 3. Corrimiento de un día en columnas `DATE` (lote de 6 archivos, un solo criterio)
`formatDate`/`formatDateShort` sobre un string `YYYY-MM-DD` resta un día en toda zona negativa. La protección solo la tienen `formatDateOnly` y el variant `"auto"` de `DateCell`.

- `src/modules/admin/AdminAcademicPeriodsPanel.tsx:488` y `:491` — el picker dice "15 de ene de 2026", la tabla de la misma pantalla dice "14 ene 2026". Fix: `<DateCell value={r.start_date} />` **sin** `variant` (el `variant="date"` fuerza `formatDate` y saltea la rama auto).
- `src/routes/app.forum.$courseId.tsx:651` — el badge del foro dice "Sesión 23 ago" cuando el Select de la misma pantalla (554) dice "24 ago". Fix: `formatDateOnly`.
- `src/routes/app.forum.$courseId.$forumId.tsx:328` — ídem. **Misma pasada que el ítem 11.**
- `src/routes/app.teacher.whiteboards.index.tsx:1121` — el corrimiento está en el `SelectItem` con el que el docente **elige** la sesión: induce a elegir mal. Fix: `formatDateOnly`.
- `src/routes/app.teacher.attendance.tsx:2371` y `:2382` — copiar lo que el propio archivo ya hace en 1738/1899 (`formatDateShort(sess.session_date + "T12:00:00")`).

**Barrido de cierre:** revisar el resto de los `variant="date"` del repo y separar los que apuntan a columnas `date` de los que apuntan a `timestamptz`.

---

### 4. Vistas de revisión del alumno (lote de 4 archivos, una sola pasada)
Cuatro defectos que caen en las mismas líneas; se arreglan juntos.

**(a) ALTA — JSON crudo como "tu respuesta".** `src/routes/app.student.workshop.$workshopId.tsx:344` y `src/routes/app.student.project.$projectId.tsx:564`. El alumno ve `{"bdSql":1,"sql":"SELECT…","results":[…]}` en una pregunta de base de datos, `[0,2]` en opción múltiple y el volcado de topología en las de red. La misma pregunta en un **examen** se ve bien.
Fix: portar a `renderAnswer` las ramas de `app.student.review.$examId.tsx:585-604` — `bd_sql` → `sqlSourceForDisplay(raw)` + `sqlResultsForDisplay(raw)` en dos `<pre>`; `red_consola`/`red_gui` → `<NetworkAnswerReview options={q.options} value={raw} type={…} />`; `cerrada_multi` → `JSON.parse` + el bloque de choices con ring (el parse ya existe en `WorkshopQuestions.tsx:1467-1470`). En proyectos **no** hace falta la rama `cerrada`: `ProjectFiles.tsx:2238` ya guarda el texto de la opción.

**(b) MEDIA — el centinela interno se muestra como retroalimentación.** `app.student.workshops.tsx:727`, `app.student.projects.tsx:725`, `app.student.workshop.$workshopId.tsx:469` y `:519`, `app.student.project.$projectId.tsx:427` y `:578`. Con `processing_mode=async` el alumno ve el banner "Por calificar" y pegado abajo una card "Retroalimentación" cuyo único contenido es *"Pendiente IA — la calificación llegará al procesar la cola."* (P6: nombra el mecanismo).
Fix: en los `.filter(Boolean)` que arman el texto, excluir los valores cuyo `.trim() === PENDING_AI_FEEDBACK` y no montar la card si queda vacía. El `<PendingAiGradeBanner>` ya cubre el aviso; no reemplazarlo por otro texto.

**(c) BAJA — markdown crudo en el feedback (mismas líneas que (b)).** Si el docente escribe `**Fortalezas:**` en "Observación", el alumno ve los asteriscos; y en `app.student.workshop.$workshopId.tsx` el feedback por pregunta (519) sí se renderiza y el global (469) no.
Fix: envolver **solo** los bloques de retroalimentación en `<MarkdownInline>` y quitarles el `whitespace-pre-wrap` (trae `remarkBreaks`). Los dos archivos de proyecto necesitan el import. **No tocar** descripciones ni instrucciones: hoy son planas y consistentes entre exámenes/talleres/proyectos.

**(d) MEDIA — la card de instrucciones se titula "Talleres".** `app.student.workshop.$workshopId.tsx:421` → `t("teacherWorkshops.fieldInstructions")`. Líneas `:434` y `app.student.workshops.tsx:706` (el enlace al recurso externo, también rotulado "Talleres") → clave nueva `studentWorkshops.openResource` ("Abrir recurso del taller" / "Open workshop resource"), calcada de `hc_routesAppStudentProjectProjectId.openProjectResource`.

---

### 5. Detección de copias (lote `FraudPanel.tsx` + edge + 2 call sites)

**(a) ALTA — "sin coincidencias relevantes" se afirma sobre una clase comparada a medias.** `src/modules/exams/FraudPanel.tsx:429`. `MAX_ITEMS_PER_CALL = 30` con `slice(0, 30)` (`detect-plagiarism/index.ts:41, 419`), la respuesta no lleva cobertura, y la query de entregas (`:210`) no tiene `ORDER BY` → **cuáles 30** se comparan es no determinista. Con 93 matriculados el docente lee un veredicto sobre toda la clase.
Fix: acumular `skipped += group.items.length - items.length` en el loop y agregar `compared_items` / `skipped_items` al JSON de `:565-570`. En los 3 call sites (`FraudPanel.tsx:420-431`, `app.teacher.monitor.$examId.tsx:1502-1506`, `app.teacher.workshops.tsx:2231-2237`) con `skipped_items > 0` usar `toast.warning` con "Se compararon N de M respuestas por pregunta" y **nunca** emitir "sin coincidencias relevantes" como veredicto del curso. Fix de raíz: recorrer en ventanas de 30 + `.order("created_at")`.

**(b) MEDIA — P9 sin estado intermedio.** `FraudPanel.tsx:396` y `:694-703`: el edge itera las preguntas en serie (`:417-464`) y el único feedback es un `<Spinner size="sm">` dentro de un botón. Los pares SÍ se persisten en `similarity_pairs`, así que lo que se pierde es el toast, no el resultado.
Fix: `<LoadingOverlay>` con la promesa explícita ("Comparando las respuestas del curso con IA. Puede tomar varios minutos; podés cerrar esto y volver, el resultado queda guardado.") — el texto es cierto. Si se parte el edge por grupo, el patrón de progreso ya existe en `runRegradeLatestAll` del monitor.

**(c) BAJA — "3 student paires".** `FraudPanel.tsx:418` y `:878` pasan `plural: "es"` contra valores en inglés `pair{{plural}}`. Son los únicos 2 de los 15 call sites de `plural:` que pasan `"es"`.
Fix: pluralización nativa de i18next (`_one`/`_other`, como `audit.totalEvents`) para `studentPairsCount` y `suspiciousPairsLabel`, llamando `t(clave, { count })` sin `plural`/`pluralAdj`. Elimina de paso el `{{pluralAdj}}` que solo existe en el valor español.

---

## MEDIA

### 6. `src/routes/app.teacher.workshops.tsx` (lote, 3 defectos en un archivo)
**(a) `:1197` + `:1224` — editar un taller puede borrar sus vínculos a cursos.** `DELETE` y luego `INSERT` en `workshop_courses`, ninguno con chequeo de error, en dos requests HTTP. Si el insert falla, el taller queda sin `cut_id` ni `weight`, que es de donde leen el gradebook (`app.teacher.gradebook.tsx:427-429`) y las notas del alumno (`app.student.grades.tsx:197`) — y el toast dice "Taller guardado". Mismo patrón sin chequeo en `:1231`.
Fix: copiar el orden de proyectos (`app.teacher.projects.tsx:1185-1188`): **upsert** con `onConflict: "workshop_id,course_id"` + revisión de error + toast, y borrar los sobrantes después. Nunca destruir primero. Mejor aún, una RPC `SECURITY INVOKER` que haga el sync M:N en una transacción.

**(b) `:687-704` (`autoAssignWorkshop`) — asignación silenciosa.** El insert en `workshop_assignments` no destructura error, y el select de `course_enrollments` (`:688`) tampoco: si falla, `enr` queda vacío y retorna sin asignar a nadie. Como la rama de estudiante de `workshops_select_in_tenant` exige `EXISTS` en assignments, el taller queda invisible para todo el curso — y la notificación ya salió. El hermano `autoAssignExam` (`app.teacher.exams.index.tsx:362-389`) sí lo revisa, con comentario explicando por qué.
Fix: devolver el error, revisar también el del select, y en los call sites (`:1240`, `:1329`) acumular el primero y usar el patrón de bulk: `"Taller creado, pero no se pudo asignar a los estudiantes de N curso(s). Primero: «<curso>» — " + friendlyError(err)` con `duration: 12000`.

**(c) `:4686`** — etiqueta del tipo de pregunta: parte del ítem 7. **(d) `:2231`** — toast de cobertura: parte del ítem 5(a).

---

### 7. Etiqueta del tipo de pregunta: el alumno ve `Bd_sql`, `Cerrada_multi`, `Codigo_zip`
`text-transform: capitalize` no separa por `_` (es ExtendNumLet), así que el guion bajo queda a la vista. En la toma de **examen** el mismo tipo dice "Base de datos (SQL)". Violación directa de P6.

**Fix:** extraer `QUESTION_TYPE_LABEL_KEY` de `app.student.take.$examId.tsx:81-93` a `src/modules/exams/question-type-label.ts` exponiendo `questionTypeLabel(t, type)` (fallback al crudo solo defensivo), quitar el `capitalize` (las claves `questionBank.type` ya vienen capitalizadas) y aplicarlo en: `src/modules/workshops/WorkshopQuestions.tsx:2917` y `:758`, `src/components/ProjectFiles.tsx:3094` y `:864`, `src/routes/app.student.workshop.$workshopId.tsx:498`, `src/routes/app.teacher.workshops.tsx:4686`, `src/routes/app.student.review.$examId.tsx:511` (que hoy hace `q.type.replace(/_/g,' ')`).

**Cross-file:** al centralizar el mapa, el guardrail del `Record<QuestionType, string>` del diálogo de importación del banco sigue siendo el que rompe el build si falta un tipo — no silenciarlo. Agregar `questionBank.type.soConsola` en es/en como defensiva (ese tipo hoy no se puede crear desde los Selects de talleres).

---

### 8. `src/modules/workshops/WorkshopQuestions.tsx:845-846` — el Select de tipo ofrece "Opción múltiple" dos veces
Las dos líneas usan la MISMA clave `workshopQuestions.typeClosedSingle`, y su valor es "Opción múltiple". El docente elige a ciegas entre `cerrada` y `cerrada_multi`. `workshopQuestions.typeClosedMulti` no existe en ningún locale; `projectFiles` y `questionBank` ya tienen el par correcto.

**Fix:** en `es.json`/`en.json`, `workshopQuestions.typeClosedSingle` → "Selección única" / "Single choice", y agregar `workshopQuestions.typeClosedMulti` → "Opción múltiple" / "Multiple choice" (copiar los valores de `projectFiles`). Usar la clave nueva en `:846`; `:845` y `:1174` quedan con la etiqueta corregida. **Misma pasada que el ítem 7.**

---

### 9. Enunciados de encuesta sin markdown ni saltos de línea
`src/routes/app.student.polls.tsx:1381`, `:1445`, `:1500`; `src/routes/encuesta.$token.tsx:359`; `src/routes/app.teacher.polls.tsx:3815`. El enunciado va en un `<p>` pelado: asteriscos visibles **y** saltos colapsados, mientras la `description` de la misma encuesta (`:769`, `:1301`, `encuesta:296`) sí se renderiza. El input es un `<Textarea rows={2}>`, o sea multilínea por diseño.

**Fix:** sacar el numeral y el asterisco de obligatorio fuera del texto y envolver `q.text` en `<MarkdownInline>`, copiando `KahootReviewDialog.tsx:154`. Es la mitad que quedó afuera del commit `138b6dca`, que declaró la regla y arregló solo la descripción.

---

### 10. Separador decimal: coma en unas pantallas, punto en otras (a veces en la misma)
`toFixed()` emite punto sin importar el locale, contra el `DecimalInput` que bloquea el punto. En `/app/teacher/exams` la columna Peso dice "16,67%" y el diálogo de edición abierto encima dice "16.7% disponible".

**Fix:** reemplazar los `toFixed` **visibles** por `formatNumber(v, {minimumFractionDigits:2, maximumFractionDigits:2})` y `formatPercent(v)` de `src/shared/lib/format.ts`. Sitios: `app.student.grades.tsx:606` (el helper `fmt`), `:907`, `:938`; `app.teacher.exams.index.tsx:1304, 1307, 1394, 1396, 1401`; `app.teacher.exams.$examId.tsx:1618, 1620, 1625`; `app.teacher.gradebook.tsx:2328, 2341, 2663, 2745-2763, 2892, 2960, 3009`; `app.certificates.tsx:585, 603`; `app.student.certificates.tsx:454`. **No tocar** los `toFixed` que alimentan CSV/export ni cálculos.

**Cross-file:** es el invariante "LOCALE = es-CO hardcoded en `format.ts`". Hay dos precedentes que lo resuelven a mano (`EarlyAlertCard.tsx:67`, `app.superadmin.tenants.tsx:121-122`) — al centralizar, conviene migrarlos también.

---

### 11. `src/routes/app.forum.$courseId.$forumId.tsx:532` — el preview del hilo renderiza un bloque de código dentro de un `line-clamp-2`
`<MarkdownInline>{thread.body.slice(0, 200)}</MarkdownInline>` con `pre` permitido: un hilo que empieza con ``` muestra una caja gris recortada, y si el `slice` corta la cerca sin cerrar, todo el preview se vuelve código. El placeholder del campo invita a usar Markdown.

**Fix:** `<p className="text-xs text-muted-foreground mt-1 line-clamp-2">{markdownToPlainPreview(thread.body, 200)}</p>` (de `@/shared/lib/markdown-plain`) y borrar el `.slice(0,200)` manual — el helper recorta en el último espacio. El detalle del hilo sigue con `MarkdownInline`. **Misma pasada que el ítem 3** (`:328`).

---

### 12. `src/routes/app.teacher.monitor.$examId.tsx:396` — el monitor se queda en "Cargando…" para siempre
`load()` descarta el error de las cinco queries y el render solo distingue `!exam` → "Cargando…". Camino determinístico: el docente pulsa la notificación de "examen sospechoso" de un examen que después mandó a la papelera (la query lleva `.is("deleted_at", null)`) → pantalla colgada, sin error ni reintentar. Camino transitorio: un 5xx durante el examen en vivo deja `setSubmissions([])`, o sea "ningún alumno rindiendo", hasta el tick de 60 s.

**Fix:** destructurar el error a un state `loadError` y distinguir tres casos: cargando (`Spinner`), error (`<ErrorState message="No se pudo cargar el monitor" hint={loadError} onRetry={() => void load()} />`, patrón de `app.index.tsx:1090`) y no-encontrado ("Este examen ya no existe o está en la papelera" + `BackLink`). Y **no pisar** `submissions` con `[]` cuando la query falló.
**En la misma pasada (baja, parte de P7):** truncar el `institutional_email` de la celda Estudiante (`:2356-2361`) con `truncate max-w-40` + `title` — es uno de los dos motores reales del scroll horizontal. Ver "no tocar ahora" por el resto de ese hallazgo.

---

### 13. `src/modules/admin/AuditLogsView.tsx` (dos defectos, una pasada)
**(a) `:796` — la fila es la única puerta y es un `<tr>` pelado.** Un usuario de teclado no puede abrir el detalle del evento; el `<ChevronRight>` de `:897` es decorativo. Sirve a `/app/admin/audit-logs` y `/app/teacher/audit-logs`.
Fix: `role="button" tabIndex={0}` + `onKeyDown` para Enter/Space con `preventDefault` + `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`, exactamente el patrón de `Stat` en `app.index.tsx:1744-1762`.

**(b) `:760-783` — la columna "Acción" colapsa a 48px en modo Admin.** La suma declarada es 936px > 900 (P7) y "Acción" es la única sin `w-*`, así que absorbe el déficit: a 1280×800 queda en 3 caracteres, y `useColumnResize` solo re-mide en el cambio del media query de 640px, así que maximizar no lo recupera.
Fix: `Actor` w-48→`w-40`; `Entidad` w-40→`hidden lg:table-cell w-36`; `Curso` w-40→`hidden lg:table-cell w-36`; `Fecha` w-36→`w-32` (≈856px), y `min-w-48` explícito en "Acción". Mover las celdas del body (`:861-880`) con el mismo `hidden lg:table-cell` y ajustar `cols`/`colSpan` de `TableSkeleton`/`TableEmpty` (`:787-790`).

---

### 14. Filas inalcanzables por teclado en Soporte y Estadísticas
`src/routes/app.admin.support.tsx:658`, `src/routes/app.superadmin.support.tsx:448`, `src/routes/app.admin.statistics.tsx:627`. Mismo fix de teclado que 13(a). **Además:** en los dos Soporte el `RowActionsMenu` tiene un solo item, "Eliminar" — la única acción alcanzable por teclado en la fila es la destructiva. Agregar "Ver detalle" (icono `Eye`) como **primer** item del menú.

---

### 15. `src/modules/search/global-search.ts:322` — ⌘K le muestra al estudiante exámenes en borrador y externos
`searchExams` no selecciona `status` ni `is_external` y solo filtra por `studentExamIds`. Que un examen borrador tenga assignments es lo normal: `autoAssignExam` corre incondicionalmente tras el insert (`app.teacher.exams.index.tsx:673`). El alumno encuentra el título y al pulsarlo cae en una lista que no lo tiene.

**Fix:** agregar `status, is_external` al select y, en la rama `!s.staff`, aplicar el predicado que `searchWorkshops` (`:386`) y `searchProjects` (`:447`) ya usan con el comentario "Paridad con la vista del alumno": `rows.filter((r) => !r.is_external && (r.status ?? "published") !== "draft")`.

---

### 16. `src/routes/app.admin.courses.tsx:1680-1769` — duplicar un curso copia a medias y dice "Curso duplicado correctamente"
Los pasos 3 (docentes), 4 (exámenes + preguntas) y 5 (talleres) no destructuran error, y el paso 4 tiene un `if (newExam)` sin `else`. Camino determinístico: cuando un **Docente** duplica con "copiar docentes", el batch incluye su propia fila y `course_teachers_docente_manage_others` exige `user_id <> auth.uid()` → 42501 rechaza la sentencia entera y no se copia ningún co-docente. El componente se reusa en `/app/teacher/courses`.

**Fix:** acumular el primer error de cada paso en `firstCopyError` + contar copiados, y reemplazar el `toast.success` (`:1816`) por el patrón de bulk: `"Curso creado, pero la copia quedó incompleta: N de M exámenes. Primero: «<título>» — " + friendlyError(err)` con `duration: 12000`. Aplicarlo también al insert de `questions` (para no dejar exámenes vacíos en silencio). Para `course_teachers`, filtrar la propia fila del batch (`ct.filter((t) => t.user_id !== user?.id)`) — el trigger `tg_course_add_creator_teacher` ya la crea. Los pasos 2 y 6 del mismo bloque ya hacen esto bien: copiar su forma.

---

### 17. `src/routes/app.teacher.calendar.tsx:247` — el "Paso 1" se reemplaza por el JSON de Google
`catch (e) { setCalendarsError((e as Error).message) }` y ese string se renderiza crudo en el `<Alert>` de `:465-468`, en el lugar del selector de calendario. Con el token revocado o caducado (7 días en modo testing de Google) el docente lee `Google refresh falló [400]: {"error":"invalid_grant"…}` o `not_connected`, sin que el mensaje nombre la única salida (el botón "Desconectar" de `:448`). Viola P6.

**Fix:** un mapa CÓDIGO → `t(...)` compartido por `loadCalendars` y `handleSync`: `not_connected` / `invalid_grant` / "refresh falló" → "Se venció el permiso de tu cuenta de Google. Reconéctala para seguir sincronizando"; más `provider_mismatch`, `no_calendar_selected`, `calendar_not_accessible` y un fallback genérico en español — nunca `(e as Error).message`. Renderizar el botón "Reconectar" (`handleConnect`) dentro de la alerta en el caso de credencial vencida. **Ojo:** `friendlyError` no sirve acá (no son SQLSTATE ni errores de red), sacaría el mismo texto crudo. `handleSync` (`:334-357`) ya tiene el patrón correcto.

---

### 18. `src/modules/code/CodeRunnerPicker.tsx:121` y `:128` — inglés hardcodeado en la pantalla de examen
El archivo no tiene un solo `t()`. El usuario en español —o sea todos, porque la app arranca siempre en `es`— lee "(default)" al lado del compilador del admin y el chip "Override" al cambiarlo, durante un examen. "Override" además es jerga de mecanismo (P6).

**Fix:** `useTranslation` y las 4 cadenas: `:96` `codeRunner.compilerLabel`, `:111` `codeRunner.useDefault`, `:121` `codeRunner.isDefaultSuffix` ("(predeterminado)"), `:128` `codeRunner.overridden` ("Cambiado"). En `LABELS` (`:45-50`) separar el nombre propio del sufijo: `` `CheerpJ (${t("codeRunner.inBrowser")})` ``. Registrar en `es.json` **y** `en.json` (`keys-registered.test.ts` exige los dos). Prioridad real: `:121` y `:128`. Se ve además en `WorkshopQuestions.tsx:3003`, `ProjectFiles.tsx:3175` y `CodePageEditor.tsx:319`.

---

## BAJA

### 19. Fecha ISO cruda en el tablero y en Contenidos
`src/routes/app.teacher.board.$courseId.tsx:1628` y `:1797` (badge y `SelectItem` de "Subir material a…") y `src/routes/app.teacher.contents.tsx:3493` (diálogo "Asignar sesiones") pintan `{s.session_date}` crudo: "2026-08-24". La fecha es correcta, es solo formato — y el mismo archivo ya usa `formatDateOnly` bien en `:1141`.
**Fix:** `formatDateOnly` (ya importado en board `:48`; en contents hay que agregar el import) o `<DateCell value={s.session_date} />`. **Misma familia que el ítem 3.**

### 20. `src/components/ui/dialog.tsx:69` y `src/components/ui/sheet.tsx:74` — la X se anuncia "Close"
Es el único nombre accesible del botón de cerrar de los 91 archivos que importan `dialog`, y del drawer del sidebar en móvil. Un lector de pantalla en español oye "Close".
**Fix:** `{t("common.close")}` con `useTranslation` — la clave ya existe en ambos locales, no hay nada que registrar. **No tocar** `carousel.tsx`, `breadcrumb.tsx` ni `sidebar.tsx:280`: boilerplate sin importadores reales. Dos líneas, hacerlo junto con cualquier otra pasada de i18n.

### 21. `src/modules/exams/exam-notes-notify.ts:52` — notificaciones hardcodeadas en español
"Nota de apoyo aprobada/rechazada" y, en `app.teacher.exams.$examId.tsx:999` y `:1052`, "Examen asignado". Talleres y proyectos ya usan `i18n.t` para lo mismo (`app.teacher.workshops.tsx:2820`).
**Fix:** claves `examNotes.reviewed*` + `examNotes.fallbackExamTitle`, registradas en es/en. **Obligatorio:** `src/modules/exams/exam-notes-notify.test.ts` assertea los literales españoles exactos y va a romper — migrarlo a comparar claves o forzar `lng:'es'`. Documentar en el docstring que el idioma queda congelado al del docente revisor. Impacto real bajo: en una institución en español no hay defecto visible.

### 22. `src/modules/admin/AdminPromptsPanel.tsx:862` y `:873` — nombres y descripciones de los prompts sin `t()`
**Fix (si se hace):** patrón de `AdminEmailSettingsPanel.tsx:579-585` — `t(\`adminPromptsPanel.useCase_${uc.key}_label\`, { defaultValue: uc.label })`, y lo mismo en los otros 5 usos de `uc.label` (`:565, 576, 592, 649, 659`). Ver la nota en "no tocar ahora".

### 23. `src/routes/auth.index.tsx:41` — el título de la pestaña no reacciona al cambio de idioma
Tras elegir English en el switcher de `/auth`, el formulario se traduce y la pestaña sigue diciendo "Iniciar sesión — ExamLab".
**Fix:** dejar el `head` como fallback y en el componente `useEffect(() => { document.title = t("auth.pageTitleLogin"); }, [t])` — el `head` se evalúa una vez al matchear la ruta y no se re-evalúa en `changeLanguage`, así que moverle un `i18n.t` no arregla el caso alcanzable. Ídem `auth.reset-password.tsx:42`, `auth.confirm-email-change.tsx:40`, `auth.cancel-email-change.tsx:28`, `auth.sso-callback.tsx:36`. **No aplica** a `asistencia.tsx` ni `encuesta.$token.tsx` (no tienen switcher, título y contenido salen ambos en español) ni a `reto.$pin.tsx:56` (es marca).

---

## (a) Deuda ya documentada como limitación aceptada — no abrir como bug

- **Feedback de IA en texto plano.** `FEEDBACK_PLAINTEXT_RULE` (`ai-grade-submission/index.ts:492`) instruye al modelo a no emitir markdown, con el comentario "La UI no renderiza Markdown". El ítem 4(c) queda limitado al texto escrito a mano por el docente; no hay que tocar el prompt.
- **Descripciones e instrucciones planas.** `workshop.description`, `workshop.instructions`, `project.description` y `exam.description` (`app.student.exams.tsx:596`) se pintan todas planas: es **consistente** entre los tres módulos y ningún campo del formulario anuncia markdown. Renderizarlas es decisión de producto, no fix.
- **`so_consola` sin clave i18n.** El tipo no está en los Selects de `WorkshopQuestions` (`845-857`, `1179-1185`), así que hoy no se puede crear desde la UI. La clave va como defensiva dentro del ítem 7, no como trabajo propio.
- **Notificaciones creadas por triggers SQL en español.** Límite del patrón server-side; el ítem 21 solo alinea los 3 inserts del cliente.
- **`P0001` de `RAISE EXCEPTION` en español.** `db-errors.ts:133` deja pasar el mensaje crudo del servidor: es límite del origen, documentarlo y no perseguirlo.
- **`SystemDiagnosticsPanel.tsx:391-392` ("Push de prueba" hardcodeado).** El insert usa `user_id: u.user.id` — se auto-notifica al mismo Admin que apretó el botón. Impacto nulo; sacarlo del alcance.
- **Monitor y gradebook excluidos de `<Table resizable>`.** CLAUDE.md ya los clasifica como matrices, no grids de listado. No convertirlos.

## (b) No conviene tocar ahora — el riesgo del cambio supera al del defecto

- **`src/shared/lib/db-errors.ts` — i18n de toda la capa de errores.** 1079 call sites de `friendlyError`, 56 fallbacks hardcodeados en los callers y `db-errors.test.ts` asserteando literales españoles exactos. Y el beneficio hoy es **nulo**: `src/i18n/index.ts:33` fija `lng:'es'` e i18next no consulta el detector cuando `lng` viene seteado, así que la app arranca siempre en español y la elección se pierde al recargar. **Precondición:** arreglar el pin de `lng` primero. Mientras nadie navegue en inglés más de una sesión, esto es refactor sin usuario.
- **`AdminPromptsPanel` (ítem 22) — traducir solo las etiquetas.** El cuerpo de cada card es el `defaultPrompt`: 300-600 caracteres de español que el admin edita. Traducir el título deja la pantalla igual de inservible para quien no lee español; hacerlo suelto es trabajo que no cambia el resultado. Va junto con los prompts o no va.
- **`app.teacher.monitor.$examId.tsx:2259` — P7, colapsar la columna "Acciones" a `RowActionsMenu`.** El conteo de 11 columnas en `lg` es real, pero la tabla está en `overflow-x-auto` dentro de su Card (el patrón que el design system bendice) y nada muestra dato incorrecto. Meter un clic extra para "Pausar" y "+5 min" en la pantalla que se usa a contrarreloj durante un examen en vivo es peor que el scroll. Hacer solo la parte segura (truncar el email, ítem 12) y dejar el resto; si se retoma, subir a `hidden xl:table-cell` las tres columnas de diagnóstico (`Intentos` `:2266`, `IA` `:2297`, `Copia` `:2303`, ya consolidadas en `IntegrityReviewDialog`) y derivar los `colSpan={11}` de una constante.
- **`detect-plagiarism` — el fix de raíz (ventanas de 30) antes que el mensaje.** Recorrer todas las entregas multiplica las llamadas a IA por `ceil(N/30)` en un curso de 93 alumnos, con failover de keys encima. Primero el `skipped_items` + el toast honesto (barato, elimina el veredicto falso); el barrido completo se decide midiendo el costo, y con `processing_mode` en cuenta.

---

## Crudo

```json
[
  {
    "titulo": "Las fechas de sesión (columna DATE) se muestran un día antes",
    "archivo": "src/routes/app.forum.$courseId.tsx",
    "linea": 651,
    "rol": "Estudiante y Docente",
    "real": true,
    "razon": "No se cae. `attendance_sessions.session_date` es `DATE NOT NULL` (20260419110000_attendance_grading_weights.sql:29) y PostgREST lo devuelve como \"YYYY-MM-DD\" crudo — la query del foro (línea 170) lo selecciona sin transformar. `formatDate` NO tiene la protección UTC: solo la tienen `formatDateOnly`, `formatWeekday`/`formatWeekdayName` y el variant \"auto\" de `DateCell`. Reproducido en shell: TZ=America/Bogota + Intl es-CO sobre new Date('2026-08-24') → «23 de ago de 2026». La prueba interna más fuerte es que los MISMOS archivos ya lo hacen bien al lado: app.forum.$courseId.tsx:554 usa `formatSessionLabel` (que pasa por formatDateOnly) en el Select con el que se elige la sesión, y app.teacher.attendance.tsx:1738/:1899 escribe explícitamente `formatDateShort(sess.session_date + \"T12:00:00\")` mientras :2371/:2382 lo omite. No hay guard aguas arriba ni test que cubra el caso.",
    "severidadFinal": "alta",
    "queVeElUsuario": "Un foro atado a la sesión del 24 de agosto muestra el badge «Sesión 23 ago 2026». Un día menos, siempre, para cualquiera en zona horaria negativa (toda Colombia). En Pizarras el mismo corrimiento está en el <SelectItem> con el que el docente ELIGE la sesión, así que ahí además induce a elegir mal cuando la sesión no tiene título.",
    "camino": "Docente crea una sesión con session_date = 2026-08-24 → crea un foro asociado a esa sesión → cualquiera abre /app/forum/<courseId> o entra al foro y el badge dice «23 ago 2026». Contraste en la MISMA pantalla: el Select de sesión del formulario de foro (línea 554) sí dice «24 ago 2026».",
    "fix": "Reemplazar `formatDate`/`formatDateShort` por `formatDateOnly` (ancla a T12:00:00 local) en los 5 sitios que reciben `session_date` crudo: app.forum.$courseId.tsx:651, app.forum.$courseId.$forumId.tsx:328, app.teacher.whiteboards.index.tsx:1121 (el SelectItem de elección de sesión), y app.teacher.attendance.tsx:2371 y :2382 — estos dos últimos copiando lo que su propio archivo ya hace en 1738/1899. Alternativa uniforme: <DateCell value={...} /> con el variant \"auto\" por defecto, que detecta ^\\d{4}-\\d{2}-\\d{2}$ y llama formatDateOnly.",
    "frente": "visualizacion"
  },
  {
    "titulo": "Los periodos académicos muestran fecha de inicio y fin un día antes",
    "archivo": "src/modules/admin/AdminAcademicPeriodsPanel.tsx",
    "linea": 488,
    "rol": "Admin / SuperAdmin",
    "real": true,
    "razon": "No se cae, y es más fuerte de lo que decía el reporte. Verificado: `academic_periods.start_date`/`end_date` son `date` (20260613000000_academic_periods.sql:38-39); la query (línea 149) los trae crudos; y `variant=\"date\"` fuerza `formatDate` en date-cell.tsx, saltándose deliberadamente la rama \"auto\" que sí tiene la protección UTC. El agravante que confirma el defecto: el formulario usa `<DatePicker>`, que parsea y formatea con date-fns en hora LOCAL y muestra el botón con formato \"PP\" es (date-picker.tsx:38-45, 84) — así que el admin ve «15 de ene de 2026» en el picker, guarda, y la tabla de la misma pantalla le devuelve «14 ene 2026». Contradicción visible en un solo viaje, sin guard intermedio.",
    "severidadFinal": "alta",
    "queVeElUsuario": "Un periodo guardado del 2026-01-15 al 2026-05-30 aparece en la tabla como «14 ene 2026» → «29 may 2026». El picker del formulario, dos clics antes, decía «15 de ene de 2026».",
    "camino": "Admin abre Configuración → Académico → Periodos → «Nuevo periodo» → elige 15/01/2026 y 30/05/2026 en los DatePicker (que muestran «15 de ene de 2026» / «30 de may de 2026») → guarda → las columnas Inicio y Fin de la fila muestran 14 ene y 29 may. Visible en sm+ (las celdas son hidden sm:table-cell).",
    "fix": "Cambiar las dos celdas a <DateCell value={r.start_date} /> y <DateCell value={r.end_date} /> — sin `variant`, para que use el default \"auto\" que detecta ^\\d{4}-\\d{2}-\\d{2}$ y usa formatDateOnly. Líneas 488 y 491. Vale barrer el resto de `variant=\"date\"` del repo buscando cuáles apuntan a columnas `date` y no a `timestamptz`.",
    "frente": "visualizacion"
  },
  {
    "titulo": "La revisión del taller muestra JSON crudo como \"respuesta del estudiante\" en 4 tipos de pregunta",
    "archivo": "src/routes/app.student.workshop.$workshopId.tsx",
    "linea": 344,
    "rol": "Estudiante",
    "real": true,
    "razon": "No se cae, con una corrección de alcance. Verificado el camino completo de datos: en WorkshopQuestions.tsx:1924-1935 el payload solo tiene ramas de columna para codigo/java_gui/python_gui (code_content), diagrama (diagram_code), cerrada (selected_option) y cerrada_multi (answer_text = JSON.stringify(array)); TODO lo demás cae en `else payload.answer_text = String(raw)`, y para bd_sql ese `raw` es el JSON de serializeSqlAnswer ({\"bdSql\":1,...}, sql-answer.ts:74) y para red_consola/red_gui el volcado de la topología. `renderAnswer` (299-346) solo ramifica `cerrada`; el resto imprime `raw` en un <div> monoespaciado y solo so_consola se salva por v86TranscriptForDisplay. La revisión de EXAMEN sí tiene las ramas (app.student.review.$examId.tsx:585-604: sqlSourceForDisplay + sqlResultsForDisplay para bd_sql, <NetworkAnswerReview> para red_*), lo que prueba que el fix existe y no se propagó. CORRECCIÓN al reporte: la sub-claim de que en proyectos una pregunta `cerrada` muestra un dígito pelado es FALSA — ProjectFiles.tsx:2238 guarda `choices[Number(raw)] ?? String(raw)`, o sea el TEXTO de la opción, con comentario explícito «Guardar también el texto elegido en content para revisión». El defecto en proyectos es real pero solo para cerrada_multi (:2267, JSON.stringify del array), red_consola/red_gui (:2296) y bd_sql (que no tiene rama y cae en :2592).",
    "severidadFinal": "alta",
    "queVeElUsuario": "En vez de su respuesta, el alumno ve el JSON serializado. Base de datos: {\"bdSql\":1,\"sql\":\"SELECT * FROM alumnos;\",\"results\":[{\"columns\":[\"id\",\"nombre\"],\"rows\":[[\"1\",\"Ana\"]]}]}. Opción múltiple: [0,2]. Red: el volcado completo de devices, links e histories. La misma pregunta en un EXAMEN se ve bien.",
    "camino": "Docente crea un taller con una pregunta «Base de datos (SQL)» (o «Opción múltiple» / «Red (consola)» / «Red (diagrama)») → el alumno la responde y entrega → abre /app/student/workshop/<workshopId> → bajo el enunciado, en el bloque monoespaciado, ve el JSON. Idéntico en /app/student/project/<projectId> para esos mismos 3 tipos (bd_sql, cerrada_multi, red_*).",
    "fix": "Portar a renderAnswer las ramas que ya existen en app.student.review.$examId.tsx:585-604: bd_sql → `sqlSourceForDisplay(raw)` + `sqlResultsForDisplay(raw)` en dos <pre>; red_consola/red_gui → <NetworkAnswerReview options={q.options} value={raw} type={...} />; cerrada_multi → JSON.parse(answer_text) y reutilizar el bloque de choices con ring en las marcadas (WorkshopQuestions.tsx:1467-1470 ya hace ese parse al cargar el taker, se puede copiar). Mismo trasplante en src/routes/app.student.project.$projectId.tsx:564, que hoy solo ramifica `codigo_zip` y manda todo lo demás a `ans.content` crudo — ahí el bloque de `cerrada` NO hace falta (ya llega el texto de la opción).",
    "frente": "visualizacion"
  },
  {
    "titulo": "El estudiante ve el código interno del tipo de pregunta («Bd_sql», «Cerrada_multi», «Codigo_zip»)",
    "archivo": "src/modules/workshops/WorkshopQuestions.tsx",
    "linea": 2917,
    "rol": "Estudiante",
    "real": true,
    "razon": "No se cae, y el texto real es peor que el reportado. Confirmados los 5 sitios que pintan `{q.type}` crudo con `capitalize` (WorkshopQuestions.tsx:2917 taker del alumno y :758 editor docente; ProjectFiles.tsx:3094 taker y :864; app.teacher.workshops.tsx:4686; app.student.workshop.$workshopId.tsx:498). Precisión: `text-transform: capitalize` segmenta por UAX#29, donde «_» es ExtendNumLet y UNE palabras, así que el badge muestra «Bd_sql» / «Cerrada_multi» con el guion bajo A LA VISTA, no «Bd sql». La contraparte correcta existe y está documentada en el propio código: app.student.take.$examId.tsx:81-93 define QUESTION_TYPE_LABEL_KEY con el comentario «el alumno NO debe ver el código interno crudo (cerrada, codigo, java_gui…) en la pantalla de toma» y lo aplica en :2313. Es una violación directa de P6 (un texto visible no contiene identificadores internos). Matiz al reporte: `so_consola` NO está en los Select de tipo de WorkshopQuestions (845-857 ni 1179-1185), así que hoy no se puede crear desde la UI — la clave i18n faltante para ese tipo es defensiva, no urgente.",
    "severidadFinal": "media",
    "queVeElUsuario": "El badge junto al número de pregunta dice «Bd_sql», «Cerrada_multi», «Codigo_zip», «Java_gui», «Red_consola» — el identificador de la base con el guion bajo visible. En la toma de EXAMEN el mismo tipo dice «Base de datos (SQL)».",
    "camino": "Docente agrega a un taller una pregunta «Base de datos (SQL)» o «Opción múltiple» (cerrada_multi) → el alumno abre /app/student/workshops → «Responder» → el badge de la card dice «Bd_sql» / «Cerrada_multi». Igual en el taker de proyectos y en la revisión del taller.",
    "fix": "Extraer QUESTION_TYPE_LABEL_KEY de app.student.take.$examId.tsx:81 a un módulo compartido (ej. src/modules/exams/question-type-label.ts) exponiendo `questionTypeLabel(t, type)` con fallback al crudo solo como defensiva, y aplicarlo en WorkshopQuestions.tsx:2917 y :758, ProjectFiles.tsx:3094 y :864, app.student.workshop.$workshopId.tsx:498, app.teacher.workshops.tsx:4686 y app.student.review.$examId.tsx:511 (que hoy hace `q.type.replace(/_/g,' ')`). Quitar el `capitalize` de la clase: las etiquetas de questionBank.type ya vienen con mayúscula correcta. Agregar `questionBank.type.soConsola` en es/en solo como defensiva.",
    "frente": "visualizacion"
  },
  {
    "titulo": "La card de Instrucciones del taller se titula «Talleres», y el enlace externo también",
    "archivo": "src/routes/app.student.workshop.$workshopId.tsx",
    "linea": 421,
    "rol": "Estudiante",
    "real": true,
    "razon": "No se cae. Verificados los 3 usos de `t(\"dashboard.cards.workshopsStudent\")`: como CardTitle de la card que envuelve `workshop.instructions` (línea 421), como texto del <a> al `external_link` (línea 434) y como texto del mismo enlace en la lista (app.student.workshops.tsx:706). El valor de esa clave es literalmente «Talleres» / «Workshops» (es.json/en.json → dashboard.cards.workshopsStudent), o sea el nombre del MÓDULO puesto como título de contenido y como etiqueta de acción. No hay override ni interpolación. Las dos claves que propone el fix existen en ambos locales: teacherWorkshops.fieldInstructions = «Instrucciones»/«Instructions» y hc_routesAppStudentProjectProjectId.openProjectResource = «Abrir recurso del proyecto»/«Open project resource» (el patrón que el detalle de proyecto ya usa bien).",
    "severidadFinal": "media",
    "queVeElUsuario": "En el detalle del taller, la card que contiene las instrucciones del docente se titula «Talleres». Justo debajo, el enlace al recurso externo también dice «Talleres» en vez de nombrar la acción.",
    "camino": "Docente crea un taller y llena «Instrucciones» + «Enlace externo» → el alumno abre /app/student/workshop/<workshopId> → ve una card titulada «Talleres» con las instrucciones dentro, y un link «Talleres» abajo. El mismo link mal etiquetado aparece en la lista /app/student/workshops.",
    "fix": "Línea 421 → t(\"teacherWorkshops.fieldInstructions\"). Líneas 434 y app.student.workshops.tsx:706 → una clave nueva studentWorkshops.openResource («Abrir recurso del taller» / «Open workshop resource»), calcada de hc_routesAppStudentProjectProjectId.openProjectResource.",
    "frente": "visualizacion"
  },
  {
    "titulo": "El selector de tipo de pregunta del taller ofrece «Opción múltiple» dos veces",
    "archivo": "src/modules/workshops/WorkshopQuestions.tsx",
    "linea": 845,
    "rol": "Docente",
    "real": true,
    "razon": "No se cae; es un duplicado literal. Líneas 845 y 846: `<SelectItem value=\"cerrada\">{t(\"workshopQuestions.typeClosedSingle\")}</SelectItem>` seguido de `<SelectItem value=\"cerrada_multi\">{t(\"workshopQuestions.typeClosedSingle\")}</SelectItem>` — la MISMA clave en los dos. Y el valor de esa clave está mal para el primero: es.json workshopQuestions.typeClosedSingle = «Opción múltiple», en.json = «Multiple choice». Confirmado además que `workshopQuestions.typeClosedMulti` NO existe en ninguno de los dos locales, mientras projectFiles sí tiene el par correcto (typeClosedSingle=«Selección única»/«Single selection», typeClosedMulti=«Opción múltiple»/«Multiple choice»), igual que questionBank.type.cerrada=«Selección única» y cerradaMulti=«Opción múltiple». O sea: talleres es el único módulo con el par roto. El segundo Select (línea 1174) ofrece solo `cerrada`, también con la etiqueta errónea.",
    "severidadFinal": "media",
    "queVeElUsuario": "El desplegable «Tipo» muestra dos ítems consecutivos con exactamente el mismo texto, «Opción múltiple», sin forma de saber cuál es selección única y cuál permite marcar varias.",
    "camino": "Docente entra a Talleres → abre un taller → «Preguntas» → pestaña de creación manual → despliega el Select «Tipo»: los ítems 2 y 3 dicen los dos «Opción múltiple» (values `cerrada` y `cerrada_multi`). Elige a ciegas y puede crear una pregunta de selección única cuando quería varias opciones.",
    "fix": "En es.json/en.json corregir workshopQuestions.typeClosedSingle → «Selección única» / «Single choice» y agregar workshopQuestions.typeClosedMulti → «Opción múltiple» / «Multiple choice» (copiando los valores de projectFiles, que ya son correctos). Usar la clave nueva en la línea 846. La línea 845 y la 1174 quedan con la etiqueta corregida.",
    "frente": "visualizacion"
  },
  {
    "titulo": "El texto interno «Pendiente IA — … al procesar la cola» se muestra al alumno como su retroalimentación, duplicando el aviso",
    "archivo": "src/routes/app.student.workshops.tsx",
    "linea": 727,
    "rol": "Estudiante",
    "real": true,
    "razon": "No se cae. `PENDING_AI_FEEDBACK = \"Pendiente IA — la calificación llegará al procesar la cola.\"` (ai-grading.ts:405) se escribe en la columna ai_feedback de la ENTREGA, no solo por pregunta: WorkshopQuestions.tsx:2718 hace update({ai_grade:null, final_grade:null, ai_feedback: PENDING_AI_FEEDBACK, status:'entregado'}) en el camino async, y ProjectFiles.tsx:2371/:2528/:2683 más grade-submission.ts:248 hacen lo propio. Las vistas del alumno no lo filtran: renderizan `[...new Set([teacher_feedback, ai_feedback].filter(Boolean)]).join(\"\\n\\n\")` dentro de una card «Retroalimentación». Y el <PendingAiGradeBanner> se monta inmediatamente arriba con condiciones que se cumplen a la vez (status==='entregado' && final_grade==null && isAiGradePending) → duplicación garantizada, no hipotética. Es P6 de libro (el texto visible nombra el mecanismo, «la cola»), y el propio código lo dice: el comentario de QUEUED_STUDENT_TITLE (ai-grading.ts:427) declara que «el estudiante no necesita conocer el detalle del flow async/cola/worker».",
    "severidadFinal": "media",
    "queVeElUsuario": "Dos mensajes seguidos sobre lo mismo: el banner «Por calificar» y, pegado abajo, una card «Retroalimentación» cuyo único contenido es «Pendiente IA — la calificación llegará al procesar la cola.», con el mecanismo interno a la vista.",
    "camino": "Admin pone ai_model_settings.processing_mode = async → el alumno entrega un taller → vuelve a /app/student/workshops: ve el banner «Por calificar» y debajo la caja «Retroalimentación» con el texto placeholder. En /app/student/workshop/<id> el mismo texto aparece además una vez POR PREGUNTA (el per-pregunta también recibe PENDING_AI_FEEDBACK en WorkshopQuestions.tsx:2030/2209/2489/2546). Igual en proyectos.",
    "fix": "Filtrar el centinela antes de renderizar, en los `.filter(Boolean)` que arman el texto: excluir los valores cuyo `.trim() === PENDING_AI_FEEDBACK` y no montar la card/el bloque si el resultado queda vacío. Sitios: app.student.workshops.tsx:727, app.student.projects.tsx:725, app.student.workshop.$workshopId.tsx:469 y :519, app.student.project.$projectId.tsx:427 y :578. El <PendingAiGradeBanner> ya cubre el aviso — no hay que reemplazarlo por otro texto.",
    "frente": "visualizacion"
  },
  {
    "titulo": "Markdown crudo en la retroalimentación de taller y proyecto (la revisión de examen sí lo renderiza)",
    "archivo": "src/routes/app.student.workshop.$workshopId.tsx",
    "linea": 469,
    "rol": "Estudiante",
    "real": true,
    "razon": "Real pero MUCHO más chico de lo reportado, y la severidad estaba inflada. Lo que SÍ verifiqué: el bloque de feedback de examen (app.student.review.$examId.tsx:468 global y :666-670 por pregunta) envuelve exactamente el mismo `[...new Set([teacherFeedback, iaFeedback].filter(Boolean)]).join(\"\\n\\n\")` en <MarkdownInline>, mientras app.student.workshop.$workshopId.tsx:469, app.student.workshops.tsx:727, app.student.project.$projectId.tsx:427/:578 y app.student.projects.tsx:725 lo pintan en un contenedor `whitespace-pre-wrap` pelado (los dos archivos de proyecto ni importan MarkdownInline). Peor: DENTRO de app.student.workshop.$workshopId.tsx el feedback POR PREGUNTA (:519) sí usa MarkdownInline y el GLOBAL (:469) no, así que el mismo docente en la misma pantalla ve un texto en negrita y el otro con asteriscos. Camino real de entrada: el campo «Observación» de ExternalGradesEditor:505 escribe en teacher_feedback y no valida nada. LO QUE SE CAE del reporte: (a) las descripciones/instrucciones (workshop.description :413, workshop.instructions :423, project.description :381, f.description :471) NO son defecto — exam.description también se pinta plana (app.student.exams.tsx:596), o sea el comportamiento es CONSISTENTE en los tres módulos, ningún campo anuncia markdown, y `whitespace-pre-wrap` ya preserva los saltos que el docente tecleó; (b) el feedback generado por IA está instruido como TEXTO PLANO en el origen — FEEDBACK_PLAINTEXT_RULE en supabase/functions/ai-grade-submission/index.ts:492, con el comentario «La UI no renderiza Markdown — mostraría los símbolos crudos» —, así que la exposición real se limita al texto escrito a mano por el docente.",
    "severidadFinal": "baja",
    "queVeElUsuario": "Si el docente escribe «**Fortalezas:** buen uso de herencia» en la observación de un taller/proyecto externo, el alumno ve los asteriscos. En la misma pantalla de taller, la retroalimentación por pregunta del mismo docente sí sale en negrita; la global no.",
    "camino": "Docente registra la nota de un taller externo en el editor de notas externas y escribe markdown en «Observación» → el alumno abre /app/student/workshops (o el detalle) y ve la sintaxis cruda. Contraste inmediato: la retroalimentación por pregunta del mismo taller (línea 519) sí se renderiza, y para un EXAMEN externo la misma observación sale formateada (app.student.review.$examId.tsx:468).",
    "fix": "Envolver SOLO los bloques de retroalimentación en <MarkdownInline> y quitar el `whitespace-pre-wrap` del contenedor (MarkdownInline trae remarkBreaks, los saltos simples se conservan): app.student.workshop.$workshopId.tsx:469, app.student.workshops.tsx:727, app.student.project.$projectId.tsx:427 y :578, app.student.projects.tsx:725 (estos dos archivos de proyecto necesitan además el import). NO tocar las descripciones ni las instrucciones: hoy son consistentes entre exámenes/talleres/proyectos y ningún campo del formulario anuncia markdown — cambiarlas es una decisión de producto, no un fix.",
    "frente": "visualizacion"
  },
  {
    "titulo": "El enunciado de una pregunta de encuesta pierde el formato y los saltos de línea que el docente escribió",
    "archivo": "src/routes/app.student.polls.tsx",
    "linea": 1381,
    "rol": "Estudiante",
    "real": true,
    "razon": "No se cae; es exactamente la mitad que quedó afuera del fix del commit anterior. Verificado: en app.student.polls.tsx el único uso de <MarkdownInline> es para `poll.description` (:769 y :1301) — el enunciado `q.text` va en un `<p className=\"text-sm font-medium\">` pelado en los TRES bloques (abiertas :1381, múltiples :1445, única :1500), sin markdown y sin `whitespace-pre-wrap`, así que además de los asteriscos se COLAPSAN los saltos de línea. Idéntico en la página pública: encuesta.$token.tsx renderiza `info.description` con MarkdownInline (:296) y `q.text` plano (:359). El input es un <Textarea rows={2} maxLength={2000}> (PollQuestionsEditor.tsx:339-347), o sea multilínea por diseño. Y el patrón correcto ya existe DENTRO del módulo de encuestas: KahootReviewDialog.tsx:154 usa <MarkdownInline>{review.question.text}</MarkdownInline>. El commit 138b6dca declara la regla («los enunciados de examen/taller/proyecto, los foros y el tutor ya usan MarkdownInline; ahora las encuestas también») y arregló solo la descripción.",
    "severidadFinal": "media",
    "queVeElUsuario": "«1. **Solo yo veo tus respuestas** ¿cómo te sentiste?» — con los asteriscos visibles y todo en un solo párrafo, aunque el docente escribió tres líneas. La descripción de la MISMA encuesta, dos centímetros arriba, sí sale formateada.",
    "camino": "Docente crea una encuesta mixta → «Preguntas» → escribe en el Textarea del enunciado un texto con **negrita** y saltos de línea → publica → el alumno abre /app/student/polls: enunciado con asteriscos crudos y sin saltos. Idéntico en el enlace público /encuesta/<token>, que es la pantalla donde se reportó el bug original de la descripción.",
    "fix": "Sacar el numeral y el asterisco de obligatorio fuera del texto del enunciado y envolver `q.text` en <MarkdownInline> (copiando KahootReviewDialog.tsx:154). Sitios: app.student.polls.tsx:1381, :1445 y :1500; encuesta.$token.tsx:359; app.teacher.polls.tsx:3815 (resultados del docente).",
    "frente": "visualizacion"
  },
  {
    "titulo": "Separador decimal inconsistente: coma en unas pantallas, punto en otras (a veces en la misma)",
    "archivo": "src/routes/app.student.grades.tsx",
    "linea": 606,
    "rol": "Estudiante y Docente",
    "real": true,
    "razon": "No se cae. `toFixed()` emite punto siempre, sin importar el locale, y los sitios son visibles: app.student.grades.tsx:606 define `fmt = n.toFixed(2)` y se usa en las celdas de Nota (:910, :943) y en los pesos (:907 bucketWeight.toFixed(1), :938 `${Number(it.weight).toFixed(1)}%`); app.certificates.tsx:585 y app.student.certificates.tsx:454 pintan `Number(final_grade).toFixed(2)`; app.teacher.gradebook.tsx:2328 pinta `cg.grade.toFixed(2)` en una TableCell. La contradicción DENTRO de una pantalla está confirmada: app.teacher.exams.index.tsx:1056 usa `formatPercent(Number(e.weight))` (es-CO → coma) en la columna Peso, y :1304/:1307/:1394/:1396/:1401 usan `.toFixed(1)` en el texto de ayuda del diálogo de edición. Y la convención opuesta está escrita en el repo: `<DecimalInput>` bloquea el punto y lo auto-convierte a coma, `formatNumber` existe justo para esto (su docstring describe este mismo modo de falla), y hay dos precedentes que ya lo resuelven a mano — EarlyAlertCard.tsx:67 `n.toFixed(1).replace('.', ',')` y app.superadmin.tenants.tsx:121-122. Ningún guard aguas arriba.",
    "severidadFinal": "media",
    "queVeElUsuario": "El alumno ve su nota como «4.50» y el peso como «30.0%», con punto, aunque el docente la escribió con coma en un DecimalInput que bloquea el punto. En Exámenes el choque ocurre en UNA sola pantalla: la columna «Peso» del grid dice «16,67%» y el diálogo de edición abierto encima dice «16.7% disponible».",
    "camino": "Docente asigna peso a un examen escribiendo «16,67» en el DecimalInput → /app/teacher/exams muestra la columna Peso como «16,67%» → abre el diálogo de edición de ese examen y la ayuda bajo el campo dice «16.7% disponible». Para el alumno: /app/student/grades muestra «4.50 / 5» y «30.0%».",
    "fix": "Reemplazar los toFixed VISIBLES por los helpers de src/shared/lib/format.ts: `formatNumber(v, {minimumFractionDigits:2, maximumFractionDigits:2})` para notas y `formatPercent(v)` para porcentajes (que además quita el «.0» sobrante). Sitios: app.student.grades.tsx:606 (el helper `fmt`), :907, :938; app.teacher.exams.index.tsx:1304, :1307, :1394, :1396, :1401; app.teacher.exams.$examId.tsx:1618, :1620, :1625; app.teacher.gradebook.tsx:2328, :2341, :2663, :2745-2763, :2892, :2960, :3009; app.certificates.tsx:585, :603; app.student.certificates.tsx:454. Ojo de no tocar los toFixed que alimentan CSV/export o cálculos.",
    "frente": "visualizacion"
  },
  {
    "titulo": "El preview de un hilo del foro corta el markdown a la mitad y renderiza un bloque de código en la lista",
    "archivo": "src/routes/app.forum.$courseId.$forumId.tsx",
    "linea": 532,
    "rol": "Estudiante y Docente",
    "real": true,
    "razon": "No se cae. Confirmado el código: `<div className=\"... line-clamp-2 prose-sm\"><MarkdownInline>{thread.body.slice(0, 200)}</MarkdownInline></div>` (531-532), y MarkdownInline permite `pre` y le da `bg-muted rounded p-3 my-2 overflow-x-auto` (MarkdownInline.tsx allowedElements + clases), o sea markdown de BLOQUE dentro de un contenedor clampado a 2 líneas. El uso con code fence no es hipotético: el Textarea del cuerpo es `font-mono`, maxLength 20000, y su placeholder dice literalmente «Describe tu pregunta. Soporta Markdown.» (hc_routesAppForumCourseIdForumId.bodyPlaceholder). El `.slice(0, 200)` puede dejar una cerca ``` sin cerrar, y remark trata el resto como código hasta el final → el preview entero se vuelve un bloque; y un `**énfasis**` partido deja los asteriscos sueltos. Es justo el anti-patrón que markdown-plain.ts se creó para cubrir (CLAUDE.md: «una celda con truncate — el markdown genera bloques y rompe el truncado a una línea»), y `markdownToPlainPreview(md, max)` ya corta en el último espacio en vez de partir la palabra.",
    "severidadFinal": "media",
    "queVeElUsuario": "En la lista de hilos, el preview de un mensaje que empieza con código muestra una caja gris monoespaciada recortada en vez de dos líneas de texto; y un hilo cuyo **énfasis** queda cortado en el carácter 200 muestra los asteriscos sueltos («…con **mucho cuidad»).",
    "camino": "Alumno crea un hilo cuyo cuerpo empieza con un bloque ```java (el placeholder del campo invita a usar Markdown y el textarea es monoespaciado) → cualquiera abre /app/forum/<courseId>/<forumId> → la fila de ese hilo muestra el <pre> gris clampado en vez del preview; si la cerca ``` cae después del carácter 200, el slice la deja sin cerrar y todo el preview se vuelve código.",
    "fix": "Reemplazar el div por `<p className=\"text-xs text-muted-foreground mt-1 line-clamp-2\">{markdownToPlainPreview(thread.body, 200)}</p>` (importando de @/shared/lib/markdown-plain) y borrar el `.slice(0,200)` manual — el helper ya recorta en el último espacio y agrega la elipsis. El detalle del hilo sigue con MarkdownInline, que es donde sí hay espacio.",
    "frente": "visualizacion"
  },
  {
    "titulo": "El tablero del curso muestra la fecha en formato ISO («2026-08-24»)",
    "archivo": "src/routes/app.teacher.board.$courseId.tsx",
    "linea": 1628,
    "rol": "Docente",
    "real": true,
    "razon": "No se cae. Confirmado `{s.session_date}` crudo dentro de un <Badge> en 1628 y dentro de un <SelectItem> en 1797, mientras el MISMO archivo ya importa `formatDateOnly` (línea 48) y lo usa correctamente en 1141 para el badge «Sesión del {{date}}». Igual en app.teacher.contents.tsx:3493 (`<div className=\"text-sm font-medium tabular-nums\">{s.session_date}</div>` en el diálogo «Asignar sesiones»), archivo que no importa nada de shared/lib/format. La fecha es CORRECTA (no hay corrimiento de un día acá) — el defecto es solo de formato, por eso baja y no alta.",
    "severidadFinal": "baja",
    "queVeElUsuario": "El badge de cada sesión del tablero dice «2026-08-24» en vez de «24 ago 2026», mientras otro badge de la MISMA pantalla (el de material asignado) sí dice «Sesión del 24 ago 2026».",
    "camino": "Docente abre /app/teacher/board/<courseId> → la lista de sesiones muestra badges con la fecha ISO cruda; el desplegable «Subir material a…» de esa misma pantalla lista «2026-08-24 — Título». Y en Contenidos, el diálogo «Asignar sesiones» muestra la misma fecha ISO.",
    "fix": "Pasar el valor por `formatDateOnly` (ya importado en board.$courseId.tsx:48): líneas 1628 y 1797. En app.teacher.contents.tsx:3493 agregar el import y aplicarlo. Alternativa uniforme: `<DateCell value={s.session_date} />` con el default \"auto\", que además da tabular-nums y el title con el valor completo.",
    "frente": "visualizacion"
  },
  {
    "titulo": "\"Detección completada · sin coincidencias relevantes\" se afirma sobre una clase que solo se comparó parcialmente (tope silencioso de 30 respuestas por pregunta)",
    "archivo": "src/modules/exams/FraudPanel.tsx",
    "linea": 429,
    "real": true,
    "rol": "Docente / Admin",
    "razon": "Intenté tumbarlo por cuatro vías y ninguna sostiene. (1) El tope existe y es ciego: `MAX_ITEMS_PER_CALL = 30` (detect-plagiarism/index.ts:41) y `group.items.slice(0, MAX_ITEMS_PER_CALL)` (línea 419). (2) No hay guard aguas arriba: el call site del monitor manda `submissionIds` con el último intento por alumno (monitor:1471-1481), lo que quita intentos viejos pero NO baja el tamaño del curso; FraudPanel:398 y workshops:2209 no mandan nada. (3) La respuesta es `{ok, pairs, groups_compared}` (edge:565-570) sin ningún campo de cobertura, y `message` SOLO existe en el early-return de \"no hay entregas suficientes\" (edge:349-356) — con un curso real siempre es undefined, así que el `summary?.message ?? …` cae al texto absoluto de i18n (es.json:1489 `detectNone`, 6592 `noRelevantMatches`, 8916 `detectionNoMatches`). (4) La limitación existe SOLO como comentario en la cabecera del edge; grep sobre los 3 call sites y sobre es.json no encuentra ningún texto visible que la mencione, y ni CLAUDE.md ni CHANGELOG.md la declaran deliberada para el mensaje al usuario. Agravante que apareció al verificar: la query de entregas (`from(\"submissions\").select(...).eq(\"exam_id\", refId)`, edge:210) no tiene ORDER BY, así que CUÁLES 30 se comparan es no determinista — dos corridas seguidas pueden dar resultados distintos sin explicación visible.",
    "severidadFinal": "alta",
    "queVeElUsuario": "En un examen/taller con más de 30 respuestas con texto por pregunta (el curso real de FESNA tiene 93 matriculados), el docente pulsa \"Detectar copias\" y recibe \"Detección completada — No se encontraron coincidencias relevantes.\" o \"Detección completada: 2 pares sospechosos\". Lee eso como un veredicto sobre TODA la clase, pero la IA solo vio las primeras 30 respuestas de cada pregunta, elegidas en un orden no determinista: los demás alumnos nunca se compararon ni entre sí ni contra esos 30. Ni el toast ni el panel muestran a cuántas entregas alcanzó la comparación.",
    "camino": "Docente → /app/teacher/monitor/<examId> (o el diálogo de calificación de un taller, o el de entregas de un proyecto) → tarjeta \"Análisis de fraude\" → \"Detectar copias\" → leer el toast. Con >30 entregas con texto por pregunta el recorte ya ocurrió.",
    "fix": "(1) En supabase/functions/detect-plagiarism/index.ts devolver la cobertura real junto a `groups_compared`: acumular `skipped += group.items.length - items.length` en el loop (línea 419) y agregar `compared_items` / `skipped_items` al JSON de las líneas 565-570. (2) En los 3 call sites — FraudPanel.tsx:420-431, app.teacher.monitor.$examId.tsx:1502-1506, app.teacher.workshops.tsx:2231-2237 — cuando `skipped_items > 0` usar `toast.warning` con \"Se compararon N de M respuestas por pregunta; quedaron M−N sin comparar\" y NO emitir nunca \"sin coincidencias relevantes\" como veredicto del curso completo. (3) Fix de raíz: recorrer en ventanas (`for (let i = 0; i < group.items.length; i += MAX_ITEMS_PER_CALL)`) para cubrir a todos, y agregarle `.order(\"created_at\")` a la query de entregas para que el subconjunto deje de ser no determinista; el mensaje de cobertura queda como red de seguridad.",
    "frente": "ui-ux"
  },
  {
    "titulo": "P9: \"Detectar copias\" es una operación de decenas de segundos a minutos y solo muestra un spinner dentro del botón",
    "archivo": "src/modules/exams/FraudPanel.tsx",
    "linea": 396,
    "real": true,
    "rol": "Docente",
    "razon": "El mecanismo es el que describe el reporte: el edge itera las preguntas en SERIE (`for (const group of groups) { await aiChatCompletionFailover(...) }`, detect-plagiarism/index.ts:417-464), así que el tiempo de pared escala con la cantidad de preguntas abiertas, y el único feedback es `<Spinner size=\"sm\">` dentro de un botón `h-8 text-xs variant=\"outline\"` (FraudPanel.tsx:694-703). Es literalmente el caso que el check de P9 declara insuficiente (\"un `setLoading(true)` + toast final no cumple\"), y el patrón correcto existe en la MISMA feature: `runRegradeLatestAll` con `setRegradeAllProgress({done,total})` en el monitor. No es preferencia de estilo: P9 es un check obligatorio de CLAUDE.md. CORRIJO una parte del reporte que no se sostiene: si el docente se va, NO pierde el resultado — el edge persiste en `similarity_pairs` y el panel los recarga en su próximo `load()`; lo que se pierde es el toast. Por eso el daño es la espera sin expectativa (re-clics, creer que se congeló, abandonar), no pérdida de datos, y la severidad queda en media, no alta.",
    "severidadFinal": "media",
    "queVeElUsuario": "Tras pulsar \"Detectar copias\" lo único que cambia en pantalla es que la lupa del botón se vuelve un spinner de 8px. En un examen con varias preguntas abiertas la espera es de decenas de segundos a minutos (una llamada de IA secuencial por pregunta, más los reintentos del failover de keys), sin progreso, sin estimación y sin decirle que puede seguir trabajando; parece que la pantalla se congeló.",
    "camino": "Docente → /app/teacher/monitor/<examId> → \"Análisis de fraude\" → \"Detectar copias\" en un examen con varias preguntas abiertas. Mismo patrón en app.teacher.workshops.tsx:2206 (`setDetectingCopies(true)`) y app.teacher.monitor.$examId.tsx:1463 (`setDetecting(true)`).",
    "fix": "Copiar el patrón que ya existe dos pantallas más allá (`runRegradeLatestAll`, app.teacher.monitor.$examId.tsx, con `regradeAllProgress` + modal): (a) que el edge acepte un índice de grupo y el cliente itere pregunta por pregunta mostrando un `<LoadingOverlay>` con \"Comparando pregunta {{done}} de {{total}}\"; o, si no se quiere partir el edge, (b) mientras dura la llamada mostrar un `<LoadingOverlay>` con la promesa explícita que pide P9 (\"Comparando las respuestas del curso con IA. Puede tomar varios minutos; podés cerrar esto y volver, el resultado queda guardado.\") en lugar del spinner dentro del botón — y ese texto es cierto, porque los pares se persisten aunque el docente se vaya.",
    "frente": "ui-ux"
  },
  {
    "titulo": "P5: en 4 grids la fila entera es la ÚNICA puerta y es un `<tr>` pelado — inalcanzable por teclado",
    "archivo": "src/modules/admin/AuditLogsView.tsx",
    "linea": 796,
    "real": true,
    "rol": "Admin / SuperAdmin (y Docente en /app/teacher/audit-logs)",
    "razon": "Verifiqué las 4 ubicaciones una por una y ninguna tiene guard ni ruta alternativa: AuditLogsView.tsx:796-802, app.admin.support.tsx:658-666, app.superadmin.support.tsx:448-456 y app.admin.statistics.tsx:627-630 son `<TableRow className=\"cursor-pointer hover:bg-muted/40\" onClick=…>` sin `role`, sin `tabIndex` y sin `onKeyDown`. En Auditoría la última celda es un `<ChevronRight>` decorativo dentro de un `<TableCell>` (línea 897), no un botón. En los dos Soporte el `RowActionsMenu` de la última celda tiene UN solo item, \"Eliminar\" (admin:692-712 / superadmin:490-…), así que la única acción alcanzable por teclado en la fila es la destructiva y \"abrir el ticket\" —la tarea del módulo— no existe como acción enfocable; confirmé además que la ruta de SuperAdmin no maneja ningún `?ticket=` que dé una vía alterna. En Estadísticas `setDrillCourseId` solo se llama desde ese onClick (línea 630) y desde el reset (365). Descarté que sea preferencia de estilo: son los ÚNICOS 4 grids con fila clickeable de todo `src/` (grep de `<TableRow` + onClick) y el repo ya implementa el patrón correcto con comentario justificándolo en `Stat` (app.index.tsx:1744-1762). No hay test que lo cubra.",
    "severidadFinal": "media",
    "queVeElUsuario": "Un usuario de teclado (o de lector de pantalla) tabula por la tabla y no puede abrir el detalle: en Auditoría no llega al panel del evento, en Soporte no puede abrir el ticket —solo alcanza \"Eliminar\", que es lo único que el menú de la fila ofrece— y en Estadísticas no puede entrar al detalle del curso. Con ratón todo funciona, así que el problema es invisible para quien lo programó.",
    "camino": "(1) Admin → /app/admin/audit-logs → tab \"Auditoría\" → Tab hasta una fila + Enter: nada. (2) Admin → /app/admin/support (y SuperAdmin → /app/superadmin/support) → Tab + Enter sobre una fila: nada; el único foco de la fila es el menú de tres puntos con \"Eliminar\". (3) Admin → /app/admin/statistics → tabla de cursos → Tab + Enter: nada.",
    "fix": "En los 4 `<TableRow>` agregar `role=\"button\" tabIndex={0}` + `onKeyDown={(e) => { if (e.key === \"Enter\" || e.key === \" \") { e.preventDefault(); <accion>(); } }}` + `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`, exactamente el patrón de `Stat` en app.index.tsx:1744. Ubicaciones: src/modules/admin/AuditLogsView.tsx:796 (sirve a /app/admin/audit-logs y /app/teacher/audit-logs), src/routes/app.admin.support.tsx:658, src/routes/app.superadmin.support.tsx:448, src/routes/app.admin.statistics.tsx:627. En los dos Soporte agregar además \"Ver detalle\" (icono Eye) como PRIMER item del `RowActionsMenu`: es la acción principal de la fila y hoy la única enfocable es la destructiva.",
    "frente": "ui-ux"
  },
  {
    "titulo": "P7: la columna \"Acción\" de Auditoría colapsa a 48px en modo Admin (suma de anchos declarados = 936px > 900px)",
    "archivo": "src/modules/admin/AuditLogsView.tsx",
    "linea": 760,
    "real": true,
    "rol": "Admin / SuperAdmin",
    "razon": "Recalculé la aritmética y seguí el mecanismo en table.tsx: los anchos declarados en modo admin son w-36(144)+w-48(192)+w-32(128)+w-40(160)+w-40 curso(160)+w-28(112)+w-10(40) = 936px, y la única columna sin `w-*` es \"Acción\" (línea 767-769). `<Table resizable>` aplica `table-fixed` + `w-full` (table.tsx:296-303), así que \"Acción\" recibe el sobrante. Ancho disponible = viewport − 256 (sidebar `md:ml-64`, AppLayout:1706) − 64 (`md:px-8`, AppLayout:1757); la ruta no agrega max-width (app.admin.audit-logs.tsx:50-63, con comentario explícito de que el padding lo pone el shell). A 1280px eso deja ~958 → \"Acción\" mide ~22px, y `pinDesktop` lo fija a `Math.max(MIN_COL_WIDTH=48, natural)` (table.tsx:56 y 137-141) → 48px, con `p-2` del TableCell (table.tsx:503) quedan ~32px de contenido y el `<span className=\"truncate block\">` (línea 835) deja el texto en 3 caracteres. Confirmé también el agravante: `useColumnResize` solo re-mide en el `change` del media query de 640px (table.tsx:181), así que maximizar la ventana después NO recupera el ancho. En `mode=\"teacher\"` la suma baja a 776 y no ocurre — coherente con el reporte. No encontré `min-w` en ese encabezado ni test que lo cubra.",
    "severidadFinal": "media",
    "queVeElUsuario": "En una ventana de 1280×800 (MacBook 13\", muy común) la columna \"Acción\" —el dato que dice QUÉ pasó— aparece con 3 caracteres y puntos suspensivos, o prácticamente vacía; a 1366px queda en ~110px (≈13 caracteres). El resto de las columnas se ven bien, así que parece que los eventos no tienen nombre. Se recupera arrastrando el handle de la columna (y queda persistido), pero el primer encuentro es una columna ilegible, y maximizar la ventana no la arregla.",
    "camino": "Admin o SuperAdmin en una pantalla de 1280×800 o 1366×768 con el sidebar desplegado (default) → /app/admin/audit-logs → tab \"Auditoría\".",
    "fix": "Bajar la suma declarada por debajo de 900 y darle piso al identificador, en src/modules/admin/AuditLogsView.tsx:760-783: `Actor` w-48 → `w-40`; `Entidad` w-40 → `hidden lg:table-cell w-36`; `Curso` w-40 → `hidden lg:table-cell w-36`; `Fecha` w-36 → `w-32` (suma ≈ 856, y en <lg salen dos columnas), y agregarle a la columna \"Acción\" un `min-w-48` explícito para que nunca sea la que absorbe el déficit. Acordarse de mover también las celdas correspondientes del body (líneas 861-880) con el mismo `hidden lg:table-cell` y de ajustar `cols`/`colSpan` de TableSkeleton/TableEmpty (líneas 787-790). Es el mismo criterio que ya cumplen superadmin.support (880), teacher.exams.index (856) y AdminAiGradingPanel (864).",
    "frente": "ui-ux"
  },
  {
    "titulo": "P7: el monitor en vivo del examen tiene 11 columnas visibles en `lg` (el tope es 8)",
    "archivo": "src/routes/app.teacher.monitor.$examId.tsx",
    "linea": 2259,
    "real": true,
    "rol": "Docente",
    "razon": "El conteo es correcto: 11 `<TableHead>` (líneas 2260, 2265, 2266, 2272, 2278, 2284, 2285, 2291, 2297, 2303, 2309) y los `hidden sm/md/lg:table-cell` reaparecen todos a partir de su breakpoint, así que en `lg` están las 11 — el `colSpan={11}` lo confirma y hoy está sincronizado. Pero dos partes del reporte NO se sostienen y bajan la severidad. (a) Las etiquetas citadas están mal: `integrity.pendingAi` es \"IA\" y `integrity.pendingCopy` es \"Copia\" en es.json, no \"IA pendiente\"/\"Copia pendiente\" — esas dos columnas son estrechas (~50 y ~70px), así que no son el motor del desborde. (b) La tabla es `table-auto` dentro de `<CardContent className=\"p-0 overflow-x-auto\">`, que es el patrón que el design system BENDICE explícitamente para tablas anchas (\"hace scroll dentro de su Card sin empujar la página\"), y CLAUDE.md ya clasifica el monitor como \"matriz, no grid de listado\" al excluirlo de `resizable`. El desborde real a 1280-1440px lo producen la celda \"Estudiante\", que imprime `institutional_email` SIN truncate (líneas 2356-2361; un correo @lanuevaamerica.edu.co pesa ~230-270px), y la celda \"Acciones\", que durante un intento en curso rinde \"Pausar/Reanudar\" + \"+5m\" con etiquetas de texto más 2 RowActions (líneas 2500-2570). Consecuencia: el fix propuesto (subir 3 columnas a `xl`, ~215px) satisface el check de P7 pero NO elimina el scroll en un portátil de 1280. Queda como incumplimiento de regla con molestia ergonómica real —nada se rompe, nada muestra dato incorrecto y las acciones siguen alcanzables en el scroll de la propia Card—, así que baja, no media.",
    "severidadFinal": "baja",
    "queVeElUsuario": "Vigilando un examen en curso en un portátil de 1280-1440px con el sidebar abierto, la tabla de estudiantes desborda el ancho de su tarjeta y la columna \"Acciones\" (pausar, +5 min, ver intentos) queda fuera de vista: hay que arrastrar horizontalmente dentro de la tarjeta para llegar a ella, justo en la pantalla que se usa a contrarreloj.",
    "camino": "Docente → /app/teacher/exams → abrir un examen en curso → \"Monitor\" (/app/teacher/monitor/<examId>) en una ventana de 1280-1440px con el sidebar desplegado, con al menos un alumno en progreso (ahí aparecen los botones Pausar y +5m que ensanchan la columna de acciones).",
    "fix": "Atacar primero los dos motores reales del ancho, y de paso cumplir el conteo de P7: (1) en la celda Estudiante (líneas 2356-2361) truncar el correo (`<div className=\"text-xs text-muted-foreground truncate max-w-40\" title={…}>`) o esconderlo bajo `xl` — el nombre ya identifica la fila; (2) colapsar la celda \"Acciones\" (2500-2570) a un `RowActionsMenu` (son 3+ acciones, que es el umbral del design system) en vez de botones con texto \"Pausar\"/\"+5m\"; (3) subir a `hidden xl:table-cell` las tres columnas de diagnóstico que no sirven para decidir sobre la fila en el momento —\"Intentos\" (2266), \"IA\" (2297) y \"Copia\" (2303), que ya viven consolidadas en `IntegrityReviewDialog`— para dejar 8 en `lg`; y (4) al hacerlo, mantener sincronizados los `colSpan={11}` de TableEmpty (2315 y 2321) o derivarlos de una constante.",
    "frente": "ui-ux"
  },
  {
    "titulo": "Toda la capa de mensajes de error (friendlyError) está en español sin i18n",
    "archivo": "src/shared/lib/db-errors.ts",
    "linea": 87,
    "real": true,
    "rol": "todos los roles",
    "queVeElUsuario": "Con la app puesta en English, el toast de error sale en español mientras el resto de la pantalla está en inglés: «Ya existe un examen con ese título en este curso.», «No tienes permisos para realizar esta acción.», «Error de red. Verifica tu conexión e intenta de nuevo.». La operación falla y el motivo llega en otro idioma que el de la pantalla.",
    "camino": "CORREGIDO respecto al reportado. Sidebar → menú de opciones → Idioma → English (AppLayout.tsx:1324; también el drawer mobile en :1587 y el switcher de /auth en auth.index.tsx:523). Docente → /app/teacher/exams → «Nuevo examen» con un título que ya existe en el curso → Guardar: app.teacher.exams.index.tsx:668 hace toast.error(friendlyUniqueViolation(error) ?? friendlyError(error)) y devuelve el literal español de UNIQUE_INDEX_MESSAGES (db-errors.ts:26), mientras el confirmLabel y el toast de éxito de la misma función sí salen en inglés. IMPORTANTE: el idioma NO persiste — al recargar vuelve a español (ver razon), así que la ventana de exposición es la sesión en curso.",
    "razon": "El defecto existe y el propio repo lo considera un bug: keys-registered.test.ts está escrito explícitamente contra «el usuario en inglés ve español». db-errors.ts tiene 0 referencias a i18n y 1079 usos de friendlyError en src/. Pero la severidad 'alta' está inflada por dos razones que verifiqué: (1) no bloquea nada ni muestra un dato incorrecto — es una mezcla de idiomas; (2) el alcance está capado porque src/i18n/index.ts:33 fija lng:'es' y i18next NO consulta el detector cuando lng viene seteado (i18next.js:1873 → changeLanguage(options.lng); la rama del detector en :2014 es if(!lng)), así que la app arranca SIEMPRE en español y la elección se pierde al recargar; y courses.language (default 'es', mig 20260423000000) no tiene UI para cambiarse, así que useCourseLanguage tampoco fuerza inglés por producto. El camino reportado por el auditor a través de useCourseLanguage no es alcanzable sin editar la base a mano.",
    "severidadFinal": "media",
    "fix": "Registrar los ~30 mensajes como claves en es.json y en.json (dbErrors.unique.<indexName>, dbErrors.code.<sqlstate>, dbErrors.pattern.<caso>, dbErrors.generic) y devolver i18n.t(clave): i18n.t funciona fuera de React y ya es el patrón de app.teacher.workshops.tsx:2820. Ojo: src/shared/lib/db-errors.test.ts assertea los literales españoles exactos (p.ej. toBe(\"Ya existe un usuario con ese correo institucional.\")) — hay que migrarlo a comparar contra la clave o forzar lng='es' en el test. Los 56 fallbacks hardcodeados en los callers (friendlyError(e, \"No pudimos cargar…\")) pasan a t(...) en el call site. La rama P0001 (línea 133) devuelve el mensaje crudo del RAISE EXCEPTION y seguirá en español: eso es límite del servidor, documentarlo. Y si se va a invertir en esto, arreglar ANTES el pin de lng: mientras la app arranque siempre en español, ningún usuario navega en inglés más de una sesión.",
    "frente": "i18n"
  },
  {
    "titulo": "CodeRunnerPicker no tiene i18n: mezcla español hardcodeado con inglés hardcodeado en la pantalla de examen",
    "archivo": "src/modules/code/CodeRunnerPicker.tsx",
    "linea": 121,
    "real": true,
    "rol": "Estudiante (también Docente)",
    "queVeElUsuario": "En el selector de compilador que está sobre cada editor de código, un estudiante con la app en español (el idioma por defecto de TODOS los usuarios) lee dos textos en inglés: «(default)» al lado del proveedor que eligió el admin (L121) y el chip «Override» en cuanto cambia de compilador (L128). Al revés, un usuario en inglés lee «Compilador:» (L96), «Por defecto» (L111) y «CheerpJ (navegador)» (L48). Ningún idioma ve la fila completa en su idioma.",
    "camino": "El archivo no importa useTranslation ni i18n y no tiene un solo t(). Estudiante → /app/student/exams → abrir un examen con una pregunta tipo `codigo` → el picker se renderiza sobre el CodeEditor (app.student.take.$examId.tsx:2403) → cambiar el compilador del Select y aparece el chip «Override». Se reproduce igual en Talleres (WorkshopQuestions.tsx:3003), Proyectos (ProjectFiles.tsx:3175) y la hoja de código de la pizarra (CodePageEditor.tsx:319).",
    "razon": "Confirmado leyendo el archivo completo: 0 t(), los 4 literales están donde dice y no hay guard ni wrapper que los traduzca. Lo que corregí es el ENCUADRE, y lo deja MÁS sólido que el reportado: el caso alcanzable no es el hipotético usuario en inglés (que requiere cambiar el idioma a mano y lo pierde al recargar), sino el usuario en español —o sea todos, porque la app arranca siempre en es— que ve «(default)» y «Override» en inglés durante un examen. Además «Override» es jerga de mecanismo, justo lo que P6 prohíbe en texto visible. No es preferencia de estilo: el repo tiene un gate dedicado (keys-registered.test.ts) contra este tipo de fuga.",
    "severidadFinal": "media",
    "fix": "Importar useTranslation y envolver los 4 textos: L96 t(\"codeRunner.compilerLabel\", { defaultValue: \"Compilador:\" }), L111 t(\"codeRunner.useDefault\", { defaultValue: \"Por defecto\" }), L121 t(\"codeRunner.isDefaultSuffix\", { defaultValue: \"(predeterminado)\" }), L128 t(\"codeRunner.overridden\", { defaultValue: \"Cambiado\" }) — «Override» debe salir por P6. En LABELS (L45-50) separar el nombre propio del sufijo traducible: cheerp: `CheerpJ (${t(\"codeRunner.inBrowser\", { defaultValue: \"navegador\" })})`. Registrar las claves en es.json Y en.json (keys-registered.test.ts las exige en ambos). Prioridad real: L121 y L128 primero — son las que ve el 100% de los usuarios.",
    "frente": "i18n"
  },
  {
    "titulo": "Los nombres y descripciones de los prompts de IA se renderizan crudos, sin t()",
    "archivo": "src/modules/admin/AdminPromptsPanel.tsx",
    "linea": 862,
    "real": true,
    "rol": "Admin / SuperAdmin",
    "queVeElUsuario": "Con la app en English, /app/admin/ai-prompts muestra encabezado, filtros y badges en inglés («Default», «Customized») pero los ~25 nombres de caso de uso y sus descripciones en español: «Taller completo», «Pregunta de examen», «Detección de copia entre estudiantes», y en el tooltip «Calificación de un taller entero (todas las respuestas del estudiante en bloque).».",
    "camino": "Cambiar idioma a English desde el menú de opciones del sidebar. Admin o SuperAdmin → /app/admin/ai-prompts → tab «Prompts». filteredUseCases.map (L860) pinta {uc.label} en L862 y {uc.description} dentro del HelpHint en L873, sin t(); los literales viven en USE_CASES (L126+). En la misma card, badgeDefault (L868), badgeCustomized (L872) y helpHintDynamic (L879) sí usan t(). uc.label además se interpola dentro de textos traducidos en L565, 576, 592, 649 y 659.",
    "razon": "El render crudo es real (verificado: uc.label solo aparece en 862/565/576/592/649/659 y uc.description solo en 873, ninguno envuelto). Pero bajo la severidad de media a baja por dos hechos que el hallazgo no pesa: (1) el cuerpo de cada card ES contenido español —el Textarea muestra uc.defaultPrompt, un prompt de 300-600 caracteres en español que el admin edita— así que traducir el título no vuelve la pantalla inglesa; el admin que no lee español no puede usar este módulo de todas formas, y eso no lo arregla i18n; (2) es Admin/SuperAdmin únicamente y requiere un cambio manual de idioma que no sobrevive al recargar (lng pinneado a 'es' en src/i18n/index.ts:33).",
    "severidadFinal": "baja",
    "fix": "Copiar el patrón del panel hermano AdminEmailSettingsPanel.tsx:579-585 (clave dinámica + defaultValue): {uc.label} → t(`adminPromptsPanel.useCase_${uc.key}_label`, { defaultValue: uc.label }) y {uc.description} → t(`adminPromptsPanel.useCase_${uc.key}_desc`, { defaultValue: uc.description }), y lo mismo en los otros 5 usos de uc.label. Registrar los pares en es.json y en.json. Si se hace, hacerlo junto con los defaultPrompt (o dejarlo documentado como límite conocido): traducir solo las etiquetas deja la pantalla igual de inservible para un admin que no lee español.",
    "frente": "i18n"
  },
  {
    "titulo": "Se inyecta el morfema plural español «es» en cadenas inglesas: el docente lee «3 student paires»",
    "archivo": "src/modules/exams/FraudPanel.tsx",
    "linea": 878,
    "real": true,
    "rol": "Docente / Admin",
    "queVeElUsuario": "Con la app en English el badge del panel de fraude muestra «3 student paires» (no «3 student pairs»), y el toast tras detectar copias dice «Detection complete: 3 suspicious paires.». Palabra inglesa con terminación de plural español pegada por interpolación. El número es correcto; lo que está mal escrito es el sustantivo.",
    "camino": "Cambiar idioma a English. Docente → /app/teacher/exams → abrir examen → Monitor → sección «Possible copies between students»: con groupedPairs.length ≥ 2 el badge llama t(\"hc_modulesExamsFraudPanel.studentPairsCount\", { count, plural: \"es\" }) (L876-879) contra el valor en.json «{{count}} student pair{{plural}}». El segundo caso: pulsar «Detectar copias» y encontrar 2+ pares → L416-420 arma suspiciousPairsLabel con el mismo plural:\"es\" contra «{{count}} suspicious pair{{plural}}». Con exactamente 1 par el plural es \"\" y el texto sale correcto en los dos idiomas.",
    "razon": "Verificado contra los JSON: es.json tiene «{{count}} par{{plural}} de estudiantes» y «{{count}} par{{plural}} sospechoso{{pluralAdj}}» (correctos con \"es\"), en.json tiene «{{count}} student pair{{plural}}» y «{{count}} suspicious pair{{plural}}» (rotos con \"es\"). Y confirmé que de los 15 call sites de `plural:` del repo solo estos dos (FraudPanel:418 y :878) pasan \"es\"; el resto pasa \"s\", que coincide en ambos idiomas — por eso este es el único que falla. Bajo de media a baja: el conteo es correcto, el texto sigue siendo comprensible, y hace falta idioma inglés (manual, no persistente) MÁS un examen con 2+ pares de copia detectados. Es un error ortográfico visible, no un dato incorrecto ni algo que rompa el flujo.",
    "severidadFinal": "baja",
    "fix": "Dejar de pasar la morfología por interpolación y usar la pluralización nativa de i18next, que ya se usa en el repo (audit.totalEvents_one/_other, pptxViewer.slideCount_one/_other): crear hc_modulesExamsFraudPanel.studentPairsCount_one/_other y suspiciousPairsLabel_one/_other en es.json y en.json, y llamar t(clave, { count }) sin plural ni pluralAdj en L876-879 y L416-420. Eso además elimina el {{pluralAdj}} que hoy existe solo en el valor español de suspiciousPairsLabel (única desalineación de placeholders entre locales que encontré) y evita que el próximo idioma repita el bug.",
    "frente": "i18n"
  },
  {
    "titulo": "El texto de dos notificaciones al estudiante se inserta hardcodeado en español, saltando el patrón i18n del resto",
    "archivo": "src/modules/exams/exam-notes-notify.ts",
    "linea": 52,
    "real": true,
    "rol": "Estudiante (lo genera el Docente)",
    "queVeElUsuario": "En la campana (y en el correo, porque kind='exam' es critical kind) el estudiante recibe siempre en español «Nota de apoyo aprobada — <examen>» / «Nota de apoyo rechazada — <examen>» + el cuerpo con «Motivo: …», y «Examen asignado» / «Se te ha asignado el examen \"X\"» al ser asignado — mientras las notificaciones equivalentes de taller y proyecto sí respetan el idioma de la sesión que las generó.",
    "camino": "(a) Docente → /app/teacher/exams → revisar la nota de apoyo de un alumno → Aprobar/Rechazar (ExamNotesManager.tsx:342/:404 o PendingExamNotesModal.tsx:184/:253) → buildExamNoteReviewedMessage arma title/body con template literals españoles (L49, L52-53, L57-58). (b) Docente → /app/teacher/exams/<id> → tab de asignación → tildar un estudiante: app.teacher.exams.$examId.tsx:999 inserta title:\"Examen asignado\" con body interpolado, y otra vez en la asignación masiva (:1052). Contraste verificado en el mismo repo: app.teacher.workshops.tsx:2820-2821 y app.teacher.projects.tsx:2136 usan i18n.t/t para exactamente lo mismo.",
    "razon": "La inconsistencia es real y la comprobé en los tres archivos. Bajo de media a baja por tres cosas: (1) el idioma de una notificación queda congelado al del DOCENTE que la dispara, así que el 'fix' no le da al estudiante SU idioma — solo alinea estos 3 inserts con los otros, y en una institución en español (el caso por defecto, porque la app arranca siempre en es) no hay defecto visible en absoluto; (2) src/modules/exams/exam-notes-notify.test.ts assertea los literales exactos («Nota de apoyo aprobada — Parcial II», «tu examen»), o sea el wording es un contrato testeado, no un olvido; (3) el tercer caso que sumaba el hallazgo (SystemDiagnosticsPanel.tsx:391-392, «Push de prueba») se auto-notifica: el insert usa user_id: u.user.id, así que lo lee el mismo Admin que apretó el botón de prueba — impacto nulo, quitarlo del hallazgo.",
    "severidadFinal": "baja",
    "fix": "Seguir el patrón de app.teacher.workshops.tsx:2820: en exam-notes-notify.ts usar i18n.t con claves examNotes.reviewedApprovedTitle/Body, reviewedRejectedTitle/Body y examNotes.fallbackExamTitle (para «tu examen», L49), interpolando examTitle y rejectionReason; en app.teacher.exams.$examId.tsx:999 y :1052 reemplazar el literal por i18n.t con una clave + {{title}}. Registrar todo en es.json y en.json. OBLIGATORIO al hacerlo: actualizar exam-notes-notify.test.ts, que hoy compara los literales españoles y va a romper (o forzar lng='es' en ese test, que ya es lo que hace src/test/setup.ts:13). Documentar en el docstring que el idioma es el del docente revisor — es el límite del patrón client-side, y las notificaciones creadas por triggers SQL siguen en español por diseño.",
    "frente": "i18n"
  },
  {
    "titulo": "El botón de cerrar de todos los diálogos y del drawer móvil se anuncia «Close» en inglés",
    "archivo": "src/components/ui/dialog.tsx",
    "linea": 69,
    "real": true,
    "rol": "todos los roles (usuarios de lector de pantalla)",
    "queVeElUsuario": "Un usuario con lector de pantalla en español (NVDA/JAWS/VoiceOver es-CO) oye «Close» como único nombre accesible de la X de CUALQUIER diálogo de la app, en vez de «Cerrar». Como la app arranca SIEMPRE en español, esto le pega al idioma mayoritario, no a un caso hipotético.",
    "camino": "Abrir cualquier modal con un lector de pantalla activo y tabular hasta la X → se anuncia «Close». dialog.tsx tiene 91 archivos importadores (crear examen, calificar, confirmar, etc.). El mismo literal está en sheet.tsx:74, que es el drawer lateral del sidebar en móvil (importado por AppLayout.tsx y sidebar.tsx) — o sea el menú principal en móvil.",
    "razon": "Confirmado: el <span className=\"sr-only\">Close</span> es el ÚNICO nombre accesible del control (DialogPrimitive.Close no lleva aria-label ni title que lo respalde), así que no hay guard aguas arriba. Y la clave common.close ya existe en los dos locales («Cerrar» / «Close»), o sea el fix no requiere decidir wording. Ninguno de los dos archivos importa i18n. Severidad baja correcta: es texto invisible, no bloquea a nadie que use el mouse o Escape, y afecta solo a lectores de pantalla.",
    "severidadFinal": "baja",
    "fix": "En dialog.tsx:69 y sheet.tsx:74 reemplazar <span className=\"sr-only\">Close</span> por {t(\"common.close\")} importando useTranslation (ambos ya son componentes de React, así que no hace falta i18n.t). La clave common.close ya está registrada en es.json y en.json — no hay que agregar nada. NO tocar carousel.tsx:198/226, breadcrumb.tsx:88 ni sidebar.tsx:280: son boilerplate de shadcn sin importadores reales, ningún usuario los alcanza.",
    "frente": "i18n"
  },
  {
    "titulo": "El título de la pestaña del navegador está hardcodeado en español en las rutas públicas y de autenticación",
    "archivo": "src/routes/auth.index.tsx",
    "linea": 41,
    "real": true,
    "rol": "todos los roles (sin sesión)",
    "queVeElUsuario": "En /auth, tras elegir English en el switcher de la propia pantalla, el formulario pasa a inglés y la pestaña sigue diciendo «Iniciar sesión — ExamLab», y no cambia nunca (el head ya corrió y no se re-evalúa al cambiar de idioma).",
    "camino": "CORREGIDO — el camino reportado NO es alcanzable. Real: abrir /auth (arranca en español), pulsar el LanguageSwitcher de auth.index.tsx:523 → English: el formulario se traduce y el <title> del head (L41) queda en español. Lo mismo en auth.reset-password.tsx:42, auth.confirm-email-change.tsx:40, auth.cancel-email-change.tsx:28 y auth.sso-callback.tsx:36 si se llega con el idioma ya cambiado en esa sesión.",
    "razon": "El literal español existe y el título no reacciona al cambio de idioma, así que hay defecto — pero el camino del hallazgo es FALSO y hay que corregirlo antes de que el dueño lo intente: dice «poner el navegador en inglés (el detector lee navigator cuando no hay examlab:lang)», y el detector NUNCA corre. src/i18n/index.ts:33 fija lng:'es', e i18next llama changeLanguage(options.lng) en init (i18next.js:1873) mientras la rama del detector es if(!lng) (i18next.js:2014) — o sea navigator no se consulta jamás y examlab:lang se escribe pero no se lee al arrancar. También hay que RECORTAR el alcance: asistencia.tsx:41 y encuesta.$token.tsx:49 no tienen switcher (LanguageSwitcher solo se importa en auth.index y AppLayout), así que ahí título y contenido salen los dos en español — no hay desajuste y no son hallazgo. Queda solo el caso /auth con cambio manual en la misma pantalla: real, pero marginal.",
    "severidadFinal": "baja",
    "fix": "OJO: la premisa del fix reportado también es incorrecta — head: () => ({...}) SÍ es una función que se evalúa al matchear la ruta, y i18n está completamente inicializado de forma sincrónica (los resources van inline, así que load() corre sync), o sea i18n.t dentro del head funciona. El problema real es otro: el head no se re-evalúa cuando el usuario llama changeLanguage, así que la opción (b) no arregla el caso alcanzable. Usar la (a): dejar el meta como fallback y en el componente hacer useEffect(() => { document.title = t(\"auth.pageTitleLogin\"); }, [t]) — reacciona al switcher y no evalúa nada en SSR (mismo criterio que <CurrentYear /> en index.tsx). Registrar las claves en es.json y en.json. No tocar «Reto en vivo · ExamLab» (reto.$pin.tsx:56): es marca y ya usa el naming correcto. Antes que esto, sin embargo, conviene arreglar el pin de lng:'es' en src/i18n/index.ts:33 — mientras la elección de idioma se pierda en cada recarga, este título es el menor de los problemas de i18n del proyecto.",
    "frente": "i18n"
  },
  {
    "titulo": "El deploy de edge functions genera un config.toml que descarta 11 de los 13 verify_jwt=false",
    "archivo": ".github/workflows/deploy-edge-functions.yml",
    "linea": 264,
    "real": true,
    "rol": "Docente / Admin (víctima) — el defecto está en el pipeline",
    "camino": "El heredoc de las líneas 264-272 escribe en /tmp/sb-deploy/supabase/config.toml SOLO [functions.calendar-oauth-callback] y [functions.send-push]. El paso siguiente (línea 275) corre `supabase functions deploy` con working-directory /tmp/sb-deploy, así que ESE es el config que lee el CLI, no supabase/config.toml del repo (que declara verify_jwt=false para 13 funciones). Toda función ausente del config se despliega con el default del CLI (verify_jwt=true). VERIFICADO EMPÍRICAMENTE contra producción (GET sin header Authorization a https://uxxpzfsfcnqiwwdxoelm.supabase.co/functions/v1/<fn>): send-push y calendar-oauth-callback —las dos que SÍ están en el config generado— dejan pasar al handler (respuestas propias: {\"error\":\"Unauthorized\"} y un 500 del handler), mientras retry-failed-ai-gradings, ai-grading-worker, ai-generation-worker, generate-contents, ai-generate-questions, ai-grade-submission, calendar, db-backup-runner, request-password-reset, confirm-password-reset y public-attendance-check-in devuelven el 401 del GATEWAY ({\"code\":\"UNAUTHORIZED_NO_AUTH_HEADER\"}) → verify_jwt está TRUE en prod, contra lo que declara el repo. Los dos callers rotos son concretos: (a) trigger_retry_failed_ai_gradings (supabase/migrations/20260525110000:86) hace net.http_post con headers {Content-Type, X-Trigger-Secret} y SIN Authorization → el gateway rebota antes del handler y net.http_post es fire-and-forget (ni excepción, ni audit log); (b) los cron de los workers mandan 'Bearer ' || service_role_key (20260603100800:57, 20260603080000:48, 20261660000000:99) y la key de este proyecto es del formato nuevo (.env.local: SUPABASE_SERVICE_ROLE_KEY=sb_secret_…), o sea NO es un JWT parseable → UNAUTHORIZED_INVALID_JWT_FORMAT. Los caminos del navegador NO se rompen: la publishable key es un JWT legacy (eyJhbGciO…) y functions.invoke la manda, así que login, reset de contraseña y check-in público siguen funcionando.",
    "queVeElUsuario": "Nada — y ese es el problema. El cron de reintento de calificaciones IA (cada 30 min) nunca corre: una entrega que falló por un error transitorio queda 'Error IA' para siempre y el docente ve la nota pendiente sin explicación. Los jobs de la cola de generación fallan con «HTTP 401: UNAUTHORIZED_INVALID_JWT_FORMAT» en Cola IA → Generaciones (exactamente el síntoma que esas líneas de config.toml existen para arreglar), y el drenado por cron de la cola de calificación tampoco corre. También quedan muertos el backup semanal de la base (db-backup-runner) y la sincronización de grabaciones del calendario (acción cron_sync_recordings). El run del workflow termina en verde: «Resumen deploy: N OK, 0 fallidas».",
    "razon": "No es especulación sobre la semántica del CLI: se probó contra producción. Las 2 funciones declaradas en el config generado tienen verify_jwt=false y las 11 omitidas lo tienen en true, así que la omisión SÍ resetea el flag en cada deploy — y cualquier cambio en supabase/functions/_shared/** fuerza deploy_mode=all (líneas 166-170), así que se redespliegan todas juntas. Además el timeline lo respalda: el paso del config mínimo existe desde 301c305e (2026-05-11) y los verify_jwt=false de retry (640c6e8b, 2026-05-18), ai-grading-worker/ai-grade-submission (e52596d3, 2026-05-21) y ai-generate-questions (c5881ff1, 2026-06-06) se agregaron DESPUÉS y solo tocaron supabase/config.toml — nunca llegaron al proyecto remoto.",
    "severidadFinal": "alta",
    "fix": "Derivar el config del propio supabase/config.toml en ese paso en vez de mantener una copia a mano: parsear los bloques [functions.\"x\"] y emitir su verify_jwt (un `node -e` o `awk` sobre el archivo del repo alcanza; si el problema son las claves viejas que el CLI rechaza, emitir SOLO project_id + los bloques [functions.*]). Agregar un guard que FALLE el run si alguna función con verify_jwt=false en el repo no aparece en el config generado — sin eso, el próximo verify_jwt=false vuelve a quedarse afuera en silencio. Después del primer deploy correcto, re-verificar con el mismo probe: un GET sin Authorization debe devolver la respuesta del HANDLER, no UNAUTHORIZED_NO_AUTH_HEADER.",
    "frente": "errores"
  },
  {
    "titulo": "Dashboard del Docente: «Sesiones hoy», «Próximas clases» y «Próximos exámenes» traen los cursos de otros docentes",
    "archivo": "src/routes/app.index.tsx",
    "linea": 1039,
    "real": true,
    "rol": "Docente",
    "camino": "TeacherDashboard se monta solo con activeRole === 'Docente' (línea 144). Las tres queries no pasan por course-scope.ts y confían en un comentario falso: «RLS recorta a sus cursos» (línea 1036) y «todaySessions = attendance_sessions … (RLS filtra por mis cursos)» (línea ~845). La policy vigente es attendance_sessions_select_in_tenant (supabase/migrations/20261065000000, la más reciente sobre esa policy): course_in_my_tenant(course_id) AND (has_role('Docente') OR has_role('Admin') OR is_super_admin() OR <rama estudiante con matrícula>) — la rama Docente es TENANT-WIDE y la propia migración lo dice («El Docente sigue viendo tenant-wide (sin regresión)»). Idéntico en exams_select_in_tenant (20261070000000:24-41). Sitios afectados: línea 857 (count de attendance_sessions = tile «Sesiones hoy»), 1039 (attendance_sessions = «Próximas clases»), 1062 (exams = «Próximos exámenes»). Reproducción: institución con dos docentes; el docente A entra a /app y ve en su agenda las clases y los exámenes publicados de los cursos del docente B.",
    "queVeElUsuario": "El docente entra a /app y en «Próximas clases» ve clases de cursos que no dicta, en «Próximos exámenes» exámenes de otros docentes de la institución, y el tile «Sesiones hoy» cuenta las sesiones de TODA la institución. En un tenant con 4 cursos de distintos docentes, su agenda muestra los 4.",
    "razon": "Confirmado en los dos extremos: la policy más reciente de cada tabla deja la rama Docente sin scope de curso, y el propio archivo se contradice — el bloque «Pendientes de calificación» (líneas 908-914) sí resuelve course_teachers y filtra con .in(...), así que dos tiles del mismo panel usan universos distintos. No es una decisión deliberada: CLAUDE.md tiene la regla dura «ALCANCE DE DATOS del docente → SIEMPRE por course-scope.ts, nunca 'la RLS ya acota'» y su lista de pantallas aplicadas NO incluye el dashboard. Descartado como falso positivo el caso Admin/SA: ese branch no renderiza TeacherDashboard.",
    "severidadFinal": "alta",
    "fix": "const ids = await scopedCourseIds(activeRole, roles, userId) de src/modules/courses/course-scope.ts. Si ids === null (Admin/SA) no acotar; si ids.length === 0 setear vacío y NO consultar (un .in(col, []) en PostgREST devuelve TODAS las filas); si hay ids agregar .in(\"course_id\", ids) a las tres queries (857, 1039, 1062). Borrar los comentarios «RLS recorta a sus cursos» / «RLS filtra por mis cursos» — son la causa de que el bug se repita en cada pantalla nueva.",
    "frente": "errores"
  },
  {
    "titulo": "El buscador ⌘K le muestra al estudiante exámenes en BORRADOR y EXTERNOS",
    "archivo": "src/modules/search/global-search.ts",
    "linea": 322,
    "real": true,
    "rol": "Estudiante",
    "camino": "searchExams (líneas 307-323) selecciona \"id, title, course:courses(id, name, deleted_at)\" — sin status ni is_external — y para el estudiante solo filtra .in(\"id\", s.studentExamIds), que sale de exam_assignments (línea 183). Que un examen en borrador TENGA assignments es el caso normal, no el raro: el diálogo de creación nace con status:\"draft\" (app.teacher.exams.index.tsx:490) y autoAssignExam(data.id, cid) corre incondicionalmente justo después del insert (línea 673) — de hecho el mismo bloque saltea a propósito la notificación cuando es draft («el examen aún no es visible, mandar push sería confuso») pero la asignación se hace igual. Los externos también se auto-asignan. Reproducción: el docente crea un examen (queda borrador), el estudiante abre ⌘K, escribe parte del título y lo ve; al pulsarlo cae en /app/student/exams, que filtra draft/externo tanto en la consulta (.neq(\"exam.status\",\"draft\"), .is(\"exam.is_external\", false), líneas 184-190) como en el .filter posterior (línea 210).",
    "queVeElUsuario": "El estudiante ve en el buscador el título de un examen que el docente todavía no publicó (o uno externo, que solo registra notas), y al abrirlo la lista de exámenes no lo tiene: el buscador le anuncia una evaluación que la pantalla niega.",
    "razon": "Es un olvido, no una decisión: searchWorkshops (línea 386) y searchProjects (línea 447) hacen exactamente rows.filter((r) => !r.is_external && (r.status ?? \"published\") !== \"draft\") con el comentario «Paridad con la vista del alumno», y app.student.exams.tsx aplica el doble filtro con un comentario que explica por qué no basta el .filter del cliente. La palette está montada para todos los roles (AppLayout:1139, sin gate de rol), así que el camino es alcanzable. La RLS no salva: exams_select_in_tenant admite al estudiante con assignment sin mirar status.",
    "severidadFinal": "media",
    "fix": "Agregar `status, is_external` al select de searchExams y, en la rama !s.staff, aplicar el mismo predicado que ya usan talleres y proyectos antes del finish(...): rows = rows.filter((r) => !r.is_external && (r.status ?? \"published\") !== \"draft\").",
    "frente": "errores"
  },
  {
    "titulo": "Al crear/publicar un taller, si falla la asignación de estudiantes el docente ve «Taller creado» y ningún alumno lo ve",
    "archivo": "src/routes/app.teacher.workshops.tsx",
    "linea": 701,
    "real": true,
    "rol": "Docente (lo sufre el Estudiante)",
    "camino": "autoAssignWorkshop (líneas 687-704) hace `await supabase.from(\"workshop_assignments\").insert(...)` sin destructurar ni revisar error, y tampoco revisa el error del select de course_enrollments (línea 688: si esa query falla, enr es vacío y hace return silencioso sin asignar a nadie). Se la llama en creación (1329) y en edición (1240); inmediatamente después el bucle dispara notify_course_students (1331) y luego sale el toast.success (1339-1348). Como la rama de estudiante de workshops_select_in_tenant exige EXISTS en workshop_assignments (20261070000000:50-66), un insert que falla —corte de red a mitad del bucle por curso, 23505 por carrera contra existingSet, rechazo de workshop_assignments_write— deja el taller invisible para todo el curso mientras la notificación ya salió.",
    "queVeElUsuario": "El estudiante recibe la notificación «Nuevo taller: X», la pulsa, llega a /app/student/workshops y el taller no está. El docente vio «Taller creado correctamente» y jura que lo publicó.",
    "razon": "El defecto es real y está admitido en el propio repo: el hermano exacto, autoAssignExam (app.teacher.exams.index.tsx:362-389), SÍ revisa el error y lanza un toast con el comentario «si la auto-asignación falla el docente DEBE saberlo (sin assignments el alumno no ve el examen)» — talleres quedó sin ese arreglo. Ajusto la expectativa: no hay un camino determinístico (la policy workshop_assignments_write solo pide Docente/Admin del tenant del taller, así que el insert normal no se rechaza); depende de un fallo transitorio o de una carrera, y el agravante es que la notificación ya se envió.",
    "severidadFinal": "media",
    "fix": "Devolver el error desde autoAssignWorkshop (`const { error } = await supabase.from(\"workshop_assignments\").insert(...); return error ?? null;`) y revisar también el error del select de course_enrollments. En los dos call sites acumular el primer error del bucle y, si hubo alguno, reemplazar el toast.success por el patrón de la convención de bulk: «Taller creado, pero no se pudo asignar a los estudiantes de N curso(s). Primero: «<curso>» — friendlyError(err)» con duration: 12000.",
    "frente": "errores"
  },
  {
    "titulo": "Editar un taller borra sus vínculos a cursos y no verifica que el re-insert funcione: pesos y cortes se pierden con toast de éxito",
    "archivo": "src/routes/app.teacher.workshops.tsx",
    "linea": 1224,
    "real": true,
    "rol": "Docente (lo sufren Docente y Estudiante en las notas)",
    "camino": "En el guardado de edición: `await dbAny2.from(\"workshop_courses\").delete().eq(\"workshop_id\", form.id)` (1197) y después `await dbAny2.from(\"workshop_courses\").insert(wcEditRows)` (1224) — ninguno destructura error. Es un DELETE+INSERT no transaccional a través de dos llamadas HTTP (el comentario de la línea 1186 lo llama «atómica por workshop_id», que no es cierto entre dos requests). Si el INSERT falla —corte de red entre las dos llamadas, 23502 porque course_id es NOT NULL (20260704000000:31) cuando finalCourseIds cae al fallback [form.course_id!] y ese valor es null, FK de cut_id, rechazo de policy— el DELETE ya se aplicó y el taller queda SIN filas en workshop_courses, o sea sin cut_id ni weight por curso, que es exactamente de donde el gradebook (app.teacher.gradebook.tsx:427-429) y las notas del alumno (app.student.grades.tsx:197) leen el aporte del taller. Mismo patrón sin chequeo en la línea 1231 (workshop_assignments.delete cuando cambió el curso). El flujo llega igual al toast.success(t(\"workshop.saved\")) de la línea 1256.",
    "queVeElUsuario": "El docente edita un taller, ve «Taller guardado», y a partir de ahí el taller deja de aportar a la nota: en el gradebook desaparece su peso/corte y la nota final del curso cambia sin que nadie tocara notas.",
    "razon": "Confirmado que la pérdida importa (gradebook y notas del estudiante leen weight/cut_id de workshop_courses) y que el patrón seguro ya existe en el módulo hermano: proyectos hace UPSERT con onConflict + revisión de error y toast (app.teacher.projects.tsx:1185-1188) y solo después borra los sobrantes — nunca destruye primero. O sea, la asimetría es un olvido, no un criterio. Lo que NO sostengo es que sea frecuente: hace falta un fallo entre las dos llamadas para perder los datos.",
    "severidadFinal": "media",
    "fix": "Revisar el error de las dos operaciones y no llegar al toast de éxito si el insert falló: `const { error: insErr } = await ...insert(wcEditRows); if (insErr) { toast.error(friendlyError(insErr, \"El taller se guardó pero se perdió su vínculo con los cursos — volvé a guardar\")); }`. Mejor: copiar el orden de proyectos (upsert con onConflict \"workshop_id,course_id\" y después delete de los que no quedaron seleccionados), o mover el sync M:N a una RPC SECURITY INVOKER que haga DELETE+INSERT en una sola transacción, como ya se hizo con clone_workshop.",
    "frente": "errores"
  },
  {
    "titulo": "El monitor del examen en vivo se queda en «Cargando…» para siempre cuando la carga falla",
    "archivo": "src/routes/app.teacher.monitor.$examId.tsx",
    "linea": 396,
    "real": true,
    "rol": "Docente",
    "camino": "load() (líneas 396-467) descarta el error de las cinco queries: `const { data: e } = await ...from(\"exams\")...maybeSingle(); setExam(e ?? null)`. El render hace `if (!exam) return <p className=\"text-muted-foreground p-6\">{t(\"common.loading\")}</p>` (línea 1414) y en TODO el archivo no hay ni un ErrorState ni un estado de error (grep: 0 hits de ErrorState/loadError). Camino determinístico: un alumno supera el máximo de advertencias → app.student.take.$examId.tsx:1165 le manda al docente una notificación con _link `/app/teacher/monitor/${examId}` → el docente manda ese examen a la papelera → más tarde pulsa la notificación (o el enlace del panel Cron, AiCronPage.tsx:203) → la query lleva .is(\"deleted_at\", null), devuelve null, y la pantalla queda en «Cargando…» para siempre. Camino transitorio, en el peor momento: un 5xx o un corte de red durante el examen en vivo también deja setSubmissions([]) (línea 432), o sea «ningún estudiante rindiendo», hasta el próximo tick del setInterval(load, 60000) (línea 674).",
    "queVeElUsuario": "El docente abre el monitor de un examen en curso, o entra desde la notificación de «examen sospechoso», y ve solo «Cargando…», indefinidamente, sin error y sin botón de reintentar. En el caso transitorio se destraba a los 60 s; si el examen está en la papelera, nunca.",
    "razon": "Verificado que no hay ningún guard aguas arriba: la ruta no tiene errorComponent propio para este caso (el maybeSingle no lanza, devuelve null) y el archivo no distingue «cargando» de «no existe» ni de «falló». El deep-link a un examen borrado es alcanzable porque las notificaciones no se limpian al mandar la entidad a la papelera, que es justamente la regla de la papelera del proyecto (deja de ser usable, pero el enlace sobrevive).",
    "severidadFinal": "media",
    "fix": "Destructurar el error de las queries de load() y llevarlo a un state loadError; el render debe distinguir tres casos en vez de uno: cargando (Spinner), error (<ErrorState message=\"No se pudo cargar el monitor\" hint={loadError} onRetry={() => void load()} />, el patrón que ya usa app.index.tsx:1090) y no-encontrado («Este examen ya no existe o está en la papelera» con BackLink a /app/teacher/exams). Y no pisar submissions con [] cuando la query falló — mantener el último valor bueno.",
    "frente": "errores"
  },
  {
    "titulo": "Duplicar un curso: tres de los seis pasos de copia se tragan el error y el toast dice «Curso duplicado correctamente»",
    "archivo": "src/routes/app.admin.courses.tsx",
    "linea": 1705,
    "real": true,
    "rol": "Admin y Docente (el componente AdminCourses se reusa en /app/teacher/courses)",
    "camino": "En doDuplicate: el paso 3 «Copy teachers» (1680-1694), el paso 4 «Copy exams» + sus preguntas (1697-1741) y el paso 5 «Copy workshops» (1747-1769) no destructuran error en ningún insert; el paso 4 además hace `if (newExam) {...}` sin else, así que un examen que no se pudo insertar se saltea sin rastro y un fallo del insert de questions deja el examen vacío. El toast.success de la línea 1816 sale igual. HAY un camino determinístico, no solo transitorio: la policy course_teachers_docente_manage_others (20260528000000:235-246) exige `user_id <> auth.uid()`, así que cuando un DOCENTE duplica con «copiar docentes» activado, el batch incluye su propia fila (él es docente del curso origen) y Postgres evalúa el WITH CHECK de RLS ANTES del ON CONFLICT DO NOTHING → la sentencia entera se rechaza con 42501 y NINGÚN co-docente se copia. Reproducción: docente de un curso co-dictado → menú de fila → Duplicar → activar «copiar docentes» → «Curso duplicado correctamente» → el curso nuevo tiene solo a él (lo agrega el trigger tg_course_add_creator_teacher) y el co-docente no puede verlo ni gestionarlo.",
    "queVeElUsuario": "El Admin (o el Docente) duplica un curso con «copiar exámenes» / «copiar talleres» / «copiar docentes» marcados, ve «Curso duplicado correctamente», entra al curso nuevo y falta parte: no hay exámenes, o hay exámenes sin preguntas, o falta el co-docente.",
    "razon": "Que es un olvido lo prueban los pasos vecinos del MISMO bloque: el paso 2 «Copy students» (1659-1676) y el paso 6 «Copy board» (1779-1806) sí revisan el error y sacan toast.error(friendlyError(...)), con el comentario explícito de por qué («sin upsert, el 2do intento abortaba TODA la copia dejando el curso destino con 0 alumnos»). Además encontré el camino determinístico que el hallazgo original no tenía (RLS de course_teachers con user_id <> auth.uid()), así que no depende de un fallo transitorio. Descarté en cambio la sospecha de que exams/questions fallaran para un Docente por las policies nuevas de 20261190000000 (_teaches_course): el trigger tg_course_add_creator_teacher (20260963000000:196) lo agrega como docente del curso nuevo, así que esos dos pasos sí pasan la RLS.",
    "severidadFinal": "media",
    "fix": "Acumular el primer error real de cada paso en un `let firstCopyError` y contar los ítems copiados; al final, si hubo error, reemplazar el toast.success por el patrón de bulk ops: toast.error(\"Curso creado, pero la copia quedó incompleta: N de M exámenes. Primero: «<título>» — \" + friendlyError(firstCopyError), { duration: 12000 }). Aplicarlo también al insert de questions (para no dejar un examen vacío sin avisar). Para course_teachers, excluir la propia fila del batch (el trigger ya la crea): `ct.filter((t) => t.user_id !== user?.id)` — así el Docente deja de chocar con la policy.",
    "frente": "errores"
  },
  {
    "titulo": "El módulo Calendario muestra códigos internos del edge como texto de error al docente",
    "archivo": "src/routes/app.teacher.calendar.tsx",
    "linea": 247,
    "real": true,
    "rol": "Docente",
    "camino": "loadCalendars (237-250) hace `catch (e) { setCalendarsError((e as Error).message) }` y ese string se renderiza crudo en <Alert variant=\"destructive\"><AlertDescription>{calendarsError}</AlertDescription></Alert> (465-468), REEMPLAZANDO al selector de calendario del «Paso 1». El mensaje viene de callCalendar, que lanza new Error(detail || \"unknown_error\") con el texto del edge (línea 84); el edge devuelve códigos snake_case (jsonError(\"provider_mismatch\") línea 440, \"no_calendar_selected\" 438, \"calendar_not_accessible\" 475, \"unauthorized\" 127) y en el catch general reexpone literales de _shared/calendar-google.ts: throw new Error(\"not_connected\") (línea 138) y `Google refresh falló [${res.status}]: ${text}` (línea 121) vía jsonError((e as Error).message, 500) (calendar/index.ts:157). Camino exacto: el docente revoca el acceso de ExamLab en su cuenta de Google (o el refresh token caduca — con la app en modo testing de Google eso pasa a los 7 días), vuelve a /app/teacher/calendar; status.connected sigue true porque la fila de tokens existe, el effect de la línea 254 dispara loadCalendars, y en lugar del selector aparece el JSON de Google.",
    "queVeElUsuario": "En /app/teacher/calendar, donde debería estar el selector de calendario, aparece una alerta roja cuyo texto completo es «Google refresh falló [400]: {\"error\":\"invalid_grant\",\"error_description\":\"Token has been expired or revoked.\"}» — o simplemente «not_connected» / «provider_mismatch». Sin decirle qué hacer: el «Paso 1» queda inservible y la única salida (el botón «Desconectar» de la tarjeta de arriba, línea 448) no está señalada por ningún lado.",
    "razon": "Real y no es preferencia de estilo: viola P6 (el texto visible no lleva el mecanismo) y el propio archivo demuestra el patrón correcto — handleSync mapea calendar_not_accessible a un mensaje humano y refresca el estado (334-357), y handleConnect pasa por friendlyError (268). Corrijo un dato del hallazgo: sí existe una salida (el botón «Desconectar»), solo que el mensaje no la nombra; por eso confirmo media y no alta. Ojo con el fix fácil: friendlyError NO alcanza acá, porque estos no son códigos SQLSTATE ni errores de red y saldría el mismo texto crudo.",
    "severidadFinal": "media",
    "fix": "Un mapa CÓDIGO → t(...) compartido por loadCalendars y handleSync: not_connected e «invalid_grant»/«refresh falló» → «Se venció el permiso de tu cuenta de Google. Reconéctala para seguir sincronizando»; provider_mismatch → «Estás conectado con otro proveedor»; más no_calendar_selected y calendar_not_accessible, con un fallback genérico en español para lo no mapeado — nunca (e as Error).message. Y en el caso de credencial vencida renderizar dentro de la alerta el botón «Reconectar» (handleConnect), que es la acción que resuelve el problema.",
    "frente": "errores"
  }
]
```

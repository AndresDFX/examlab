# Hallazgos de bugs — cacería ronda 2 (2026-07-15)

Segundo barrido de correctness/lógica/integridad/seguridad-no-RLS sobre subsistemas
NO cubiertos por la [ronda 1](HALLAZGOS-BUGS-2026-07-15.md). Workflow de 8 finders
(toma de examen, colas IA, certificados, ejecución de código, auth/institución,
mensajería programada, engagement, notas-en-pantalla) + **verificación adversarial por
hallazgo** (cada uno refutado-o-confirmado leyendo el código real). 11 hallazgos, **11
confirmados, 0 refutados**.

## Arreglados

| # | Área | Sev | Bug | Fix |
|---|---|---|---|---|
| N1 | ai-queue | media | `ai-generation-worker`: `processOne` sin try/catch + fetch sin protección → un blip de red dejaba el job CLGADO en `processing` (el drain solo toma `pending`, sin rescate automático para esa cola). | try/catch convierte el throw en `result.ok=false` → entra al re-encolado/failed existente. `ai-generation-worker/index.ts` |
| N2 | ai-queue | media | `content_generation` en modo crear: al fallar el fetch transitorio se re-encolaba SIN recordar la fila `generated_contents` ya insertada → cada reintento creaba OTRA fila huérfana (contenidos duplicados atascados). | En el re-encolado transitorio, propagar `source_id = newSourceId` + `body.regenerate/target_id` → el retry reusa la fila (Path B). |
| N3 | certificates | media | `certificates.course_id` FK `ON DELETE CASCADE` → el purge de la Papelera (30 d) o hard-delete de un curso BORRABA los certificados emitidos → el egresado los perdía y `/verify` daba NOT FOUND (viola el snapshot inmutable). | FK → `ON DELETE SET NULL` + `course_id` NULLABLE. El cert sobrevive (snapshot completo); student/verify/admin siguen OK. Mig `20261240000000`, **verificado en prod** (FK confdeltype=`n`). |
| N4 | certificates | media | `issue_certificate` leía el curso sin `AND deleted_at IS NULL` → con gradebook stale se emitía sobre un curso en Papelera (regla del proyecto: RPC SECDEF deben guardar `deleted_at`). | Guard `deleted_at IS NULL` en el SELECT. Misma mig `20261240000000`, **verificado en prod**. |
| N5 | scheduled | baja | Mensaje DIRECTO programado de 4001–10000 chars se truncaba silenciosamente a 4000 al despachar (`left(body,4000)`), mientras el envío inmediato lo rechaza con error visible. | Validación de longitud (>4000 → toast + return) en `scheduleDirect` (`app.messages.tsx`), igualando el límite efectivo del envío inmediato. |
| N6 | scheduled | baja | La difusión PROGRAMADA no seteaba `source_role` en la notificación; la INMEDIATA sí → filtro de campana divergente para usuarios multi-rol (el mismo anuncio aparece/no según se envió ya o programado). | `source_role` calculado del creador en el INSERT de la rama broadcast de `dispatch_scheduled_messages`. Mig `20261250000000`, **aplicado en prod**. |
| N7 | engagement | media | `notebookCodeToScript` descartaba CELDAS COMPLETAS de cell-magics con cuerpo Python (`%%time`, `%%timeit`, `%%capture`, `%%prun`) → el código y su salida se perdían sin aviso al "Ejecutar todo". | Whitelist `INTERPRETER_CELL_MAGICS`: solo se descarta la celda si la magic cambia el intérprete; el resto conserva el cuerpo (el filtro de línea ya quita la línea `%%…`). `notebook.ts` |
| N8 | grades-ui | media | Excel export: las celdas de ITEM (taller/proyecto no-externo con `max_score`≠escala) se coloreaban comparando la nota CRUDA (ej. 40/100 → "40") contra `passing_grade` (0..5) → casi todo VERDE aunque reprobó. | No colorear columnas de item (crudo no comparable con `passing_grade`); solo asistencia-por-corte, cortes y final (todas en escala del curso). `app.teacher.gradebook.tsx` |
| N9 | code-exec | baja | `deriveMainClass`/`deriveMainClassFromFiles` ejecutaban la `public class` en vez de la que declara `main` → "main method not found" en código correcto (public class sin main + otra clase con main, en CheerpJ). | `deriveClassContainingMain` con rastreo de brace-depth (ignora comentarios/strings) → la última clase top-level antes del `main`. Preserva el contrato histórico sin main. `run-java.ts` + tests de regresión. |
| N10 | exam-take | baja | Respuestas `java_gui`/`python_gui` sin editar (con la plantilla por defecto visible) no se detectaban como respondidas ni se persistían — divergente de `codigo`. | Helper `defaultStarterFor(q)` compartido: `isQuestionAnswered` y `mergeStarterCodeAnswers` usan la MISMA plantilla que muestra el editor (`JAVA_GUI_STARTER`/`JAVAFX_STARTER`/`PYTHON_GUI_STARTER`). `app.student.take.$examId.tsx` |

## Pendientes (confirmados pero NO arreglados — requieren prueba difícil)

| # | Área | Sev | Bug | Por qué pendiente / recomendación |
|---|---|---|---|---|
| N11 | exam-take | media | El heartbeat/autosave del alumno (cada 1.5–5 s) reescribe `focus_warnings` = valor local + `answers.__warning_events` viejo. Si el docente PERDONA una advertencia desde el monitor a un alumno aún en curso (bajo el umbral), en ≤5 s el cliente del alumno la PISA → la advertencia reaparece y la acción del docente se deshace silenciosamente. Acotado: no ocurre tras suspensión (el heartbeat se detiene). | Requiere suscribir el TakeExam a `postgres_changes` de su propia fila de `submissions` y hacer merge (sincronizar refs hacia ABAJO cuando el server trae `focus_warnings` menor) ANTES del próximo heartbeat. Lógica de merge en el hot-path de un examen en vivo + **prueba multi-cliente** que no puedo ejecutar aquí. No shippear a ciegas. |
| — | whiteboard | media | (ronda 1) Race de `applyingRemoteRef` con `setTimeout(0)` en pizarra compartida → posible re-emisión/pérdida de imágenes. | Igual criterio: requiere prueba multi-cliente realtime. |

**Nota `certificates.user_id`**: también es `ON DELETE CASCADE` hacia `auth.users` (borrar la
cuenta del egresado borra sus certificados). Es el mismo patrón que N3 pero un evento más raro
y con matiz de producto (¿derecho al olvido vs. inmutabilidad del acta?) — se deja como decisión
de negocio, no se cambió en esta pasada.

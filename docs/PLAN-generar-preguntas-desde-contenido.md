# Plan de feature — Generar preguntas desde el contenido del curso (en cualquier flujo)

> Generado 2026-07 · Objetivo: que exámenes, talleres, proyectos, banco de preguntas y Reto en vivo
> puedan generar preguntas con IA **basadas en el material del curso**, no solo desde un prompt libre.
> Hallazgo clave: la maquinaria de lectura de material YA existe en el edge `ai-generate-questions`
> (modos `materialScope`) pero está **gated a Kahoot y muerta en el frontend** (Goal #18). El grueso
> del trabajo es generalizarla + exponerla en la UII de los 5 flujos.

---

## Parte 1 — Mapa del estado actual

# Mapa: Generación de preguntas con IA + lectura de material (estado actual)

## 1. Qué genera hoy `ai-generate-questions` y cómo se invoca

El edge `supabase/functions/ai-generate-questions/index.ts` es **el único punto de generación de preguntas**. Es multi-modo, seleccionado por flags en el body. Auth interna (`verify_jwt=false`): acepta `Bearer = SUPABASE_SERVICE_ROLE_KEY` (worker) o user JWT (frontend sync). Rate limit `ai.generate_questions` 30/h.

### Modos del edge

| Modo (flag en body) | Entrada | Salida / tabla destino | Líneas |
|---|---|---|---|
| `projectDescriptionGeneration` | `topic`, `courseId?`, `courseLanguage?` | `{description}` (texto plano, no persiste; el cliente lo guarda en `projects.description`) | `index.ts:516-573` |
| `projectStatement` | `topic`, `projectType`, `maxFiles` | `{title,description,instructions}` (no persiste) | `index.ts:576-652` |
| `projectQuestionsAutoGeneration` | `projectId`, `description` (completa) | inserta en **`project_files`** (fuerza 1×`codigo_zip` + 2-5 abierta/diagrama/cerrada) | `index.ts:663-846` |
| `projectFilesGeneration` | `projectId`, `topic`, `count` | inserta en **`project_files`** (title/description/expected_rubric) | `index.ts:851-974` |
| **Modo genérico** (sin flags, por `targetTable`) | `topics`, `type`, `count`, `examId`, `language?`, `courseLanguage?`, `targetTable?` | ver abajo | `index.ts:976-1458` |

### Modo genérico — ruteo por `targetTable` (`index.ts:991-1018`, `KNOWN_TARGETS`)

| `targetTable` | `examId` se reutiliza como | Tabla(s) destino | Tool IA |
|---|---|---|---|
| `"questions"` (default) | `exam_id` | `questions` | `create_questions` |
| `"workshop_questions"` | `workshop_id` | `workshop_questions` | `create_questions` |
| `"project_files"` | `project_id` | `project_files` (`title`=content) | `create_questions` |
| `"question_bank"` | `course_id` | `question_bank` (`suggested_points`, `created_by`) | `create_questions` |
| `"kahoot_questions"` | `poll_id` | `kahoot_questions` + `kahoot_question_options` (2 tablas) | `create_kahoot_questions` |

**Tipos de pregunta soportados por el tool genérico** (`create_questions`, `index.ts:1204-1244`): produce `content` + `expected_rubric` + `options` (solo para `type="cerrada"` genera `choices[4]`+`correct_index`). El `type` se pasa tal cual al INSERT; para `codigo`/`codigo_zip` resuelve `language` (`index.ts:1046-1048`); `java_gui` recibe `starter_code` boilerplate (`index.ts:1421-1432`).

### Qué flujos YA pueden generar con IA vs NO

| Flujo (UI) | Archivo caller | ¿Genera con IA? |
|---|---|---|
| **Exámenes** | `src/routes/app.teacher.exams.$examId.tsx:772-857` | Sí (por tipo, sync + cola) |
| **Talleres** | `src/modules/workshops/WorkshopQuestions.tsx:524-589` | Sí (por tipo, sync + cola) |
| **Proyectos** | `src/modules/projects/ProjectFiles.tsx` (`generateFromDescription` ~469, `generateQuestions` ~614) | Sí (descripción/files/auto-questions, sync + cola) |
| **Banco de preguntas** | `src/routes/app.teacher.question-bank.tsx:507-566` | Sí (sync + cola) |
| **Reto en vivo / Kahoot** | `src/modules/polls/KahootQuestionsEditor.tsx:282-362` | Sí (sync + cola) |

**Todos los 5 flujos ya pueden generar con IA.** Todos usan el mismo gate `aiGate.ensureAuthorized({ allowQueue: true })` → `sync` inline / código IA inmediata / `proceed-async` que encola en `ai_generation_queue` (`invoke_target:"ai-generate-questions"`, body verbatim). El worker `ai-generation-worker` drena la cola.

**Tipos NO cubiertos por este edge:** las preguntas de red (`red_consola` / `red_gui`) en exámenes se generan por un **camino cliente separado** (`networkRows` → `dbNet.from("questions").insert` directo, `app.teacher.exams.$examId.tsx:748`), no por el edge. `diagrama`, `java_gui`, `python_gui` se insertan por el edge genérico pero sin lógica especializada de rúbrica más allá del `expected_rubric`.

---

## 2. ¿Alguno usa el CONTENIDO del curso como base?

**Prácticamente ninguno en producción.** Todos los 5 callers generan **solo desde `topics` (prompt/temas libres escritos a mano)** más, en proyectos, `projectDescription`. Ninguno lee `generated_contents`.

**Excepción latente (Goal #18): el edge YA tiene toda la maquinaria de material para Kahoot, pero NINGUNA UI la activa.**

- El edge soporta `materialScope: "none"(default) | "session" | "course"` + `sessionId?` + `courseId?` **exclusivamente en el modo Kahoot** (`index.ts:983-1030`, `resolveKahootMaterial` `340-416`, `buildCourseMaterial` `271-325`).
- Extrae texto real de `generated_contents.files[]`: inline (md/txt/código/notebook via `notebookToReadableText`) + Office/PDF descargando de Storage `generated-contents` y descomprimiendo con `fflate` (`extractOfficeText` docx/pptx/xlsx `157-211`, `extractPdfText` unpdf `214-224`), con **cache-back** a `files[].body` (self-healing). Topes: 6K/doc, 22K total, 18 descargas/request.
- Scope `session` acota por `content_file_paths` o `content_class_index` de `attendance_sessions` (`index.ts:391-406`).
- **Verificado repo-wide: `materialScope` aparece SOLO en el edge; ningún `.tsx` lo envía** (ni siquiera `KahootQuestionsEditor.tsx`, que solo manda `topics/type/count/examId/targetTable` — `KahootQuestionsEditor.tsx:313-319, 333-339`). → La capacidad Goal #18 está **implementada en backend pero muerta en el frontend**.

**Referente real de lectura de material:** el **Tutor IA** (`tutor-chat`) sí lee el material en producción, con el mismo `material-extract.ts` (3 copias sincronizadas: `src/modules/contents/material-extract.ts`, `supabase/functions/tutor-chat/`, `supabase/functions/ai-generate-questions/`). El tutor además soporta `referencedFiles` (chips `#` en el composer, `isReferenceableFile`) para priorizar archivos concretos en el budget.

---

## 3. Puntos de extensión (dónde enganchar "generar desde contenido")

### Backend (edge) — extender la maquinaria de Kahoot a todos los modos
- `resolveKahootMaterial` (`index.ts:340-416`) y `buildCourseMaterial` (`271-325`) **ya son genéricas** (operan sobre `generated_contents` por `course_id`/`session`); solo están gated a `isKahoot` (`kahootFromMaterial = isKahoot && materialScope !== "none"`, `index.ts:1030`). Renombrar a `resolveCourseMaterial` y aplicarlo también a `questions`/`workshop_questions`/`project_files`/`question_bank`.
- El `userPrompt` genérico (`index.ts:1162-1169`) hoy solo inyecta `topics` + `projectCtx`. Falta un bloque `<material>…</material>` análogo al `kahootUserPrompt` (`index.ts:1154-1160`).
- El modo Kahoot resuelve `courseId` desde el poll (`index.ts:1110-1119`); para los demás modos ya se resuelve `course_id` para el `courseLanguage` (workshops→courses, projects→courses, polls→courses, exams→courses, `index.ts:1059-1102`) — reusable para localizar el material.

### Prompts (`ai_prompts`)
- `resolveSystemPrompt(useCase, courseId, fallback)` (`index.ts:108-135`) resuelve global+override por curso. Los use_cases (`workshop_full`, `exam_question`, `project_full`, `project_file`, `project_questions`, `project_description`) **no tienen placeholder de material**; el system prompt de Kahoot mete la instrucción de "basar en material" hardcoded condicionalmente (`index.ts:1135-1139`). Falta placeholder tipo `{{course_content_material}}` (como en `tutor_chat`) o inyección condicional consistente.

### UI (los 5 callers) — selector de fuente de contenido
- Cada caller tiene un panel "generar con IA" con `aiTopics`/`aiCount`/`aiType`. Falta un **selector de fuente**: `Temas` (actual) vs `Contenido del curso` (scope course) vs `Sesión` (scope session), + opcionalmente picker de archivos `#` (patrón tutor `referencedFiles`).
- Selectores de contenido disponibles: `generated_contents` filtrando `course_id` + `status='done'` + `is('deleted_at', null)` (mismo query que `resolveKahootMaterial` scope course, `index.ts:347-354`); sesiones via `attendance_sessions.content_id`/`content_file_paths`/`content_class_index`; asignaciones via `content_course_assignments`. Los flujos exam/workshop/project ya conocen su `courseId`.

### Cola de generación
- El body encolado se guarda verbatim (`ai_generation_queue.body`), así que basta con agregar `materialScope`/`sessionId`/`referencedFiles` al objeto `body` en cada `.insert()` — no requiere cambios en `ai-generation-worker` (rutea por `invoke_target`).

---

## 4. Gaps para que TODOS los flujos generen desde contenido

1. **UI: cero flujos wired.** Ninguno de los 5 callers ofrece "generar desde el material". Incluso Kahoot (Goal #18) tiene el backend listo pero **sin UI** — hay que agregar el selector de fuente + pasar `materialScope`/`sessionId`/`courseId` en ambos caminos (sync `functions.invoke` y `ai_generation_queue.insert`). Callers a tocar:
   - `app.teacher.exams.$examId.tsx:789-804 / 832-840`
   - `WorkshopQuestions.tsx:540-556 / 578-589`
   - `ProjectFiles.tsx:639-656 / 684-695` (+ `generateFromDescription`)
   - `app.teacher.question-bank.tsx:522-541 / 558-566`
   - `KahootQuestionsEditor.tsx:304-321 / 332-340`

2. **Edge: el material está gated a Kahoot.** `kahootFromMaterial = isKahoot && …` (`index.ts:1030`) y el bloque `<material>` solo se arma para Kahoot (`1105-1160`). Para exam/workshop/project/bank el `materialScope` se parsea pero se ignora (nunca entra a `resolveKahootMaterial`). Hay que generalizar: leer material para cualquier `targetTable` e inyectarlo en el `userPrompt` genérico.

3. **Prompts sin placeholder de material.** Los use_cases genéricos no tienen `{{course_content_material}}`; hay que decidir entre placeholder dedicado (como `tutor-prompt.ts` hace con plegado si el template no lo tiene) o instrucción hardcoded condicional. Sincronizar con `AdminPromptsPanel.tsx` (defaults) + seeds SQL si se agrega placeholder.

4. **Tipos no cubiertos por generación desde material:** las preguntas de red (`red_consola`/`red_gui`) van por camino cliente separado (`networkRows`, no el edge) → no se beneficiarían automáticamente. `diagrama`/`java_gui`/`python_gui` sí pasan por el edge pero convendría validar que las rúbricas generadas desde material tengan sentido para esos tipos.

5. **Contexto para "sesión" solo existe en Kahoot.** `resolveKahootMaterial` scope `session` lee `attendance_sessions`; exam/workshop/project/bank no tienen relación directa a una sesión, así que su selector de fuente probablemente se limite a `course` + picker de archivos (no `session`), salvo que se agregue selección explícita de contenidos.

6. **`extractOfficeText`/`extractPdfText`/`buildCourseMaterial` viven inline en el edge** (no en `material-extract.ts`, que es puro sin red). Al generalizar conviene mantener la parte pura en las 3 copias sincronizadas y el unzip/descarga por-edge (invariante ya documentada en CLAUDE.md). Si se replica a otro edge, replicar también fflate/unpdf.

---

## Parte 2 — Diseño del feature

# Plan de feature: "Generar preguntas desde el contenido del curso, en cualquier flujo"

## 1. Objetivo y user stories

**Objetivo.** Que el docente, desde CUALQUIER builder de evaluación (examen, taller, proyecto, banco de preguntas, Reto en vivo/Kahoot), pueda generar preguntas con IA **basadas en el material real del curso** (`generated_contents`: md/txt/código/notebook inline + Office/PDF en Storage), no solo desde un prompt de temas libres. La capacidad ya existe en el backend pero **solo para Kahoot y sin UI** (Goal #18). El feature la unifica, la expone en los 5 flujos, y agrega selección de archivos concretos (patrón `#` del tutor).

**User stories.**

1. *Como docente en el builder de examen*, pulso "Generar desde el contenido", elijo entre "Todo el curso" o "Archivos específicos" (multi-select), fijo cantidad + tipos permitidos + dificultad, y obtengo preguntas ancladas a ese material insertadas en el examen.
2. *Como docente en taller / proyecto / banco / Reto en vivo*, mismo entry-point, misma UX; los tipos ofrecidos se filtran por lo que ese flujo admite.
3. *Como docente sin material en el curso*, veo un mensaje accionable ("El curso no tiene material legible; genera o sube contenido, o genera por temas") y puedo caer al modo temas existente.
4. *Como docente*, puedo combinar material + un foco de temas ("dentro de este material, enfócate en herencia y polimorfismo").
5. *Como docente con `processing_mode=async`*, el trabajo se encola (`ai_generation_queue`) igual que hoy y las preguntas aparecen cuando hay código de IA inmediata o un admin las procesa.

---

## 2. UX unificada — `<GenerateFromContentDialog>`

Un componente reusable nuevo en `src/modules/ai/GenerateFromContentDialog.tsx`, embebible en los 5 callers. Reemplaza (o convive con, como pestaña) el panel actual "generar con IA" de cada flujo. Reusa design system: `Dialog` (`max-w-[calc(100vw-2rem)] sm:max-w-2xl`), `Select`, `Label required`, `DecimalInput` no aplica (cantidad es entero → `Input type=number`), `Spinner`, `HelpHint`, `EmptyState`, `useConfirm`.

### Props (contrato)

```ts
type GenerateFromContentDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  courseId: string | null;               // el flujo ya lo conoce (exam→course, etc.)
  targetTable: "questions" | "workshop_questions"
             | "project_files" | "question_bank" | "kahoot_questions";
  targetId: string;                       // examId | workshopId | projectId | courseId(banco) | pollId
  allowedTypes: QuestionType[];           // filtrado por flujo (ver §5)
  courseLanguage: "es" | "en";
  projectDescription?: string;            // solo proyectos, pasa como contexto
  onGenerated: (insertedCount: number) => void; // refetch del caller
};
```

### Layout del dialog (secciones)

1. **Fuente del material** (`Select` / RadioGroup):
   - `Todo el curso` → `materialScope:"course"`.
   - `Archivos específicos` → abre el multi-select (abajo).
   - `Una sesión` → `materialScope:"session"` + `Select` de sesiones — **solo se renderiza si el flujo tiene relación natural a sesión** (Kahoot y, opcionalmente, banco). Exam/taller/proyecto NO listan sesión (§gaps 5 del mapa).
   - `Solo temas (sin material)` → `materialScope:"none"` (comportamiento actual; permite degradar cuando no hay material).

2. **Selector de archivos del curso** (cuando fuente = "Archivos específicos"): lista `generated_contents` del curso (`status='done'`, `is('deleted_at', null)`), aplanando `files[]` y filtrando con `isReferenceableFile(f.name)` (excluye imágenes/zip/media). Multi-select con checkboxes agrupados por `display_name`. Cada ítem seleccionado → `fileRefs: [{ contentId, path, name }]`. Reusar el patrón visual del tutor (`referencedFiles`/chips `#`); no hace falta el autocomplete inline, un panel de checkboxes es más claro para multi-select masivo. Búsqueda simple por nombre.

3. **Foco de temas (opcional)** — un `Textarea` "Enfócate en… (opcional)" → `topics`. Con material, es refinamiento; sin material, es la fuente (modo actual).

4. **Parámetros**:
   - **Tipos** — checkboxes de `allowedTypes` (multi-tipo, cada tipo genera N como hoy: el caller expande a `aiTargetRows`).
   - **Cantidad por tipo** — `Input number` (1–20).
   - **Dificultad** — `Select`: `mixta` (default) | `básica` | `intermedia` | `avanzada` → `difficulty`. **Nuevo parámetro** que hoy no existe; se inyecta en el prompt.
   - **Idioma** — informativo (viene del curso), read-only badge.

5. **Footer**: botón "Generar" (o "Encolar" si async) + resumen "N preguntas de M tipos desde K archivos". Estados: `Spinner` mientras corre sync; toast de encolado en async; `ErrorState` inline si el edge devuelve `error` (ej. curso sin material).

### Wiring en los 5 callers

Cada caller solo abre el dialog con sus props y refetchea en `onGenerated`. Anclas (del mapa):
- `src/routes/app.teacher.exams.$examId.tsx:772-857` (además pasa `networkRows` por su camino cliente aparte — el dialog NO cubre red).
- `src/modules/workshops/WorkshopQuestions.tsx:524-589`.
- `src/modules/projects/ProjectFiles.tsx` (`generateQuestions ~614`, `generateFromDescription ~469`).
- `src/routes/app.teacher.question-bank.tsx:507-566`.
- `src/modules/polls/KahootQuestionsEditor.tsx:282-362`.

La lógica sync/async (`aiGate.ensureAuthorized({ allowQueue:true })` → `invoke` o `ai_generation_queue.insert`) se **extrae a un hook compartido** `useGenerateQuestions()` en `src/modules/ai/` para no re-duplicar el bloque en 5 sitios; hoy está copiado casi verbatim en cada caller.

---

## 3. Backend — extender `ai-generate-questions`

### 3.1 Generalizar el material más allá de Kahoot

Hoy `kahootFromMaterial = isKahoot && materialScope !== "none"` (`index.ts:1030`) y el bloque `<material>` solo se arma para Kahoot (`index.ts:1105-1160`). Cambios:

1. **Renombrar** `resolveKahootMaterial` → `resolveCourseMaterial` (`index.ts:340-416`) y `kahootUserPrompt`/`kahootMaterial` → nombres neutrales. Ya son genéricos (operan sobre `generated_contents` por `course_id`/sesión).
2. **Nuevo flag** `fromMaterial = materialScope !== "none"` (aplica a todo `targetTable`, no solo Kahoot). Ajustar el guard de `topics` requerido: `if ((!topics && !fromMaterial) || !type || !targetId)` (`index.ts:1031`).
3. **Resolver `courseId` para material en todos los modos.** El bloque de idioma (`index.ts:1059-1102`) ya resuelve el curso por cada `targetTable` (workshops→course, projects→course, poll→course, bank=course, exam→course). Reusar ese `courseId` resuelto para `resolveCourseMaterial` cuando `materialScope="course"` y no vino `materialCourseId`. Para `question_bank`, `targetId` ES el `course_id`.
4. **Soporte `fileRefs`** (archivos específicos, nuevo scope efectivo): cuando el body trae `fileRefs: [{contentId, path}]`, `resolveCourseMaterial` filtra `buildCourseMaterial(rows, allowedPaths)` con el set de `path`s pedidos (la maquinaria `allowedPaths` YA existe, `index.ts:273/285/407`). Se agrupa por `contentId` para la query `generated_contents.in('id', contentIds)`.

### 3.2 Inyección en el user prompt genérico

Hoy el `userPrompt` genérico (`index.ts:1162-1169`) solo mete `projectCtx + topics`. Agregar un bloque `<material>` análogo al de Kahoot (`index.ts:1154-1160`):

```
${material ? `Material del curso (fuente principal para las preguntas):\n<material>\n${material}\n</material>\n\n` : ""}${projectCtx}Genera ${count} preguntas de tipo "${type}" ${material ? "a partir del material anterior" : `sobre los siguientes temas: ${topics}`}${topics && material ? `, enfocándote en: ${topics}` : ""}.
Dificultad objetivo: ${difficultyLabel(difficulty)}.
...(instrucciones por tipo existentes)...
Idioma de salida obligatorio: ${langName}.
```

### 3.3 Prompts (`ai_prompts`) — placeholder de material

`resolveSystemPrompt(useCase, courseId, fallback)` (`index.ts:108-135`) resuelve global + override por curso. Hoy los use_cases genéricos (`workshop_full`, `exam_question`, `project_full`, `project_file`, `project_questions`) **no tienen placeholder de material** y Kahoot lo hardcodea condicional (`index.ts:1135-1139`).

**Decisión (recomendada): placeholder dedicado `{{course_content_material}}` con plegado**, exactamente como `tutor-prompt.ts`. En el edge:
- Si el system prompt resuelto **contiene** `{{course_content_material}}`, sustituir por el bloque de material (o cadena vacía si no hay).
- Si **no** lo contiene (fila sembrada vieja / override del docente que no lo conoce), inyectar la instrucción de "basar en material" al final del system prompt condicionalmente (como hoy hace Kahoot). Esto evita re-sembrar `ai_prompts` como precondición.

Sincronizar los 3 lados de la invariante de defaults: seed SQL (`supabase/migrations/…_ai_prompts_material_placeholder.sql`), `AdminPromptsPanel.tsx` (`USE_CASES[*].defaultPrompt`) y el `FALLBACK` del edge. Mantener texto byte-idéntico entre las 3 fuentes (misma disciplina que `tutor_chat`, ver CLAUDE.md invariantes).

### 3.4 Invariante de las 3 copias de `material-extract`

Los helpers **puros** (`notebookToReadableText`, `docxXmlToText`, `pptxSlideXmlToText`, `xlsxSharedStrings`, `xlsxSheetXmlToText`, `isOfficeDoc`, `isReferenceableFile`, `extensionOf`) ya están en las 3 copias (`src/modules/contents/`, `tutor-chat/`, `ai-generate-questions/`). **No** requieren cambio para este feature (ya soportan todo el material). El unzip (fflate) + descarga Storage + `extractPdfText` (unpdf) viven inline en el edge `ai-generate-questions` (`buildCourseMaterial`/`readMaterialFileText`, `index.ts:271-325`) — ya presentes. Solo hay que **usar `isReferenceableFile` en la UI** (front) para el picker; ya exportado.

---

## 4. Sync / async y failover

Sin cambios estructurales — reusa lo existente:
- **Sync**: `supabase.functions.invoke("ai-generate-questions", { body })` con los nuevos campos `materialScope`/`sessionId`/`courseId`/`fileRefs`/`difficulty`.
- **Async**: `ai_generation_queue.insert({ kind: <por flujo>, invoke_target:"ai-generate-questions", body:{…mismos campos…} })`. El body se guarda **verbatim** → el worker `ai-generation-worker` lo reenvía sin cambios. `kind` sigue el mapeo actual: `workshop_questions` / `exam_questions` (⚠ el kind del enum es `exam_questions`, el `targetTable` es `questions`) / `project_files` / `question_bank`(*) / `kahoot_questions`.
  - (*) Verificar que el CHECK de `ai_generation_queue.kind` admite `question_bank`; si no, agregar migración que extienda el CHECK (mismo patrón defensivo `to_regclass`). El banco hoy genera vía el mismo edge — confirmar su `kind` actual en `question-bank.tsx:522-566`.
- **Failover multi-key**: `aiChatCompletionFailover` ya envuelve la llamada; el material solo agranda el user message. Sin cambios.

---

## 5. Salida por flujo — mapeo de tipos

El tool `create_questions` (`index.ts:1204-1244`) produce `content` + `expected_rubric` + `options` (choices+correct_index solo para `cerrada`). El INSERT usa `type` tal cual. Tipos aplicables por flujo:

| Flujo (`targetTable`) | Tipos que aplican | Notas de inserción |
|---|---|---|
| **Exámenes** (`questions`) | cerrada, cerrada_multi, abierta, codigo, java_gui, python_gui, diagrama | `exam_id=targetId`, `position` incremental. **red_consola/red_gui NO** — van por camino cliente `networkRows` (`exams.$examId.tsx:748`), fuera del edge/dialog. |
| **Talleres** (`workshop_questions`) | cerrada, cerrada_multi, abierta, codigo, java_gui, python_gui, diagrama | `workshop_id=targetId`. |
| **Proyectos** (`project_files`) | codigo_zip, abierta, diagrama, cerrada | `project_id=targetId`, `title`=contenido; rúbrica → `expected_rubric`. Sin java_gui/python_gui (no aplican a entregables de proyecto). |
| **Banco** (`question_bank`) | todos los soportados por el tool (cerrada, cerrada_multi, abierta, codigo, java_gui, python_gui, diagrama) | `course_id=targetId`, `suggested_points`, `created_by`. |
| **Reto en vivo** (`kahoot_questions`) | solo Kahoot (2–4 opciones cortas, 1+ correctas) — tool `create_kahoot_questions` | inserta en `kahoot_questions` + `kahoot_question_options`. `allowedTypes` del dialog se ignora aquí (Kahoot es su propio formato). |

**Tipos que el dialog debe ocultar por flujo**: `codigo_zip` solo en proyectos; `java_gui`/`python_gui` fuera de proyectos y Kahoot; `red_*` nunca (no las genera el edge). El `allowedTypes` que pasa cada caller codifica esto.

**Idioma del starter code**: `codigo`/`codigo_zip` resuelven `language` (`index.ts:1046-1048`); `java_gui` recibe boilerplate (`index.ts:1421-1432`) — sin cambio.

---

## 6. Seguridad y límites

- **RLS**: el edge corre con `adminClient` (service_role, bypassa RLS) pero **la autorización fina la da el gate del front** + la RLS del INSERT que ya aplica cuando el docente inserta. Para leer material, `resolveCourseMaterial` filtra por `course_id`; **añadir validación server-side** de que el caller (cuando es user JWT, no worker) es docente del curso vía `course_teachers` antes de leer `generated_contents` — hoy el modo Kahoot confía en que el `courseId` viene del poll. Con `fileRefs` arbitrarios hay que verificar que los `contentId` pertenecen al `courseId` autorizado (evita que un docente lea material de otro curso pasando IDs ajenos). Reusar el patrón de `course_in_my_tenant` / `course_teachers`.
- **Tope de material** (ya existente, mantener): `MATERIAL_PER_DOC_CHARS` (6K/doc), `MATERIAL_TOTAL_CHARS` (22K), `MAX_STORAGE_EXTRACTIONS` (18 descargas/request). Con `fileRefs` el docente acota; con "todo el curso" el `limit(30)` + budgets protegen el prompt.
- **Costo IA (BYO vs administrada)**: sin cambio — el gate `ai-grading.ts getProcessingMode()` + failover multi-key ya gobiernan el gasto (sync consume del tenant; async se controla con `processing_mode`). El material agranda tokens de entrada → documentar en el dialog "leer material consume más créditos que generar por temas".
- **Dedup**: el modelo puede repetir preguntas entre invocaciones (cada tipo es una llamada). No hay dedup automático hoy; MVP no lo agrega. Mitigación futura: pasar los `content` ya existentes del target como "no repitas estas".
- **Validación de output**: el tool tiene JSON Schema estricto (`create_questions`/`create_kahoot_questions`); el edge ya valida `type` contra los CHECK y falla claro ante `targetTable` desconocido (`index.ts:1013`). Para `cerrada` validar `correct_index ∈ [0..3]`; para Kahoot `multi_select`/`correct_indices` (ya validado). Añadir guard: si el material vino vacío y `materialScope!=none`, devolver `error` accionable (ya existe en `resolveCourseMaterial`, `index.ts:356-363`).

---

## 7. Plan de implementación por fases

### Fase 0 — Backend generalizado (habilitador, sin UI nueva) · ~1.5 días
Desbloquea todo lo demás y ya hace útil a Kahoot.
- `supabase/functions/ai-generate-questions/index.ts`: renombrar `resolveKahootMaterial`→`resolveCourseMaterial`; `fromMaterial` para todo `targetTable`; ajustar guard `topics` (`:1031`); reusar `courseId` resuelto (`:1059-1102`) para material; soportar `fileRefs` + `difficulty`; bloque `<material>` en el `userPrompt` genérico (`:1162-1169`); placeholder `{{course_content_material}}` en `resolveSystemPrompt` con plegado.
- **Validación server-side** de docente-del-curso + `contentId ⊂ courseId`.
- Migración `ai_prompts` (placeholder en defaults) + posible extensión del CHECK de `ai_generation_queue.kind` para `question_bank`.
- **Salida**: probar por REST/`invoke` con `materialScope:"course"` en `questions` y `question_bank`.

### Fase 1 — MVP UI: 2 flujos + banco · ~2 días
- Componente `src/modules/ai/GenerateFromContentDialog.tsx` + hook `useGenerateQuestions.ts` (extraer lógica sync/async duplicada).
- Wire en **Exámenes** (`app.teacher.exams.$examId.tsx`) + **Banco** (`app.teacher.question-bank.tsx`) + **Kahoot** (`KahootQuestionsEditor.tsx` — el backend ya está, solo falta pasar los campos). Kahoot es "casi gratis" porque cierra Goal #18.
- **Salida**: el docente genera desde material en 3 flujos.

### Fase 2 — Resto de flujos · ~1 día
- Wire en **Talleres** (`WorkshopQuestions.tsx`) + **Proyectos** (`ProjectFiles.tsx`, incluyendo `generateFromDescription` que puede pre-cargar temas desde material).

### Fase 3 — Pulido · ~1 día
- Selector "sesión" en Kahoot/banco; dedup básico (pasar `content` existentes); i18n de todas las cadenas nuevas; tests puros del hook de mapeo de tipos + del armado de `fileRefs`.

**Esfuerzo total estimado**: ~5.5 días. **Archivos concretos a tocar**: 1 edge + 1 migración `ai_prompts` (+ posible CHECK), `AdminPromptsPanel.tsx`, 1 componente + 1 hook nuevos en `src/modules/ai/`, y los 5 callers (`app.teacher.exams.$examId.tsx`, `WorkshopQuestions.tsx`, `ProjectFiles.tsx`, `app.teacher.question-bank.tsx`, `KahootQuestionsEditor.tsx`).

---

## 8. Riesgos y casos borde

1. **Curso sin material** → `resolveCourseMaterial` ya devuelve `error` accionable (`index.ts:356-363, 408-414`); el dialog lo muestra y ofrece "generar por temas". No romper este fallback.
2. **Material muy grande** → budgets existentes truncan (22K total, 30 docs, 18 descargas). Riesgo: preguntas sesgadas al material que quedó dentro del corte. Mitigar priorizando `fileRefs` explícitos (van primero, como el tutor prioriza `referencedFiles`).
3. **Tipos de formato estricto**:
   - `red_gui`/`red_consola`: **fuera de alcance** (camino cliente `networkRows`, no el edge). El dialog no los ofrece; documentar que no se generan desde material.
   - `diagrama`: el modelo produce `content`+`expected_rubric` de texto, sin el objeto Excalidraw — igual que hoy. Aceptable (el docente/alumno dibuja); no regresa peor.
   - `codigo_zip`/`java_gui`/`python_gui`: rúbrica desde material puede quedar genérica; validar que el enunciado mencione lenguaje/alcance (ya lo hace `index.ts:1166-1167`).
4. **`fileRefs` con IDs ajenos** → leak cross-curso si no se valida `contentId ⊂ courseId` (cubierto en §6, Fase 0).
5. **Divergencia de las 3 copias de `material-extract`** → no cambian en este feature, pero si se toca un helper puro, sincronizar las 3 (invariante CLAUDE.md).
6. **`ai_prompts` override del docente sin el placeholder** → el plegado condicional (§3.3) evita que el material se pierda; sin él, un override viejo generaría sin material silenciosamente.
7. **Async**: el body verbatim en `ai_generation_queue` debe incluir `materialScope`/`fileRefs`; si se olvida en el `.insert()` de un caller, ese flujo generaría por temas al drenar la cola — cubrir con el hook compartido `useGenerateQuestions` (un solo lugar arma el body).
8. **Kind `question_bank` en la cola** → verificar el CHECK antes de asumir que encola; si falta, migración defensiva.

# Plan: Kotlin como lenguaje EJECUTABLE en todos los flujos

> Estado: propuesta. Nada implementado todavía.
> Motivación de negocio: el curso **Desarrollo de Aplicaciones Móviles 1** (Kotlin, tenant FESNA)
> hoy manda a los alumnos a Kotlin Playground porque ExamLab no ejecuta Kotlin. Con esto, los
> ejercicios de lógica Kotlin pasan a correr dentro de la plataforma y dejan de depender de una
> herramienta externa.

---

## 1. Estado actual (verificado en código, no de memoria)

Kotlin **ya existe** en la plataforma, pero solo como **entregable**, nunca como código que se ejecuta:

| Capa | Estado | Evidencia |
|---|---|---|
| Subida de archivos `.kt`/`.kts` (`codigo_zip`) | ✅ soportado | `src/shared/lib/code-upload.ts:28,46` — `kotlin: ["kt","kts"]` + label "Kotlin (.kt, .kts)" |
| Select de lenguaje del entregable ZIP | ✅ ofrece Kotlin | `src/modules/workshops/WorkshopQuestions.tsx:1009` |
| Calificación IA de esos archivos | ✅ por rúbrica | el grader lee el texto; no compila |
| **Ejecución** (`execute-code`) | ❌ **no existe** | `kotlin` no está en `ONLINECOMPILER_MAP` (`supabase/functions/execute-code/index.ts:155`) ni en `JDOODLE_MAP` (`:301`) |
| **Tipo del editor ejecutable** | ❌ 3 lenguajes | `src/modules/code/CodeEditor.tsx:17` → `type CodeLanguage = "java" \| "python" \| "javascript"` |
| Runner AWS Lambda | ❌ 2 lenguajes | `execute-code/index.ts:394` → `AWS_LAMBDA_LANGUAGES = new Set(["java","python"])` |

### El desajuste que hay que entender antes de tocar nada

Hay **tres listas de lenguajes distintas** y ninguna es la fuente de verdad de las otras:

1. **13 lenguajes** que el edge sabe ejecutar (`java, python, javascript, typescript, c, cpp, csharp, fsharp, go, rust, php, ruby, haskell`).
2. **3 lenguajes** que el editor ejecutable acepta (`CodeLanguage`).
3. **12 lenguajes** de entrega por ZIP (`code-upload.ts`), que **sí** incluye Kotlin.

Y las opciones que ve el usuario están **hardcodeadas inline en 6 pantallas**, sin constante compartida:

| Archivo | Lenguajes que ofrece hoy |
|---|---|
| `src/modules/code/CodeEditor.tsx:191` | java, python, javascript |
| `src/modules/sessions/SessionCodeSnippets.tsx:689` | java, python, javascript |
| `src/modules/whiteboard/CodePageEditor.tsx:308` | java, python, javascript |
| `src/routes/app.teacher.exams.$examId.tsx:1689,1837` | java, python, javascript |
| `src/routes/app.teacher.question-bank.tsx:1154` | 7 lenguajes (java, python, javascript, typescript, c, cpp, csharp) |
| `src/modules/workshops/WorkshopQuestions.tsx:955,999,1153` | 3 en el select ejecutable / 12 en el de ZIP |

**Consecuencia para el plan:** "agregar Kotlin en todos los flujos" NO es agregar un `<SelectItem>` seis veces.
Es (a) unificar la lista y (b) extender el tipo. Si se hace al revés —agregar la opción sin extender
`CodeLanguage`— el usuario elige Kotlin y el runner lo rechaza en silencio, que es exactamente la clase
de fallo mudo que ya costó caro en este repo.

### Buenas noticias que reducen el alcance

- **No hace falta migración de DB.** El `language` de las preguntas es texto libre: no existe ningún
  `CHECK` sobre él (el único `*_language_check` del repo es `courses.language IN ('es','en')`,
  `supabase/migrations/20260423000000_phase3_i18n_cuts_rbac.sql:22`). Guardar `'kotlin'` no rompe nada.
- **La JVM ya está en el Lambda.** El Dockerfile instala `java-21-amazon-corretto`
  (`aws/code-runner/Dockerfile:69`), así que sumar Kotlin ahí es agregar `kotlinc`, no un runtime nuevo.
- **`CodeLanguage` es la palanca.** `LANGUAGE_CONFIG` (`CodeEditor.tsx:104`) está tipado
  `Record<CodeLanguage, {label, monacoLang, defaultCode}>`. Al agregar `"kotlin"` al union, **TypeScript
  enumera solo** cada lugar que necesita el caso nuevo. El compilador hace de checklist.

---

## 2. Decisiones de diseño (a resolver antes de codear)

| # | Decisión | Recomendación | Por qué |
|---|---|---|---|
| D1 | ¿Qué proveedor ejecuta Kotlin? | **JDoodle** como camino garantizado; OnlineCompiler.io **a verificar** | OnlineCompiler.io es el default del sistema (`execute-code:623`) pero su catálogo no está documentado en el repo. JDoodle sí expone `kotlin`. Si el default no lo soporta, hay que **rutear por lenguaje**, no por proveedor global. |
| D2 | ¿`.kt` o `.kts`? | Ambos entran como `kotlin`; el starter usa `fun main()` | El alumno no debe elegir dialecto. Un `.kts` sin `fun main` también corre en la mayoría de proveedores; el starter con `fun main` es el caso enseñable. |
| D3 | ¿Kotlin en el Lambda? | **No en la fase 1** | `kotlinc` arranca una JVM para compilar (~2-4s) *antes* de ejecutar. Sobre un cold start de Lambda se acerca peligrosamente al timeout. Se suma después, medido. |
| D4 | ¿CheerpJ? | **Excluido** | CheerpJ ejecuta bytecode JVM en el navegador, pero no existe `kotlinc` en el navegador: no hay con qué compilar. `providersForLanguage` debe seguir devolviendo cheerp **solo** para java (`CodeRunnerPicker.tsx:52`). |
| D5 | ¿`kotlin_gui` (Compose)? | **Fuera de alcance** | Los runners GUI (`java_gui`, `python_gui`) capturan screenshot de Swing/tkinter con Xvfb. Compose Multiplatform Web es WASM: otro pipeline entero. Se evalúa aparte. |
| D6 | ¿Kotlin en las 6 pantallas o solo donde tenga sentido? | En las 6, vía constante compartida | Un lenguaje que aparece en el taller pero no en el banco de preguntas es una inconsistencia que el agente `consistencia` va a marcar, y con razón. |

---

## 3. Fases

### Fase 0 — Verificar soporte del proveedor (bloqueante, barata)

Sin esto, todo lo demás puede quedar en una opción que no ejecuta.

1. Probar el edge contra JDoodle con `language: "kotlin"` y un `Hello World`, y contra
   OnlineCompiler.io con los ids candidatos (`kotlin-2.x`, `kotlin`). Las claves son secretos del
   servidor (`JDOODLE_CLIENT_ID/SECRET`, `ONLINE_COMPILER_API_KEY`), así que la prueba se hace
   **invocando el edge**, no llamando a la API desde local.
2. Registrar el resultado acá mismo, en esta tabla:

   | Proveedor | ¿Kotlin? | Id/compiler | Verificado |
   |---|---|---|---|
   | JDoodle | ? | `kotlin` (versionIndex a confirmar) | pendiente |
   | OnlineCompiler.io | ? | ? | pendiente |

3. **Si el default (OnlineCompiler.io) NO soporta Kotlin**, hay que agregar ruteo por lenguaje: hoy
   `effectiveProvider` se decide global (`execute-code:630`). Haría falta un fallback "si el proveedor
   activo no mapea el lenguaje, usar el que sí" — con el error explícito si ninguno lo soporta.
   **Nunca** dejarlo caer en un 500 opaco.

### Fase 1 — Kotlin ejecutable, camino mínimo end-to-end

Objetivo: un docente crea una pregunta `codigo` en Kotlin, el alumno escribe y le da Ejecutar, y sale el stdout.

1. `supabase/functions/execute-code/index.ts`
   - `ONLINECOMPILER_MAP` (`:155`) y/o `JDOODLE_MAP` (`:301`): entrada `kotlin`.
   - `AWS_LAMBDA_LANGUAGES` (`:394`): **no tocar** (D3).
   - Verificar el efecto en `allLanguages` (`:589`), que hoy se deriva de la unión de los dos mapas.
2. `src/modules/code/CodeEditor.tsx`
   - `CodeLanguage` (`:17`): agregar `"kotlin"`.
   - `KOTLIN_STARTER` nuevo, junto a `JAVA_STARTER`/`PYTHON_STARTER`, con `fun main()`.
   - `LANGUAGE_CONFIG` (`:104`): entrada kotlin → `{ label: "Kotlin", monacoLang: "kotlin", defaultCode: KOTLIN_STARTER }`.
   - Verificar que Monaco resuelve la gramática `kotlin` (se carga vía `@monaco-editor/react`, que trae
     las basic-languages; si no aparece resaltado, hay que registrarla explícitamente).
3. `src/modules/code/CodeRunnerPicker.tsx`
   - `providersForLanguage` (`:51`): kotlin → los proveedores que la Fase 0 confirme. **Sin cheerp.**
4. Tests
   - `src/modules/code/code-language.test.ts` ya cubre `getStarterCode`: agregar el caso kotlin.
   - Test nuevo: `providersForLanguage("kotlin")` no incluye `cheerp` (invariante de D4).

Al extender el tipo, `tsc` va a señalar cada exhaustividad que falte. **Esa lista de errores es el
alcance real de la fase** — recorrerla completa antes de dar la fase por cerrada.

### Fase 2 — Unificar las listas de lenguajes (el "todos los flujos")

Esta es la fase que evita que Kotlin quede a medias y que el próximo lenguaje repita el trabajo.

1. Crear `src/modules/code/languages.ts` con la lista canónica de lenguajes **ejecutables**:
   `[{ value, label, monacoLang }]`, derivada de `CodeLanguage` (con check de exhaustividad, como
   `ALL_MODULE_KEYS` en `src/shared/lib/module-catalog.ts`).
2. Reemplazar los `<SelectItem>` inline por un `<CodeLanguageSelect>` en las 6 pantallas de la tabla
   de arriba. Ojo: `question-bank` ofrece 7 lenguajes hoy y `WorkshopQuestions` mezcla el select
   ejecutable con el de ZIP — **son dos conceptos distintos y deben seguir separados** (ejecutable vs
   entregable). Unificar el ejecutable, dejar `code-upload.ts` como la fuente del entregable.
3. Test guardrail (mismo espíritu que `module-catalog.test.ts`): si un lenguaje está en `CodeLanguage`
   pero no en la lista canónica —o al revés— el test falla.

**Decisión pendiente para el dueño del producto:** hoy `question-bank` ofrece 7 lenguajes que el editor
ejecutable no soporta (`typescript, c, cpp, csharp`). Unificar hacia arriba (que el editor soporte los
13 del edge) o hacia abajo (que el banco ofrezca solo los ejecutables) es una decisión de producto, no
técnica. Kotlin no depende de resolverla, pero la inconsistencia queda a la vista.

### Fase 3 — Archivos `.kt` subidos, ejecutables

Hoy un `.kt` en Contenidos se ve pero no se ejecuta.

1. `codeLanguageForFile` (`src/modules/code/CodeFileRunnerDialog.tsx:35`): `.kt`/`.kts` → `"kotlin"`.
   Devuelve `CodeLanguage | null`, así que la Fase 1 (extender el tipo) es prerrequisito.
   OJO: `src/modules/contents/media-files.ts` **no** interviene acá — solo detecta imagen/PDF y
   menciona `codeLanguageForFile` en un comentario como análogo. No hay que tocarlo.
2. `src/routes/app.student.courses.tsx`: la rama del render por sesión que decide mostrar "Ejecutar"
   usa `codeLanguageForFile(name)` + `!!f.body`. Con (1) hecho, los `.kt` entran solos — **verificar**,
   no asumir.
3. `UploadExternalContentDialog`: agregar `.kt`/`.kts` a `ACCEPTED_EXTENSIONS` y a
   `INLINE_BODY_EXTENSIONS` (se guarda el texto inline, como `.java`/`.py`), para que el runner lea de
   `body` sin bajar del Storage.

### Fase 4 — Kotlin multi-archivo

`combineFilesForExec` (`src/modules/code/combine-files.ts:31`) tiene lógica **específica de Java**:
detecta la clase con `main`, la pone primera, degrada las `public` y quita los `package`.

Kotlin es distinto y más simple: no hay acoplamiento nombre-de-archivo ↔ clase, y admite varias
declaraciones top-level por archivo. Pero:
- hay que **quitar los `package`** igual (el proveedor compila un archivo suelto);
- hay que evitar **dos `fun main`** (mantener el del archivo que lo tenga, primero).

**Invariante cross-file crítica:** esta función está **replicada** en el edge
(`supabase/functions/execute-code/index.ts` → `combineFiles`), porque el cliente combina y manda
*ambos* `files` y `sourceCode` para tolerar un deploy viejo del edge. Si divergen, el alumno ve una
salida distinta según el deploy. **Los dos lados se cambian juntos**, y va anotado en la tabla de
invariantes de `CLAUDE.md`.

### Fase 5 — Calificación IA consciente de Kotlin

`itemDirectiveForType` (`supabase/functions/ai-grade-submission/index.ts:242`) inyecta una directiva
por tipo de pregunta. Hoy no hay nada específico de Kotlin.

- Agregar directiva para código Kotlin: idiomatismos que SÍ hay que premiar (`val` sobre `var`,
  null-safety con `?.`/`?:` en vez de `!!`, `data class`, funciones de colección `map`/`filter`), y el
  antipatrón típico del alumno que viene de Java (escribir Java con sintaxis Kotlin).
- Si la pregunta trae salida de ejecución, pasarla por `executionOutput` como ya se hace con
  `so_consola` — el grader la renderiza como sección aparte del prompt.

### Fase 6 — (Opcional, medido) Kotlin en AWS Lambda

Solo si hace falta un runner propio (independencia de proveedores externos, o el aula sin internet).

1. `aws/code-runner/Dockerfile`: bajar `kotlin-compiler` y dejar `kotlinc` en la imagen. La JVM ya está
   (`:69`).
2. `aws/code-runner/app.py`: rama `language == "kotlin"` → `kotlinc file.kt -include-runtime -d out.jar`
   y después `java -jar out.jar`.
3. `execute-code/index.ts:394`: sumar `kotlin` a `AWS_LAMBDA_LANGUAGES`.
4. **Medir antes de habilitarlo por default.** Presupuesto: cold start + `kotlinc` + ejecución. Si pasa
   de ~10s, queda como override manual per-pregunta (`CodeRunnerPicker`), no como default.

### Fase 7 — Cierre

1. `CLAUDE.md`: sumar Kotlin donde se enumeran los lenguajes ejecutables, y la invariante cross-file de
   `combine-files` si la Fase 4 entra.
2. Correr el agente `consistencia` (obligatorio por `CLAUDE.md`): iconos, i18n es↔en de las etiquetas
   nuevas, y que no queden pantallas con listas divergentes.
3. `bun tsc --noEmit` en 0 + suite completa + los tests nuevos de las fases 1, 2 y 4.
4. Actualizar `docs/demos/.../examlab - Compatibilidad y validacion2.md`: los ejercicios de lógica
   Kotlin de S1–S8 pasan de **Tier 2 (Kotlin Playground)** a **Tier 1 (examlab)**. S9 (Compose Web)
   sigue en Tier 2 — eso no lo cambia este plan (D5).

---

## 4. Riesgos

| Riesgo | Mitigación |
|---|---|
| El proveedor default no soporta Kotlin y el alumno elige Kotlin en un examen | Fase 0 es bloqueante. Si no hay soporte en el default, ruteo por lenguaje **antes** de exponer la opción. Y el error debe ser explícito ("este lenguaje no está disponible"), nunca un 500 opaco. |
| Latencia de compilación en examen cronometrado | Kotlin compila más lento que Python/JS. Medir en Fase 0 y documentar el tiempo esperado. El botón Cancelar ya existe (`CodeEditor` acepta `onCancel`). |
| Se agrega la opción sin extender `CodeLanguage` | Es el fallo mudo clásico. El orden de las fases lo previene: el tipo primero, la UI después. |
| `combine-files` divergiendo entre cliente y edge | Cambiar los dos lados en el mismo commit + anotarlo en la tabla de invariantes de `CLAUDE.md`. |
| Kotlin ejecutable confundido con Kotlin entregable (ZIP) | Son dos listas con dos propósitos. La Fase 2 unifica **solo** la ejecutable y deja `code-upload.ts` intacto. |

## 5. Qué NO hace este plan

- No toca `codigo_zip`: Kotlin ya se entrega y se califica ahí.
- No agrega `kotlin_gui` ni Compose Web (D5).
- No migra la DB: `language` es texto libre.
- No resuelve la inconsistencia de los 7 lenguajes del banco de preguntas — la expone y la deja como
  decisión de producto.

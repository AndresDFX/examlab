# Propuesta — Preguntas de tipo BD relacional (SQL) con herramientas gratuitas

> Estado: **propuesta para validación**. No implementado. Generado 2026-07-24.
> Objetivo: un tipo de pregunta donde el alumno escribe **SQL** contra una base sembrada por el docente, ejecutable y calificable, **100% con herramientas gratuitas**, integrable en **talleres, exámenes, proyectos y banco de preguntas** (todos los flujos).

## 1. Contexto: cómo funcionan las preguntas de código hoy

- Tipos existentes (CHECK de `type` en `questions`, `workshop_questions`, `project_files`, `question_bank`): `abierta`, `opcion_multiple`, `codigo`, `java_gui`, `python_gui`, `so_consola`, `diagrama`, `codigo_zip`.
- **Ejecución**: dos caminos — server-side ([supabase/functions/execute-code](../../supabase/functions/execute-code/index.ts): OnlineCompiler/JDoodle/AWS Lambda) y **client-side WASM** (CheerpJ para Java en [run-java.ts](../../src/modules/code/run-java.ts), notebooks Python en [NotebookRunnerDialog]). Ya hay **precedente de motores WASM en el navegador** → el patrón encaja.
- **Runner por pregunta**: [CodeRunnerPicker](../../src/modules/code/CodeRunnerPicker.tsx) selecciona proveedor; cada `CodeEditor` tiene Run.
- **Calificación**: [ai-grade-submission](../../supabase/functions/ai-grade-submission/index.ts) con directivas por tipo; `so_consola` ya manda `executionOutput` (salida de consola) al prompt — precedente directo para mandar el **result set** de una query.

## 2. Motor recomendado: `sql.js` (SQLite WASM) — con PGlite como alternativa

| Criterio | **sql.js (SQLite WASM)** ✅ recomendado | PGlite (Postgres WASM) |
|---|---|---|
| Licencia | MIT (sql.js) + SQLite dominio público | Apache-2.0 |
| Costo | **Gratis**, sin SaaS, sin API keys | Gratis |
| Tamaño bundle | ~1.2 MB WASM (comparable a CheerpJ, self-hosteable inline) | ~3 MB (Postgres completo) |
| CSP estricta | ✅ WASM local, sin fetch externo (igual que CheerpJ) | ✅ WASM local |
| Dialecto | SQLite (SELECT/JOIN/GROUP/subqueries/CTE) — **suficiente para enseñar BD relacional** | Postgres real (window fns, tipos ricos) |
| Estado | Efímero en memoria por ejecución (se re-siembra) — ideal para exámenes | Persistente opcional |
| Arranque | Instantáneo | Más pesado |

**Recomendación**: `sql.js` por peso y por ser el estándar de enseñanza de SQL. Se **empaqueta el `.wasm` como asset local** (mismo enfoque self-hosted que se hizo con los assets de v86 y CheerpJ; nada de CDN externo → cumple la CSP). Dejar `engine` como campo por-pregunta para poder ofrecer PGlite en cursos que enseñen Postgres específicamente.

> ⚠️ **CSP**: ambos motores cargan el `.wasm` con `WebAssembly.instantiate`. Requiere que el asset se sirva **same-origin** (o inline como base64/`data:`), NUNCA desde CDN. Verificar `Content-Security-Policy` (`wasm-unsafe-eval` / `script-src`). Es el mismo trabajo ya resuelto para CheerpJ.

## 3. Nuevo tipo de pregunta: `bd_relacional`

### 3.1 Definición del docente
La pregunta guarda (reutilizando columnas existentes de `questions` + análogas):

- `content`: enunciado ("Escribe una consulta que devuelva…").
- `starter_code`: SQL inicial opcional para el alumno.
- **`schema_seed`** (nuevo, o dentro de `test_cases` JSONB para no migrar tanto): DDL + `INSERT`s que arman la base (`CREATE TABLE ...; INSERT ...;`).
- **`expected_sql`** (solución de referencia del docente) y/o **`expected_result`** (result set esperado, calculado ejecutando `expected_sql` sobre el seed al guardar).
- `engine` ∈ `{sqlite, postgres}` (default sqlite).
- Flags de comparación: `ordered` (si el ORDER importa), `ignore_column_names`.

> Para **minimizar migración**: `schema_seed`, `expected_sql`, `engine`, `ordered` pueden vivir dentro del JSONB `test_cases` que ya existe en `questions`. Solo hace falta agregar el valor `'bd_relacional'` al CHECK de `type` en las 4 tablas.

### 3.2 Runner client-side (alumno)
[src/modules/code/SqlRunner.tsx] (nuevo, paralelo a JavaGuiRunner):
1. Al abrir: instancia `sql.js`, ejecuta `schema_seed` en una DB en memoria.
2. Editor SQL (Monaco con lenguaje `sql`) + botón **Ejecutar**.
3. Ejecuta la query del alumno → **muestra el result set en una grilla** (columnas + filas) o el error de SQL.
4. La DB es **efímera**: cada Run re-siembra desde `schema_seed` (no hay estado que afecte "un servidor real" — es 100% en el navegador, igual que se pidió para la consola v86).

### 3.3 Persistencia de la respuesta
La respuesta del alumno = el **texto SQL** (igual que `codigo`), guardado en el mismo campo `answers`/`workshop`/`project` que las demás preguntas de código. Opcionalmente se cachea el `result_set` obtenido (para revisión sin re-ejecutar, como `so_consola` cachea el transcript).

## 4. Calificación (determinista + IA de respaldo)

**Determinista (gratis, sin IA)** — el camino principal:
1. Server (o client en preview) ejecuta `expected_sql` sobre `schema_seed` → `expected_result`.
2. Ejecuta el SQL del alumno sobre el mismo seed → `student_result`.
3. Compara los result sets:
   - **Filas**: comparar como multiconjunto salvo que `ordered=true`.
   - **Columnas**: por posición y valor; `ignore_column_names` para no exigir alias exactos.
   - **NULLs/tipos**: normalizar (`NULL` == `NULL`; number vs string del mismo valor).
   - **Múltiples soluciones válidas**: como se compara el RESULT (no el texto SQL), cualquier query que produzca el mismo set acierta ✅.
4. `is_correct = sets_iguales` → puntaje directo (100% / 0%, o parcial por % de filas correctas si se quiere).

**IA de respaldo** (`ai-grade-submission`, cuando el docente lo pida o para feedback cualitativo): manda `content + expected_sql + student_sql + student_result + expected_result` (reusa el patrón `executionOutput` de `so_consola`) → la IA explica el error / da feedback, sin ser la fuente de verdad de la nota.

> **¿Dónde se ejecuta la comparación?** Para exámenes con integridad, ejecutar el seed + query del alumno **server-side** en un edge con sql.js (Deno soporta WASM) evita que el cliente falsee el result. Para talleres/práctica, client-side alcanza. Config `grade_side ∈ {client, server}` (default server para exámenes).

## 5. Integración en TODOS los flujos

| Flujo | Enganche |
|---|---|
| **Exámenes** | [app.student.take.$examId](../../src/routes/app.student.take.$examId.tsx): render `bd_relacional` → `SqlRunner`. Edición docente: editor de pregunta con campos schema_seed/expected_sql. |
| **Talleres** | [WorkshopQuestions.tsx](../../src/modules/workshops/WorkshopQuestions.tsx): mismo render + submit (push a batch de calificación, como `so_consola`). |
| **Proyectos** | `project_files` acepta `type='bd_relacional'` como un slot de pregunta. |
| **Banco de preguntas** | [app.teacher.question-bank](../../src/routes/app.teacher.question-bank.tsx): crear/editar/duplicar preguntas SQL; reutilizables en los otros flujos. |
| **Generación IA** | `ai-generate-questions`: prompt para generar enunciado + schema_seed + expected_sql. (Fase 2 — opcional.) |
| **Revisión** (docente/alumno) | Mostrar SQL del alumno + su result set + el esperado (diff visual de filas). |

## 6. Migraciones (defensivas, estilo repo)

```sql
-- Agregar 'bd_relacional' al CHECK de type en las 4 tablas (guard por tabla)
DO $$ BEGIN
  IF to_regclass('public.questions') IS NOT NULL THEN
    ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_type_check;
    ALTER TABLE public.questions ADD CONSTRAINT questions_type_check
      CHECK (type IN ('abierta','opcion_multiple','codigo','java_gui','python_gui',
                      'so_consola','diagrama','bd_relacional'));
  END IF;
END $$;
-- Repetir el patrón para workshop_questions, project_files, question_bank
-- (question_bank puede NO existir en algún entorno → el guard to_regclass es obligatorio)
NOTIFY pgrst, 'reload schema';
```

- **Sin columnas nuevas** si `schema_seed`/`expected_sql`/`engine` van dentro del JSONB `test_cases` existente → migración mínima y reversible.

## 7. Riesgos / decisiones a validar

1. **CSP + peso del bundle**: confirmar que `sql.js` (~1.2 MB) se puede servir same-origin/inline sin romper la CSP (mismo trabajo que CheerpJ/v86). — *riesgo bajo, ya hay precedente.*
2. **Ejecución server-side para integridad de exámenes**: montar sql.js en un edge Deno (soporta WASM) para no confiar en el result del cliente. — *decisión: default server en exámenes, client en talleres.*
3. **Comparación de result sets**: definir política de orden (multiconjunto por default; `ORDER BY` exigido solo si la pregunta lo pide) y de NULL/tipos. — *cubierto arriba; validar con casos reales.*
4. **SQLite vs Postgres**: SQLite cubre BD relacional de enseñanza; si un curso enseña features Postgres (window functions avanzadas, tipos), ofrecer PGlite por-pregunta. — *decisión del docente por pregunta.*
5. **Inyección / seguridad**: la DB es efímera en memoria del navegador (o edge aislado) → no toca ninguna base real. Sin riesgo de "afectar un servidor" (requisito explícito equivalente al de la consola v86). — *riesgo nulo por diseño.*

## 8. Fases

1. **Motor + runner**: empaquetar `sql.js` local, `SqlRunner.tsx`, ejecutar seed + query → grilla. (Client-side, práctica.)
2. **Tipo + persistencia**: CHECK `bd_relacional` en las 4 tablas, edición docente (schema_seed/expected_sql), submit del alumno.
3. **Calificación determinista**: comparación de result sets (client para talleres; edge Deno+sql.js para exámenes) + tests puros del comparador.
4. **Todos los flujos**: exámenes, talleres, proyectos, banco + revisión con diff visual.
5. **IA de respaldo + generación** (opcional): feedback cualitativo + generar preguntas SQL desde material.

## 9. Veredicto

**Viable con herramientas 100% gratuitas.** `sql.js` (MIT + SQLite dominio público) client-side cubre práctica; un edge Deno con el mismo WASM cubre la integridad de exámenes. La calificación es **determinista por result set** (acepta cualquier SQL correcto), con IA solo como feedback. La migración es mínima (un valor de enum + JSONB existente). El mayor trabajo real es el `SqlRunner` + el comparador de result sets + servir el WASM bajo la CSP (precedente ya resuelto con CheerpJ/v86).

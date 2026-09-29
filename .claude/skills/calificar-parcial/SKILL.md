---
name: calificar-parcial
description: >
  Califica a mano —leyendo cada respuesta contra su rúbrica— un examen de ExamLab cuando la
  calificación automática no corrió, y persiste el resultado con el mismo formato que escribe
  la plataforma, para que el docente y el estudiante lo vean en las pantallas de siempre.
  Usa el prompt interno de la institución (`ai_prompts`, caso de uso `exam_question`) para que
  el criterio sea el mismo que el del grader. Úsalo cuando el usuario pida «califica el
  parcial», «calificá el último examen», «las notas no salieron, califica vos» o
  «usando los prompts internos califica X».
---

# Calificar un parcial a mano, con el criterio de la plataforma

El docente llega a esta tarea porque la cola de IA no drenó o el proveedor está caído, y el
curso lleva días sin nota. El resultado NO es un informe: son las filas de `submissions` con
nota y desglose, tal como las habría escrito `ai-grade-submission`. Si el trabajo termina en un
mensaje de chat, el estudiante sigue viendo «calificación en cola».

## 1. Leer el criterio antes de leer las respuestas

El prompt que gobierna la calificación de exámenes está en la base, no en el código. Traerlo y
LEERLO completo antes de puntuar nada:

```bash
node scripts/db-query.mjs "ai_prompts?use_case=eq.exam_question&select=system_prompt,course_id,tenant_id"
```

Gana el más específico: fila del curso → global de la institución **del curso** → platform
default (`tenant_id` y `course_id` en null). Con `service_role` la RLS está bypaseada y vienen
las filas de TODAS las instituciones: hay que filtrar por el tenant del curso a mano, o se
aplica el criterio de otra universidad. Si ese prompt dice algo que cambia la puntuación —por
ejemplo que las preguntas teóricas no llevan penalización por sospecha de IA, o que la
retroalimentación va en un solo párrafo integrado— eso manda sobre cualquier costumbre.

Dos reglas más que el edge agrega SIEMPRE y no son editables:

- **La retroalimentación se muestra como TEXTO PLANO.** Nada de `**`, viñetas Markdown,
  almohadillas ni acento grave: salen a la vista del estudiante tal cual.
- Una `cerrada` / `cerrada_multi` / `red_consola` / `red_gui` **no la califica nadie leyendo**:
  la puntúa `scoreDeterministic`. Ver el paso 4.

## 2. Bajar el examen entero a un scratchpad

Todo en archivos, no en la cabeza: se califica pregunta por pregunta y las tandas se pierden.

```bash
node scripts/db-query.mjs "exams?id=eq.<EXAM_ID>&select=id,title,status,course_id,courses(name,grade_scale_max,passing_grade)"
node scripts/db-query.mjs "questions?exam_id=eq.<EXAM_ID>&select=id,position,type,points,content,expected_rubric,options&order=position"   # → q.json
node scripts/db-query.mjs "submissions?exam_id=eq.<EXAM_ID>&select=id,user_id,status,submitted_at,ai_grade,answers"                        # → subs.json
node scripts/db-query.mjs "profiles?id=in.(<user_ids>)&select=id,full_name"                                                                 # → profiles.json
```

`submissions.user_id` apunta a `auth.users`, **no** a `profiles`: el embed
`profiles:user_id(full_name)` devuelve `PGRST200` y deja los nombres vacíos. Siempre dos
consultas.

**Antes de calificar, mirar `ai_grade` de las 17 filas.** Si alguna ya tiene nota, esto deja de
ser aditivo: preguntar qué hacer con esas antes de escribir nada.

## 3. Calificar de a UNA pregunta, con todo el curso a la vista

Volcar las respuestas de **todos** los estudiantes a la MISMA pregunta, juntas, y recién ahí
puntuar. Es lo que hace que la nota sea comparable: el que escribió «por integridad de los
datos» saca lo mismo en la fila 3 que en la 15. Calificar estudiante por estudiante produce
deriva y no se nota hasta el reclamo.

Para cada pregunta: imprimir su enunciado y su `expected_rubric`, después las N respuestas, y
guardar el resultado en `q<posición>.json` con la forma `{ "<8 chars del submission_id>":
[puntos, "retroalimentación"] }`. Verificar que el archivo tenga exactamente N entradas antes
de pasar a la siguiente.

Al puntuar:

- **La rúbrica manda**, incluidas sus bandas parciales. Si un caso real cae entre dos bandas,
  elegir la que la rúbrica describe y decir en la retroalimentación qué faltó para la de
  arriba.
- **Una `bd_sql` sin resultado guardado no es un cero.** El motor arranca una base LIMPIA por
  corrida y persiste la salida de la ÚLTIMA ejecución: si el estudiante corrió una selección,
  las sentencias de más arriba corrieron en silencio y solo queda la última. Una respuesta con
  las cuatro sentencias correctas y una sola fila de resultado que muestra el estado final
  correcto **está bien**. Leer el SQL, no solo el resultado.
- **Un error de Postgres tampoco es un cero automático.** Un punto y coma faltante o una comilla
  doble donde va simple es un defecto real, pero distinto de no haber escrito nada.
- **Respuesta que contesta OTRA pregunta**: cero, y decirlo sin rodeos («lo que respondiste
  corresponde a otra pregunta»), porque el estudiante necesita saber que no fue el criterio.
- **La plantilla que puso el docente no es autoría del estudiante.** Si el enunciado entrega el
  esqueleto (`CREATE PROCEDURE … BEGIN … END`), un código «perfecto» es evidencia de haber usado
  ese esqueleto, no de IA. Ahí **no se aplica penalización por sospecha**, y esa decisión se
  dice explícitamente en el informe final.

## 4. Las deterministas NO se califican leyendo

`cerrada`, `cerrada_multi`, `red_consola` y `red_gui` las puntúa
`supabase/functions/_shared/deterministic-scoring.ts`, y hay que **reusar ese módulo**, no
reimplementarlo: cuando el cálculo del lado que escribe difiere del que ya existía, la misma
entrega vale distinto según quién apretó el botón. Ya pasó dos veces en este repo.

Se reusa corriéndolo con **vitest** desde un archivo `src/_algo.test.ts` temporal, que resuelve
TypeScript y los alias. Trampas conocidas: `cerrada` guarda el índice como TEXTO (`"2"`) y
`cerrada_multi` guarda su selección en `answer_text` como JSON, no en `selected_option`.

## 5. Escribir con el formato de la plataforma

El destino es `submissions`, con el mismo payload que arma el edge:

```js
{
  ai_grade: Number(((earned / totalPoints) * grade_scale_max).toFixed(2)),
  ai_detected: false, ai_detected_score: 0, ai_detected_reasons: null,
  status: "completado",                    // preservar "sospechoso" si ya lo era
  submitted_at: sub.submitted_at ?? <ahora>,
  answers: { ...answers, __breakdown: [ { qid, type, points, earned, feedback }, … ] },
}
```

- El desglose lleva **una fila por pregunta, en el orden del examen** — también las
  deterministas. Si faltan, el estudiante ve «— / 1 pts» arriba y su propia opción marcada como
  «Correcta» justo debajo.
- **No poner `ai_likelihood` / `ai_reasons`** cuando no se evaluó autoría: un 0 con motivo se lee
  en el panel de fraude como una sospecha descartada, que es otra cosa.
- La nota final que ven las pantallas es `final_override_grade ?? ai_grade`, así que escribir
  `ai_grade` es suficiente y deja al docente el override intacto.

**El camino de escritura** es el JWT de la cuenta SuperAdmin contra PostgREST (`C:/Temp/api.mjs`),
no la `service_role`: así la RLS aplica y la acción queda atribuida a una cuenta. El mismo
archivo de vitest del paso 4 hace el `patch`.

Tres guardas que no son opcionales:

1. **Antes de escribir, comprobar el total determinista contra lo contado a mano** y que el
   desglose tenga tantas filas como preguntas. Si no cuadra, abortar sin escribir.
2. **Un PATCH que la RLS filtra devuelve 204 sin error.** Exigir la fila de vuelta
   (`Prefer: return=representation` → `length === 1`), nunca el status HTTP.
3. **Releer con una consulta aparte** al terminar: la representación del PATCH viene del mismo
   request y no prueba que haya quedado.

Correr primero en seco (imprimir y verificar, sin escribir) y recién después con la variable que
habilita la escritura.

## 6. Cancelar los jobs que quedaron encolados

Si la cola no drenó, los jobs de esas entregas **siguen `pending`**: el día que alguien pulse
«Procesar todos», el modelo recalifica y pisa el trabajo revisado. Cancelarlos con la misma RPC
que usa el botón del módulo Cron:

```js
await a.rpc("cancel_ai_grading_job", { _job_id: id });   // para cada job de esas submissions
```

Y releer `ai_grading_queue` después: un RPC que la RLS filtre no falla solo.

## 7. Cerrar con la tabla y las decisiones

Entregar al docente, en el chat:

- La tabla estudiante × pregunta con el total en puntos y la nota en la escala del curso,
  ordenada de mayor a menor.
- Promedio, mediana y cuántos pasan `courses.passing_grade`.
- El promedio POR PREGUNTA: es lo que le dice qué tema retomar, y es el dato que no está en
  ninguna pantalla.
- **Las decisiones de criterio que se tomaron**, en una línea cada una — sobre todo si no se
  aplicó penalización por IA y por qué. El docente tiene que poder defenderlas en un reclamo, y
  puede cambiar cualquier nota con el override de la pantalla de monitor.

# Plan — Retos en vivo (Kahoot) en el modelo de calificación

> Estado: **propuesta para validación**. No implementado. Generado 2026-07-24.
> Objetivo: que los **Retos en vivo** cuenten en la nota de forma **parametrizable**, tanto en cursos **con cortes** como **sin cortes**, agregando el desempeño del estudiante a través de **múltiples retos** del curso.

## 1. Contexto: cómo se califica hoy

- **Pesos como % de la nota final** (post-migración `20260507100000`). Cada corte (`grade_cuts`) reparte su `weight` en buckets: `exam_weight + workshop_weight + project_weight + attendance_weight = cut.weight`. Cada item (`exams/workshops/projects.weight`) es un % de la nota final, con tope = su bucket del corte.
- **`computeWeightedGrade(items)`** ([src/utils/grade.ts](../../src/utils/grade.ts)) — promedio ponderado. Items con `score=null` **cuentan como 0** con su peso (no se reescalan). Solo devuelve `null` si NINGÚN item tiene score.
- **Curso sin cortes**: la nota se calcula con los pesos a nivel de curso (`courses.exam_weight/workshop_weight/attendance_weight/project_weight`) sobre todos los items del curso — el mismo `computeWeightedGrade` sin agrupar por corte.
- **Retos hoy** = `polls` con `poll_type='kahoot'`; el desempeño vive en `kahoot_players.score` (por juego) y `kahoot_answers`. **No entra a la nota** por ningún lado.

## 2. Modelo conceptual del nuevo componente

Se agrega **"Retos en vivo"** como un **cuarto tipo de item calificable** (junto a exam/workshop/project), con **dos modos parametrizables por curso**:

| Modo | Qué hace | Dónde vive en la fórmula |
|---|---|---|
| **A · Porcentaje fijo** | Un bucket más del corte (o del curso sin cortes). Análogo a exámenes. | DENTRO del promedio ponderado |
| **B · Puntos adicionales (bonus)** | Suma directa a la nota final ya calculada, con **tope** configurable. | FUERA del promedio ponderado |

La elección es **por curso** (`courses.challenge_grading_mode ∈ {off, fixed, bonus}`, default `off` → comportamiento actual, sin regresión).

### 2.1 Nota de retos del estudiante (agregación multi-juego)

Un curso puede tener N retos. Se define la **nota de retos** del alumno en la escala del curso:

```
challengeScore(student) =
   ( Σ_juegos  score_obtenido(student, juego) )
   / ( Σ_juegos  score_máximo(juego) )          // score_máximo = Σ points de kahoot_questions del poll
   * grade_scale_max
```

- `score_obtenido` = `kahoot_players.score` del alumno en ese juego (ya lo calcula `kahoot_submit_answer` con la fórmula velocidad·acierto).
- Retos **no jugados** por el alumno cuentan como 0 en el numerador pero **sí** suman su máximo en el denominador → incentiva participar (misma filosofía que "item sin score = 0").
- Solo se cuentan retos **publicados y con al menos un juego finalizado** (`kahoot_games.status='ended'`); retos en papelera se excluyen (`polls.deleted_at IS NULL`).
- **Config alterna** (parametrizable): `challenge_score_basis ∈ {points, accuracy}`. `points` = fórmula de arriba (premia velocidad, "espíritu Kahoot"). `accuracy` = `Σ respuestas correctas / Σ preguntas jugadas` (solo acierto, sin premiar velocidad — más "justo" como nota).

### 2.2 Modo A — Porcentaje fijo (bucket)

Se agrega un bucket `challenge_weight` a cada corte y a nivel curso:

```
cut.weight = exam_weight + workshop_weight + project_weight + attendance_weight + challenge_weight
```

`challengeScore(student)` entra a `computeWeightedGrade` como un item más con `weight = cut.challenge_weight` (o `courses.challenge_weight` sin cortes). **Asignación al corte**: un reto pertenece al corte cuyo rango de fechas contiene la fecha del juego (misma regla derivada-por-fechas que la asistencia), o `challenge_weight` global si el curso no tiene cortes.

### 2.3 Modo B — Puntos adicionales (bonus)

La nota final se calcula normal (exam/workshop/project/attendance) y luego:

```
notaFinal = min( grade_scale_max,
                 notaPonderada + bonus(student) )
bonus(student) = (challengeScore/grade_scale_max) * challenge_bonus_max
```

- `challenge_bonus_max` (config, ej. `0.5` puntos en escala 0–5) = tope de bonus.
- No altera los buckets existentes (no hay que re-balancear pesos). Ideal para "premiar participación" sin quitarle peso a lo demás.
- Se aplica **por corte** (bonus dentro de cada corte, tope por corte) o **global** (bonus a la nota final del curso) según `challenge_bonus_scope ∈ {course, cut}`.

## 3. Esquema DB (migraciones defensivas, estilo repo)

```sql
-- Config por curso (default off → sin regresión)
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS challenge_grading_mode text NOT NULL DEFAULT 'off'
    CHECK (challenge_grading_mode IN ('off','fixed','bonus')),
  ADD COLUMN IF NOT EXISTS challenge_score_basis text NOT NULL DEFAULT 'points'
    CHECK (challenge_score_basis IN ('points','accuracy')),
  ADD COLUMN IF NOT EXISTS challenge_weight numeric NOT NULL DEFAULT 0,      -- modo fixed, curso sin cortes
  ADD COLUMN IF NOT EXISTS challenge_bonus_max numeric NOT NULL DEFAULT 0,   -- modo bonus (en escala del curso)
  ADD COLUMN IF NOT EXISTS challenge_bonus_scope text NOT NULL DEFAULT 'course'
    CHECK (challenge_bonus_scope IN ('course','cut'));

-- Bucket por corte (modo fixed con cortes)
DO $$ BEGIN IF to_regclass('public.grade_cuts') IS NOT NULL THEN
  ALTER TABLE public.grade_cuts
    ADD COLUMN IF NOT EXISTS challenge_weight numeric NOT NULL DEFAULT 0;
END IF; END $$;
```

- **RPC de agregación** `SECURITY DEFINER` `course_challenge_scores(_course_id)` → `TABLE(user_id uuid, score numeric, max numeric, cut_id uuid)`: computa `challengeScore` server-side (join `kahoot_games`→`kahoot_players`/`kahoot_answers`, filtra `polls.deleted_at IS NULL` + `status='ended'`, deriva corte por fecha). Se usa en gradebook y en la vista del alumno. Evita traer todos los `kahoot_answers` al cliente.
- **Regla de validación** (form de cortes): `Σ buckets = cut.weight` ahora incluye `challenge_weight`. Actualizar la validación del form de cortes ([app.admin.courses]) y el "te queda X disponible".

## 4. Puntos de enganche en el código

| Archivo | Cambio |
|---|---|
| [src/utils/grade.ts](../../src/utils/grade.ts) | `computeWeightedGrade`: aceptar item tipo `challenge` (modo A). Nuevo helper `applyChallengeBonus(nota, challengeScore, cfg)` (modo B). `computeCutGrade`/`computeCourseFinalGrade`: sumar el bucket challenge (A) o el bonus (B). |
| [src/routes/app.teacher.gradebook.tsx](../../src/routes/app.teacher.gradebook.tsx) | Llamar `course_challenge_scores`; agregar columna/fila "Retos en vivo" (modo A como item; modo B como ajuste visible "+bonus"). |
| [src/routes/app.student.grades.tsx](../../src/routes/app.student.grades.tsx) | Mismo cálculo (paridad obligatoria con gradebook, ya documentada). Mostrar el aporte de retos. |
| Form de cortes (`app.admin.courses`) | Input `challenge_weight` por corte + selector de modo/tope a nivel curso + validación de suma. |
| Migración | Columnas + RPC + `NOTIFY pgrst`. |

## 5. Cursos sin cortes

- Modo A: `challengeScore` entra como item con `weight = courses.challenge_weight` al `computeWeightedGrade` plano del curso.
- Modo B: bonus con `scope='course'` sobre la nota final del curso.
- Sin `grade_cuts`, la derivación "reto→corte por fecha" no aplica; todos los retos agregan al pool global del curso.

## 6. Casos borde

- **Alumno que no jugó ningún reto** → `challengeScore = 0` (modo A resta como item en 0; modo B no suma bonus). Documentar en la UI ("los retos cuentan; si no participas, ese componente es 0").
- **Curso sin retos** o retos sin juego finalizado → denominador 0 → `challengeScore = null` → el componente se **omite** (no penaliza). Igual que "ningún item con score → null".
- **Reto en papelera** → excluido del numerador y denominador (`deleted_at IS NULL`), consistente con la regla universal de papelera.
- **Empates / velocidad**: `basis='accuracy'` para instituciones que no quieran premiar velocidad en la nota formal.
- **Migración de cursos existentes**: `mode='off'` por default → cero cambios de nota hasta que el docente lo active.

## 7. Invariantes a respetar

- **Paridad gradebook ↔ grades del estudiante** (misma fórmula en ambos; ya es invariante documentada).
- **`Σ buckets = cut.weight`** ahora incluye `challenge_weight`.
- **Regla de papelera** en TODA lectura de retos (query directa + RPC guard).
- Fórmula de `challengeScore` **replicada** entre el RPC SQL y cualquier preview cliente (nueva invariante cross-file a anotar en CLAUDE.md).

## 8. Fases

1. **DB + agregación**: columnas + `course_challenge_scores` RPC + tests del helper de agregación.
2. **grade.ts**: modos A/B en el núcleo + tests puros (item challenge, bonus con tope, sin retos, papelera).
3. **Gradebook + grades**: columna/fila + paridad.
4. **Form de cortes/curso**: parametrización (modo, peso/bono, basis, scope) + validación de suma.
5. **i18n + consistencia + docs** (CLAUDE.md: sección + invariante cross-file).

## 9. Decisiones abiertas para validar

1. **¿`basis` default `points` (premia velocidad) o `accuracy` (solo acierto)?** — recomendación: `accuracy` como default para nota formal, `points` opcional.
2. **¿Bonus tope típico?** — sugerido 0.3–0.5 en escala 0–5.
3. **¿Reto→corte por fecha del juego, o asignación manual del reto a un corte?** (por-fecha es consistente con asistencia; manual da más control). Recomendación: por-fecha con override manual opcional (`polls.cut_id`).
4. **¿Un reto jugado varias veces (varios `kahoot_games` del mismo poll) cuenta el mejor, el último, o el promedio?** — recomendación: **mejor score** por poll.

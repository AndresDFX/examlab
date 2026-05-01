## Resumen de problemas

1. **Migración de escala incompleta**: hay `submissions.ai_grade` con valores en escala 0-10 (ej: 7.13) en cursos cuyo `grade_scale_max=5`. El gradebook y la vista del estudiante asumen que `ai_grade` está en `/10` y lo re-escalan, pero los nuevos cálculos de `ai-grade-submission` ya guardan en la escala del curso. Resultado: notas viejas se ven duplicadas/desfasadas.
2. **Asignación a estudiantes que no son del curso**: el flujo de asignación ya filtra por `course_enrollments`, pero (a) por defecto al crear examen/taller no se asigna a nadie y (b) en algunos casos aparecen estudiantes que no deberían. Hay que: auto-asignar todos los matriculados al crear y validar que el listado solo muestre matriculados.
3. **Falta duplicar exámenes/talleres** desde el grid (el ícono `Copy` ya está importado pero sin usar).
4. **Programación sincrónica vs relativa**: hoy el timer siempre cuenta hasta `end_time`. Hay que añadir un modo "Relativo" donde la ventana `[start_time, end_time]` define cuándo está disponible y `time_limit_minutes` es el tiempo real desde que el estudiante inicia. Los exámenes existentes quedan como "Normal".
5. **Cálculo confuso "30/4 → 7/5, Duración 60 min"**: es síntoma de #4 (rango grande + límite corto sin modo relativo). Se resuelve con #4.

## Cambios

### 1. Migración SQL (supabase/migrations/...)

```sql
-- a) Re-escalar ai_grade y final_override_grade de submissions viejas
--    Heurística: si el valor supera grade_scale_max del curso, está en escala 0-10
UPDATE public.submissions s
SET ai_grade = ROUND((s.ai_grade / 10.0) * c.grade_scale_max, 2)
FROM public.exams e JOIN public.courses c ON c.id = e.course_id
WHERE s.exam_id = e.id
  AND s.ai_grade IS NOT NULL
  AND s.ai_grade > c.grade_scale_max;

UPDATE public.submissions s
SET final_override_grade = ROUND((s.final_override_grade / 10.0) * c.grade_scale_max, 2)
FROM public.exams e JOIN public.courses c ON c.id = e.course_id
WHERE s.exam_id = e.id
  AND s.final_override_grade IS NOT NULL
  AND s.final_override_grade > c.grade_scale_max;

-- b) Nuevo tipo de programación de examen
ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS schedule_type text NOT NULL DEFAULT 'normal'
  CHECK (schedule_type IN ('normal','relativo'));
-- Los existentes quedan en 'normal' por default.
```

Y en `src/routes/app.teacher.gradebook.tsx` línea 481 + `src/routes/app.student.grades.tsx` línea 243: cambiar `toScale(raw, 10)` a `toScale(raw, course.grade_scale_max)` para que ya no asuma /10. Igual en cualquier consumidor de `submissions.ai_grade`.

### 2. Auto-asignar al crear examen/taller

En `src/routes/app.teacher.exams.index.tsx` (función `save`) y en `app.teacher.workshops.tsx` (al crear): después del insert, hacer un insert en `exam_assignments`/`workshop_assignments` con todos los `user_id` de `course_enrollments` del curso. En el editor de examen ya se filtra correctamente por `course_enrollments` — confirmar que el listado en workshops también filtre así (revisar y ajustar si es necesario).

### 3. Botón duplicar en grid

En `src/routes/app.teacher.exams.index.tsx` y `src/routes/app.teacher.workshops.tsx`: agregar acción "Duplicar" (icono `Copy`) en cada fila. La duplicación:
- Inserta nuevo examen/taller con título "Copia de {original}", `status='draft'`, mismo `course_id`, `cut_id`, configuración.
- Copia también `questions` (o `workshop_questions`) en el mismo orden.
- No copia asignaciones ni entregas.
- Toast de éxito y refresh del listado.

### 4. Tipo de programación "Relativo"

**Modelo**:
- `schedule_type='normal'`: comportamiento actual. `time_limit_minutes` = duración de la ventana sincrónica; el timer cuenta hasta `end_time`.
- `schedule_type='relativo'`: `[start_time, end_time]` es la ventana de disponibilidad (días/semana). `time_limit_minutes` es el tiempo real que tiene cada estudiante desde que abre el examen.

**UI docente** (`exams.index.tsx` y `exams.$examId.tsx`):
- RadioGroup "Tipo de programación": Normal / Relativo, con tooltip de ayuda explicando la diferencia.
- En modo Relativo, etiquetas cambian: "Ventana de disponibilidad" en vez de "Inicio/Fin", y "Duración por estudiante" para `time_limit_minutes`.

**Lógica de timer** (`src/utils/exam-time.ts` + `app.student.take.$examId.tsx`):
- Crear `computeSecondsLeftRelative(submission.started_at, time_limit_minutes, end_time)` que devuelve `min(time_limit_minutes*60 - (now-started_at), end_time-now)`.
- En el componente, si `exam.schedule_type === 'relativo'`, usar el cálculo nuevo basado en `submission.started_at`; si no, mantener `computeSecondsLeft(end_time)`.
- En la pantalla previa al inicio (línea ~789), mostrar texto correspondiente: "Tendrás N minutos desde que inicies, dentro de la ventana ...".

**Vista estudiante** (`app.student.exams.tsx`): mostrar badge "Relativo" o "Sincrónico" y ajustar copy del rango.

### 5. Verificación post-migración

Después de aplicar la migración SQL, verificar con `read_query` que ningún `ai_grade` siga > `grade_scale_max` para su curso.

## Notas técnicas

- La condición `> grade_scale_max` para detectar valores viejos es segura: las nuevas calificaciones siempre se truncan a la escala del curso por el edge function `ai-grade-submission`, así que cualquier valor por encima es residuo de la escala 0-10 anterior. Cursos con `grade_scale_max=10` no se ven afectados (caso correcto en ambas escalas).
- `course_enrollments` no tiene FK a `profiles` (PGRST200 ya resuelto antes), pero se hace `select user_id` y luego `profiles.in('id', ...)`, que ya funciona.
- El nuevo `schedule_type` no rompe nada existente porque default es `'normal'`.
- No se toca `ai-grade-submission/index.ts` porque ya usa la escala correcta del curso.

## Resumen de archivos

- **Nueva migración**: re-escalar `submissions` viejas + columna `exams.schedule_type`.
- **Editar**: `src/routes/app.teacher.gradebook.tsx`, `src/routes/app.student.grades.tsx` (usar `grade_scale_max` en vez de hardcoded 10).
- **Editar**: `src/routes/app.teacher.exams.index.tsx` (auto-asignar al crear, botón duplicar, selector schedule_type), `src/routes/app.teacher.exams.$examId.tsx` (selector schedule_type + ayuda).
- **Editar**: `src/routes/app.teacher.workshops.tsx` (auto-asignar al crear, botón duplicar, validar filtro de matriculados).
- **Editar**: `src/utils/exam-time.ts` (helper relativo), `src/routes/app.student.take.$examId.tsx` (usar timer relativo cuando aplique), `src/routes/app.student.exams.tsx` (badge tipo).

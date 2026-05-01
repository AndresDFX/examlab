## Resumen de cambios

Tres features que se entrelazan a través del mismo modelo `submissions` (que ya soporta múltiples filas por `(exam_id, user_id)`):

1. **Modo de reintento** parametrizable por examen: `last` | `average` | `highest`.
2. **Pantalla completa forzada** al iniciar el examen, con re-entry automático si el estudiante intenta salir (Esc cuenta como warning).
3. **Monitor agrupado por estudiante**, mostrando "Intento N de M", listado de intentos previos, eliminación selectiva y recálculo automático de la nota del examen según el modo.

---

## 1. Migración SQL

```sql
-- Modo de cálculo de la nota cuando hay varios intentos
ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS retry_mode text NOT NULL DEFAULT 'last'
  CHECK (retry_mode IN ('last','average','highest'));
-- 'last' replica el comportamiento actual (sobrescribe con el último intento).
```

No se necesitan cambios en `submissions`: el `created_at` ya da orden y el índice parcial actual asegura un solo `en_progreso` por estudiante.

---

## 2. Helper compartido de cálculo

Nuevo `src/utils/exam-attempts.ts`:

```ts
export type RetryMode = 'last' | 'average' | 'highest';

// Recibe los intentos finalizados (completado/sospechoso) ordenados por created_at ASC.
// Devuelve la nota efectiva según retry_mode, o null si no hay intentos válidos.
export function computeAttemptGrade(
  attempts: { ai_grade: number | null; final_override_grade: number | null; created_at: string }[],
  mode: RetryMode,
): number | null { ... }
```

Esto se usa en:
- `src/routes/app.teacher.gradebook.tsx` (función `getGrade`, rama `kind === "exam"`).
- `src/routes/app.student.grades.tsx` (cálculo por examen del estudiante).
- `src/routes/app.teacher.monitor.$examId.tsx` (columna "Nota efectiva" por estudiante).

Para el gradebook, ahora se trae **todas** las submissions del examen (no la primera) y se agrupan por `user_id`. Los exámenes de recuperación (`parent_exam_id`) siguen funcionando: si el estudiante no tiene submissions del original, se busca en los hijos.

---

## 3. UI docente — selector de modo

**`app.teacher.exams.$examId.tsx`** y **`app.teacher.exams.index.tsx`** (diálogo de creación):

- `RadioGroup` "Modo de calificación con reintentos" con tres opciones y tooltip:
  - **Último intento** (default): toma la nota del intento más reciente.
  - **Promedio**: promedia las notas de todos los intentos finalizados.
  - **Más alto**: toma la mejor nota entre los intentos.
- Solo es relevante cuando `max_attempts > 1` (o el curso lo permite); si es 1 se deshabilita con texto explicativo.

---

## 4. Pantalla completa forzada

**`app.student.take.$examId.tsx`**:

- Al iniciar (`startExam`), llamar `document.documentElement.requestFullscreen()` antes de marcar `setStarted(true)`. Si el navegador rechaza (no hay user-gesture), mostrar un toast pidiendo confirmación con un botón único.
- Listener `fullscreenchange`: si se sale durante el examen y `started === true && !submitting`:
  1. Registrar warning con `recordWarning('fullscreen_exit')` (ya soportado por `proctoring.ts`).
  2. Mostrar un overlay bloqueante con botón "Volver a pantalla completa" que reinvoca `requestFullscreen()` (Esc no se puede interceptar, pero el re-entry sí).
  3. El examen no avanza ni acepta input mientras el overlay está visible.
- Listener `keydown` para `F11` y `Escape`: `preventDefault()` y mostrar el mismo overlay.
- Al hacer submit/finalizar correctamente, `document.exitFullscreen()`.

Notas técnicas: la spec del navegador no permite bloquear Esc del fullscreen (es seguridad del usuario). El compromiso aceptado es: Esc sale → warning + overlay bloqueante + re-entry obligatorio. Tras `MAX_WARNINGS` el examen se marca sospechoso como ya hace hoy.

---

## 5. Monitor — agrupar por estudiante y gestionar intentos

**`app.teacher.monitor.$examId.tsx`**:

### Carga
- Se sigue cargando todas las submissions del examen, pero el render agrupa por `user_id`.
- Por estudiante se calcula:
  - `attempts`: lista ordenada de intentos (todos los status).
  - `currentAttempt`: el más reciente.
  - `attemptsUsed`: cuántos finalizados (completado/sospechoso).
  - `maxAttempts`: `exam.max_attempts ?? course.max_exam_attempts ?? 1`.
  - `effectiveGrade`: `computeAttemptGrade(finishedAttempts, exam.retry_mode)`.

### Tabla
- Una sola fila por estudiante (ya no se duplica).
- Nueva columna: **"Intentos"** mostrando "N de M" (ej: "2 de 3").
- La columna de nota muestra `effectiveGrade` con un badge del modo (Último/Promedio/Máximo).
- Acción "Ver intentos" abre un `Dialog` con la lista de intentos:
  - Por intento: número, fecha, status, warnings, nota, botón "Ver respuestas" (reusa el dialog actual de respuestas), botón "Eliminar intento" con confirmación.
  - Botón global "Eliminar todos los intentos" con confirmación reforzada.

### Eliminación
- `eliminar intento`: `DELETE FROM submissions WHERE id = ?` (RLS ya lo permite a docentes/admins).
- `eliminar todos`: `DELETE FROM submissions WHERE exam_id = ? AND user_id = ?`.
- Tras la eliminación, recargar y la `effectiveGrade` se recalcula automáticamente porque viene del helper.
- Si se eliminan todos los intentos finalizados, el estudiante queda libre para iniciar uno nuevo (el límite `max_attempts` ya cuenta solo los finalizados restantes).

---

## Archivos a tocar

- **Nueva migración** SQL: agrega `exams.retry_mode`.
- **Nuevo**: `src/utils/exam-attempts.ts` (+ tests opcionales).
- **Editar** `src/routes/app.teacher.exams.$examId.tsx`, `src/routes/app.teacher.exams.index.tsx`: selector `retry_mode`, tooltip de ayuda, persistir en insert/update.
- **Editar** `src/routes/app.student.take.$examId.tsx`: lógica de fullscreen, overlay de re-entry, intercept de Esc/F11, exitFullscreen al finalizar.
- **Editar** `src/routes/app.teacher.monitor.$examId.tsx`: agrupar por estudiante, columna "Intentos", dialog de gestión de intentos, eliminación selectiva.
- **Editar** `src/routes/app.teacher.gradebook.tsx`, `src/routes/app.student.grades.tsx`: usar `computeAttemptGrade` en vez de tomar la primera submission.

## Riesgos / notas

- Los exámenes existentes quedan en `retry_mode='last'`, equivalente al comportamiento actual → no rompe nada.
- Esc en fullscreen no se puede bloquear realmente; se mitiga con overlay + warning + re-entry obligatorio (estándar para proctoring web).
- El recálculo de nota tras borrar intentos es derivado (no se persiste en `submissions`), así que siempre está sincronizado con `retry_mode`.
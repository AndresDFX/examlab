# Plan: Fix UI de cortes + nueva jerarquía de calificación

## Diagnóstico previo

### Bug de layout (revisado en `src/routes/app.admin.courses.tsx` líneas 1071-1255)
La sección de cortes usa:
- Contenedor padre `<div className="rounded-md border p-3 space-y-3">` **anidado dentro** de la card "Escala de calificación", que a su vez está dentro del `<DialogContent>` por defecto de shadcn (sin `max-h` ni scroll interno).
- Cada corte usa `grid md:grid-cols-[auto_2fr_1fr_1fr_1fr]` sin `min-w-0` en las columnas → los `<Input type="date">` desbordan en viewports angostos.
- Cuando hay 5+ cortes el `DialogContent` crece más allá del viewport y el botón "Guardar" queda fuera del scroll de página.

### Lógica actual de calificación (revisado en `app.student.grades.tsx` líneas 182-211, `app.teacher.gradebook.tsx` líneas 196-239)
- `computeAverages()` ignora cortes y usa solo `course.exam_weight` + `course.workshop_weight` (proyectos y asistencia ya existen en BD pero **no** se calculan).
- Los exámenes y talleres tienen `cut_id` (BD), pero no se usa al calcular la nota final.
- Hay un sistema legacy paralelo en `app.teacher.grading.$courseId.tsx` con `course_grading_config` y `grade_cut_items` que duplica el flujo y ya no aplica con la nueva jerarquía.

## Cambios

### 1. Bugfix UI — Layout responsivo de cortes (`src/routes/app.admin.courses.tsx`)
- Envolver el `DialogContent` con `className="max-w-3xl max-h-[90vh] overflow-y-auto"` para que el modal completo tenga scroll vertical y no rompa la página.
- En la sección de cortes (líneas 1072-1255):
  - Reemplazar el grid de cada corte por un layout de **2 filas en mobile / 1 fila en desktop**:
    - Fila 1: chevron + nombre (siempre visibles, `flex items-center gap-2`).
    - Fila 2: fechas + peso en `grid grid-cols-1 sm:grid-cols-3 gap-2`.
  - Añadir `min-w-0` a todas las columnas grid para que `<Input>` no fuerce overflow.
  - Cambiar el contenedor de la lista a `max-h-[40vh] overflow-y-auto pr-1` cuando hay >3 cortes, así el scroll vive dentro del bloque.
  - Sub-pesos: cambiar `grid-cols-2 md:grid-cols-4` a `grid grid-cols-2 lg:grid-cols-4 gap-2 min-w-0` y reducir `Input` a `h-8` para densidad.
- Validado contra el viewport actual (1010×675) y mobile (375px).

### 2. Reestructurar cálculo de notas
**Regla de negocio inmutable**: la nota del curso = Σ(corte_i × peso_i / 100). La nota de cada corte = Σ(componente_j × peso_j / 100), con componentes `{ talleres, exámenes, proyectos, asistencia }`.

#### a) Nuevo helper `src/utils/grade.ts` (extender el existente)
Agregar funciones puras y testeables:
```ts
export interface CutWeights { exam: number; workshop: number; attendance: number; project: number; }
export interface CutComponentScores {
  exam: number | null;     // 0..gradeMax o null si no hay datos
  workshop: number | null;
  attendance: number | null;
  project: number | null;
}
export function computeCutGrade(scores: CutComponentScores, weights: CutWeights, gradeMax: number): number | null;
export function computeCourseFinalGrade(cutResults: { weight: number; grade: number | null }[]): number | null;
```
- `computeCutGrade`: ignora componentes con score `null` y reescala los pesos restantes (si solo hay talleres y exámenes calificados, suman los pesos de esos dos como denominador) — evita penalizar al estudiante por items aún no calificados.
- `computeCourseFinalGrade`: misma estrategia (ignora cortes sin datos, reescala pesos).

#### b) Asociar entregas a cortes
- Las tablas `exams`, `workshops`, `projects` ya tienen `cut_id`. Asegurar que en los formularios de creación/edición de exámenes y talleres exista un selector "Corte" (revisar `app.teacher.exams.$examId.tsx` y `app.teacher.workshops.tsx`) — si no existe, agregarlo. **Sin tocar otras vistas**: solo añadir el selector mínimo.
- La asistencia agregada por corte se calcula con `attendance_records` filtrando por `session_date` BETWEEN `cuts.start_date` AND `cuts.end_date`. Si un corte no tiene fechas, su componente de asistencia queda `null`.

#### c) Refactor `app.student.grades.tsx`
- Cargar `grade_cuts` del curso, exámenes/talleres/proyectos con su `cut_id`, sumisiones del estudiante y registros de asistencia.
- Reemplazar `computeAverages()` por un nuevo `computeByCuts()`:
  1. Para cada corte: agrupar items por componente → calcular promedio por componente (escalado a `grade_scale`) → aplicar `computeCutGrade()`.
  2. Aplicar `computeCourseFinalGrade()` con los pesos de cada corte.
- UI nueva: tabla/cards por corte mostrando los 4 componentes y la nota del corte; tarjeta "Nota actual" sigue mostrando el final.
- Deprecar las cards "Promedio exámenes" y "Promedio talleres" → reemplazar por una card por corte con su % y nota.

#### d) Refactor `app.teacher.gradebook.tsx`
- Mantener la matriz editable existente (es la herramienta de edición), pero añadir arriba un panel "Consolidado por cortes" por estudiante: una columna por corte + columna final, calculadas con los mismos helpers. Solo lectura. No tocar otras vistas.

#### e) Limpieza del sistema legacy
- Marcar `app.teacher.grading.$courseId.tsx` como deprecado (deja un banner "Esta vista será reemplazada — la configuración de cortes vive ahora en el diálogo de curso") **sin eliminar el archivo** para no romper rutas externas.
- Eliminar el botón/enlace que abre esa vista desde otras pantallas si existe (verificar `app.teacher.courses.tsx`). Las tablas `course_grading_config` y `grade_cut_items` quedan en BD por compatibilidad pero no se usan en el nuevo cálculo. **No** hago migración destructiva.

### 3. Plan de pruebas (`docs/PLAN-PRUEBAS-QA.md`)
- **Eliminar** los casos obsoletos referenciados al sistema legacy de `course_grading_config` y a la pantalla `/app/teacher/grading/$courseId` (sección de Calificaciones que asuma esa pantalla).
- **Agregar sección nueva "11. Cortes evaluativos"**:
  - `CUT-UI-01` (P1): Crear curso, agregar 5 cortes desde el input numérico → todos los cortes son visibles, el modal hace scroll, los inputs no se desbordan en viewport 375×667 ni 1024×768.
  - `CUT-UI-02` (P2): Reducir cortes de 5 a 2 → confirmación aparece y el layout sigue alineado.
  - `CUT-CALC-01` (P0): Nota de un corte con talleres=4.0 (peso 30%), exámenes=3.0 (40%), proyecto=5.0 (20%), asistencia=4.5 (10%) sobre escala 0-5 → resultado = 3.75.
  - `CUT-CALC-02` (P0): Nota final del curso con Corte1=3.75 (40%) + Corte2=4.0 (60%) → 3.9.
  - `CUT-CALC-03` (P1): Componente sin datos (proyecto null) → su peso se reescala en el resto.
  - `CUT-CALC-04` (P1): Vista del estudiante muestra la nota por corte y final coincidente con `computeCourseFinalGrade` para 3 estudiantes distintos.

### 4. Tests automatizados (`src/utils/grade.test.ts`)
- Eliminar tests obsoletos que asumían la fórmula global previa (los actuales sobre `computeFinalGrade` se mantienen — son el cálculo dentro de un examen, no del curso).
- Añadir suites:
  - `computeCutGrade`:
    - 4 componentes completos → cálculo ponderado correcto.
    - Componentes parcialmente nulos → reescala los pesos restantes.
    - Todos null → retorna null.
    - Pesos suman 0 → retorna null.
  - `computeCourseFinalGrade`:
    - 3 cortes con notas y pesos → suma ponderada correcta.
    - Cortes con peso 0 → ignorados.
    - Cortes con grade null → reescala el resto.
    - Sin cortes → retorna null.

### 5. Documentación (`EXAMLAB-CONTEXT.md`)
Agregar sección al final, antes de "Asistencia (FASE 6 — UI)":

```md
## Jerarquía de calificación (REGLA DE NEGOCIO INMUTABLE)

La nota final de un curso se calcula EXCLUSIVAMENTE así:

  Curso → Σ(Cortes ponderados)
  Corte → Σ(Talleres, Exámenes, Proyectos, Asistencia ponderados)

- Los pesos a nivel curso (`courses.exam_weight`, `workshop_weight`,
  `attendance_weight`, `project_weight`) son DEPRECADOS para el cálculo final;
  se conservan solo como defaults al sembrar nuevos cortes.
- Cada `grade_cuts` define `weight` (% del curso) y los 4 sub-pesos
  (`exam_weight`, `workshop_weight`, `attendance_weight`, `project_weight`)
  que deben sumar 100 dentro del corte.
- Exámenes, talleres y proyectos pertenecen a un corte vía `cut_id`.
- La asistencia se acumula por corte usando `attendance_sessions.session_date`
  contra `grade_cuts.start_date`/`end_date`.
- Si un componente de un corte no tiene datos, su peso se REESCALA entre los
  componentes restantes (no se penaliza al estudiante).
- Helpers canónicos: `computeCutGrade()` y `computeCourseFinalGrade()` en
  `src/utils/grade.ts`. Cualquier vista nueva que muestre nota agregada DEBE
  usarlos.
- La pantalla legacy `/app/teacher/grading/$courseId` y las tablas
  `course_grading_config`/`grade_cut_items` quedan congeladas y no se usan en
  el cálculo nuevo.
```

## Archivos modificados
- `src/routes/app.admin.courses.tsx` — fix layout cortes + DialogContent scroll.
- `src/utils/grade.ts` — nuevos helpers `computeCutGrade`, `computeCourseFinalGrade`.
- `src/utils/grade.test.ts` — tests de los nuevos helpers (mantener los previos).
- `src/routes/app.student.grades.tsx` — refactor cálculo por cortes, UI por corte.
- `src/routes/app.teacher.gradebook.tsx` — añadir panel consolidado por cortes (solo lectura).
- `src/routes/app.teacher.exams.$examId.tsx` — agregar selector de Corte (si no existe).
- `src/routes/app.teacher.workshops.tsx` — agregar selector de Corte (si no existe).
- `src/routes/app.teacher.grading.$courseId.tsx` — banner de deprecación.
- `docs/PLAN-PRUEBAS-QA.md` — limpiar obsoletos + sección 11 Cortes.
- `EXAMLAB-CONTEXT.md` — sección "Jerarquía de calificación".

## Archivos NO tocados (restricción de alcance)
- Edge functions, AppLayout, otras vistas de docente/estudiante, módulo de proyectos, configuración de auth/RLS, schema de BD (no requiere migración nueva — la BD ya soporta esto).

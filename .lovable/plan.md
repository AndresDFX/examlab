# Plan: Cantidad de cortes dinámica en creación/edición de curso

## Objetivo
Dentro del bloque **"Escala de calificación"** del diálogo `Nuevo curso` / `Editar curso`, agregar un campo **"Cantidad de cortes"** (numérico). Al cambiarlo se generan/eliminan dinámicamente N cajas con los campos de cada corte (Nombre, Fecha inicio, Fecha fin, Peso %, sub-pesos por componente). Funciona tanto al crear como al editar.

## Decisiones aprobadas
- **Comportamiento al crear**: diferir. Las cajas viven en estado local; al pulsar **Guardar** se crea el curso y luego se insertan los N cortes en una sola operación.
- **Reducir N**: pedir confirmación y eliminar los cortes excedentes (los últimos por `position`), incluidos sus `grade_cut_items`.

## Cambios de UI — `src/routes/app.admin.courses.tsx`

### 1. Nuevo campo en "Escala de calificación"
Agregar al final del bloque de pesos, antes del badge de total, una fila con:
- `Label: "Cantidad de cortes"` + `Input type="number" min=0 max=10` (junto al input, una pequeña ayuda: "0 = sin cortes").
- Mantener visible el bloque actual de pesos globales (4 columnas) — los sub-pesos por corte son adicionales.

### 2. Estado para cortes en memoria
- Nuevo estado `editingCuts: DraftCut[]` en `AdminCourses`, donde:
  ```ts
  type DraftCut = {
    id?: string;          // existe sólo si ya está en BD
    name: string;
    start_date: string | null;
    end_date: string | null;
    weight: number;
    exam_weight: number;
    workshop_weight: number;
    attendance_weight: number;
    project_weight: number;
    position: number;
  };
  ```
- Al abrir el diálogo en modo **edición**: cargar `grade_cuts` del curso → `editingCuts` (ordenados por `position`).
- Al abrir en modo **nuevo**: `editingCuts = []`.

### 3. Cambio de "Cantidad de cortes" (`N`)
- Si `N > editingCuts.length` → push de cortes vacíos con defaults (`name = "Corte {i}"`, `weight = Math.round(100/N)`, `exam_weight=40, workshop_weight=30, attendance_weight=10, project_weight=20`, `position = i`).
- Si `N < editingCuts.length` →
  - Detectar cortes excedentes (los últimos por `position`).
  - Para cortes que ya tienen `id` en BD: consultar `grade_cut_items` y mostrar advertencia (`useConfirm`) si tienen items: *"Se eliminarán M corte(s) y sus items asociados. ¿Continuar?"*.
  - Si confirma, recortar `editingCuts` (la eliminación real en BD ocurre en `save()`).
  - Si cancela, restaurar el input al valor anterior.

### 4. Sustitución de `<CutsEditor courseId={editing.id} />`
Reemplazar el render condicional actual (líneas 913-920) por una sección **inline** que mapee `editingCuts` y renderice una caja por corte con: nombre, fechas, peso (%), botón expand para sub-pesos (4 inputs en grid), badge de validación (sub-pesos = 100). Reutilizar la estética actual de `CutsEditor.tsx` (mismo patrón visual, mismos colores `bg-muted/30`).

Eliminar también la importación de `CutsEditor` si ya no se usa en otra parte (verificar — sólo se usa aquí).

### 5. Indicadores de validación
- Badge "Total cortes: X%" — verde cuando suma 100, destructivo si no (o si `editingCuts.length === 0`, ocultar).
- Badge por corte "Sub-pesos: X%".
- Estos badges son sólo informativos; no bloquean el guardado (mantener consistencia con la UX actual de los pesos globales).

## Lógica de guardado — función `save()`

Reescribir el flujo:

1. Validar nombre y fechas (igual que ahora).
2. Insertar/actualizar `courses` con el payload existente.
3. Una vez tenemos `courseId` (ya sea existente o el recién creado):
   - **Cortes con `id`**: hacer `update` por cada uno con sus campos.
   - **Cortes sin `id`**: hacer `insert` con `course_id = courseId`.
   - **Cortes eliminados** (los que estaban en BD pero ya no en `editingCuts`): `delete from grade_cuts where id in (...)`. La FK con `on delete cascade` (asumida en `grade_cut_items`) limpiará los items; si no tiene cascade, primero borrar `grade_cut_items` con `cut_id in (...)`.
4. Toast de éxito y recargar lista.

Para detectar eliminaciones: al abrir el diálogo guardar también `originalCutIds: Set<string>` con los IDs cargados; al guardar, eliminar `originalCutIds - currentIds`.

## Archivos a modificar

- `src/routes/app.admin.courses.tsx` — todo el cambio (UI + estado + save).
- `src/components/CutsEditor.tsx` — **mantener** por ahora (no se borra) ya que la lógica nueva vive inline en el diálogo. Si después de la migración no lo usa nadie, en una iteración posterior se puede eliminar. Dejaré una nota en el código indicando que está deprecado.

## Restricciones respetadas
- No se modifican migraciones ni esquema (la estructura de `grade_cuts` ya tiene los sub-pesos).
- No se cambia el comportamiento existente de los pesos globales del curso.
- Reutilizo `useConfirm`, `Input`, `Label`, `Badge`, mismos patrones visuales.
- No toco `src/integrations/supabase/types.ts` (auto-generado).

## Orden de ejecución
1. Refactor en `app.admin.courses.tsx`: estado `editingCuts`, `originalCutIds`, carga al abrir.
2. UI: campo "Cantidad de cortes" + render inline de las cajas.
3. Lógica de cambio de N (con confirm para reducción).
4. Reescribir `save()` para persistir cortes en lote.
5. `npx tsc --noEmit` para verificar tipos.

# Banco de preguntas — consistencia vs grids hermanos (2026-07-20)

Revisión comparativa (agente `consistencia`) del módulo **Banco de preguntas**
(`src/routes/app.teacher.question-bank.tsx`) contra Exámenes/Talleres/Proyectos/Cursos/
Usuarios. **Sin bloqueantes** (no hay leaks RLS, ni choque de storageKey, ni hidratación
#418). Iconos, i18n (paridad 8446/8446), persistencia, gating por curso y design system:
todo OK. Lo que diverge:

## ✅ Aplicado
- **"organización" → "institución"** (`shareOrgLabel`, es+en) — era la única feature que
  decía "organización"; el resto usa "institución" (marca). Commit `51139c8e`.
- **Guard `cancelled`** en el `useEffect` de carga de cursos (regla obligatoria de CLAUDE.md
  para effects async con setState/toast).

## 🟡 Pendiente (VISIBLE en UI → requiere regrabar el video t06 al aplicarse)
Se difieren porque la pasada de regrabación ya estaba en curso; aplicarlos ahora dejaría el
video t06 desalineado. Aplicar en una sesión enfocada + regrabar t06.

1. **Bloque de 4 `StatCard`** bajo el `PageHeader` (como exams/workshops/projects/courses/
   users/polls/whiteboards/contents). Sugeridos: Total de preguntas · Compartidas con la
   institución (`shared_org`) · Sin usar (`times_used=0`) · Usos totales. Insertar
   `<div className="grid grid-cols-2 md:grid-cols-4 gap-3">` entre `PageHeader` (~648) y la
   Card de filtros (~651).
2. **`useMultiSelect` + `MultiSelectToolbar` + `BulkDeleteDialog`** (`@/components/ui/multi-select`)
   — selección múltiple + borrado en bloque, como los 7 grids hermanos. Especialmente útil
   porque "Generar con IA" puede crear ~20 preguntas de una. Requiere: `useMultiSelect(sort.sorted)`,
   `MultiSelectHeaderCheckbox`/`MultiSelectCheckbox` (colSpan de `TableEmpty` 8→9),
   `MultiSelectToolbar` sobre la tabla, `BulkDeleteDialog` con `db.from("question_bank").delete().in("id", ids)`.

## 🟢 Pendiente (INVISIBLE → no requiere regrabar)
3. **`logEvent`** (auditoría) en `save()` / `remove()` / `generateWithAI()` — hoy el CRUD del
   banco es invisible en `/app/admin/audit-logs` (workshops/exams/projects sí auditan). Importar
   `logEvent` de `@/shared/lib/audit` y loguear `question_bank.created/updated/deleted`
   (`entityId: r.id`, `entityName: content.slice(0,80)`, `courseId`, `courseName`).
4. **Role-check con helpers**: reemplazar `isAdmin/isDocente/isSuperAdmin` inline (`~214-223`)
   + el gate (`~594`) por `isStaffRole(roles)` / `isAdminLike(roles)` de `@/shared/lib/roles`
   (regla de CLAUDE.md). Auditar primero TODAS las referencias a esas 3 consts en el archivo
   antes de removerlas.

## 🔵 Menor
- Botón quitar-tag (`XIcon`, ~1053) sin `aria-label` → reusar patrón de `TagTextarea.tsx:266`.
- `last_used_at` se trackea + exporta a CSV pero no se muestra en el grid (posible `<DateCell>`).

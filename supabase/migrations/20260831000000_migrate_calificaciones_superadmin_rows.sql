-- ──────────────────────────────────────────────────────────────────────
-- Backfill: migrar filas huérfanas `module_visibility` donde
-- module_key='calificaciones' AND role='SuperAdmin'.
--
-- Causa: la fila virtual "Calificaciones" en el panel admin tenía
-- `roleKeyMap = { Admin: 'gradebook', Docente: 'gradebook',
-- Estudiante: 'grades' }` SIN entrada para SuperAdmin. Al togglear el
-- switch de la columna SA, `physicalKeyFor` fallback-eaba al `key`
-- virtual ('calificaciones'), persistiendo una fila con un module_key
-- que NINGUNA ruta del sidebar resuelve (todas mapean a 'gradebook' o
-- 'grades').
--
-- Síntoma reportado: el SA toggleaba "Calificaciones" off y el ítem
-- seguía visible. La fila persistida (`calificaciones, SuperAdmin,
-- false`) quedaba inerte mientras el sidebar leía el default true
-- para `gradebook.SuperAdmin` (sin fila explícita).
--
-- Fix (código): roleKeyMap ahora incluye `SuperAdmin: 'gradebook'`.
-- Fix (DB, este script): migrar las filas existentes — copiar a
-- `gradebook` y borrar las huérfanas — para preservar el toggle del
-- usuario sin requerir re-acción manual.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Copiar al module_key correcto. UPSERT por la unique (tenant_id,
--    module_key, role) — si ya existe una fila para
--    (tenant_id, 'gradebook', 'SuperAdmin'), preserva la más reciente
--    (mantengo `enabled` de la fila huérfana porque es el toggle que
--    el usuario tocó manualmente, mientras que `gradebook.SuperAdmin`
--    probablemente no existe o tiene el default).
INSERT INTO public.module_visibility (
  tenant_id, module_key, role, enabled, display_order, updated_by
)
SELECT
  tenant_id,
  'gradebook'::text AS module_key,
  'SuperAdmin'::text AS role,
  enabled,
  display_order,
  updated_by
FROM public.module_visibility
WHERE module_key = 'calificaciones'
  AND role = 'SuperAdmin'
ON CONFLICT (tenant_id, module_key, role) DO UPDATE
   SET enabled = EXCLUDED.enabled,
       display_order = EXCLUDED.display_order,
       updated_by = EXCLUDED.updated_by;

-- 2) Borrar las filas huérfanas con el module_key viejo.
DELETE FROM public.module_visibility
 WHERE module_key = 'calificaciones'
   AND role = 'SuperAdmin';

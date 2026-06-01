-- ──────────────────────────────────────────────────────────────────────
-- module_visibility: aceptar 'SuperAdmin' como valor de role.
--
-- Antes la matriz solo gobernaba Admin/Docente/Estudiante. El SuperAdmin
-- heredaba los items de Admin en el sidebar (`activeRole === SuperAdmin
-- && n.roles.includes("Admin") -> return true` en AppLayout), sin
-- forma de apagarlos individualmente. Ahora el SuperAdmin tiene su
-- propia columna en el panel y puede silenciar lo que no use (típico:
-- el módulo Académico de cada tenant — el SuperAdmin no lo gestiona
-- desde el rol propio).
--
-- Cambios:
--   1. CHECK del campo role pasa a aceptar 'SuperAdmin'.
--   2. NO seedeamos filas para SuperAdmin — el frontend trata "fila
--      ausente" como enabled=true (default visible). Si el SuperAdmin
--      apaga algo, se inserta la fila con enabled=false desde el panel.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Drop el CHECK constraint viejo (nombre auto-asignado por Postgres
--    = `<table>_<column>_check` cuando se declaró inline). Si fue
--    renombrado, usamos un loop defensivo igual que el patrón del
--    20260717 — busca cualquier check que mencione "role" + los tres
--    roles viejos y lo borra.
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  SELECT conname INTO v_constraint
  FROM pg_constraint
  WHERE conrelid = 'public.module_visibility'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%role%'
    AND pg_get_constraintdef(oid) ILIKE '%Admin%'
    AND pg_get_constraintdef(oid) ILIKE '%Docente%'
    AND pg_get_constraintdef(oid) ILIKE '%Estudiante%'
    -- Si ya tiene SuperAdmin, no hace falta tocarlo (re-run de migración).
    AND pg_get_constraintdef(oid) NOT ILIKE '%SuperAdmin%'
  LIMIT 1;
  IF v_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.module_visibility DROP CONSTRAINT %I', v_constraint);
  END IF;
END $$;

-- 2) Re-crear el CHECK con los 4 roles.
ALTER TABLE public.module_visibility
  ADD CONSTRAINT module_visibility_role_check
  CHECK (role IN ('Admin', 'Docente', 'Estudiante', 'SuperAdmin'));

NOTIFY pgrst, 'reload schema';

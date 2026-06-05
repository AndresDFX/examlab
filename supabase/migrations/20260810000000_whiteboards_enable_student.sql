-- ──────────────────────────────────────────────────────────────────────
-- Whiteboards: habilitar visibilidad del módulo para el rol Estudiante.
--
-- La migración 20260807000000 seedeó `module_visibility` con
-- whiteboards Estudiante=false (porque la vista del alumno no existía).
-- Ahora que `/app/student/whiteboards` está implementado (cards de las
-- pizarras compartidas por sus docentes con `is_shared_with_course=true`),
-- activamos el módulo para Estudiante.
--
-- Idempotente: UPDATE solo si la fila existe; si no existe (algún
-- tenant que ya borró el seed), agregamos UPSERT defensivo.
-- ──────────────────────────────────────────────────────────────────────

UPDATE public.module_visibility
SET enabled = true
WHERE tenant_id IS NULL
  AND module_key = 'whiteboards'
  AND role = 'Estudiante';

-- Defensa: si el seed no existía o se borró, lo creamos.
INSERT INTO public.module_visibility (tenant_id, module_key, role, enabled, display_order)
VALUES (NULL, 'whiteboards', 'Estudiante', true, 65)
ON CONFLICT (tenant_id, module_key, role) DO UPDATE SET enabled = true;

NOTIFY pgrst, 'reload schema';

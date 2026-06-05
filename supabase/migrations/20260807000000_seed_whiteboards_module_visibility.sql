-- ──────────────────────────────────────────────────────────────────────
-- Seed: módulo `whiteboards` en `module_visibility`.
--
-- El módulo "Pizarras" (ruta /app/teacher/whiteboards + editor en
-- /app/teacher/whiteboards/$id) existe pero no tenía fila base en
-- `module_visibility`. Sin fila el frontend lo trata como ENABLED por
-- default (compat), pero no aparece en el panel Admin "Visibilidad y
-- orden de módulos" ni participa del sort por display_order.
--
-- Defaults:
--   - Docente   enabled=true  (es su herramienta principal — Excalidraw
--                              embebido para explicar conceptos / pensar
--                              libremente / compartir con un curso).
--   - SuperAdmin enabled=true (acceso cross-tenant para asistir a
--                              docentes / probar la feature. El NAV
--                              también incluye SuperAdmin en `roles`).
--   - Admin     enabled=false (no opera pizarras del docente — el
--                              módulo es contenido del Docente, no
--                              gestión. Si quiere visibilidad sobre lo
--                              que cada docente crea, usa el panel
--                              cross-tenant del SuperAdmin).
--   - Estudiante enabled=false (la pizarra del alumno es read-only y
--                              vive dentro de la vista del curso, no
--                              como módulo del nav).
--
-- display_order = 65: ubicado en el bloque del docente, entre Talleres
-- (60) y Proyectos (70). Cuando el admin guarda desde el panel los
-- valores se renormalizan en múltiplos de 10 — el 65 solo importa
-- para el ranking inicial.
--
-- Idempotente vía ON CONFLICT. La migración 20260717000000 reemplazó el
-- PK natural `(module_key, role)` por un PK surrogate + UNIQUE NULLS NOT
-- DISTINCT en `(tenant_id, module_key, role)`. Por eso el ON CONFLICT
-- ataca esa terna; `tenant_id = NULL` ⇒ fila global (default de la
-- plataforma), que es donde queremos seedear.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO public.module_visibility (tenant_id, module_key, role, enabled, display_order)
VALUES
  (NULL, 'whiteboards', 'Docente',    true,  65),
  (NULL, 'whiteboards', 'SuperAdmin', true,  65),
  (NULL, 'whiteboards', 'Admin',      false, 65),
  (NULL, 'whiteboards', 'Estudiante', false, 65)
ON CONFLICT (tenant_id, module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';

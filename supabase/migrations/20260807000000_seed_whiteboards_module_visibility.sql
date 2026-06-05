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
--   - Admin     enabled=false (no opera pizarras del docente. Si lo
--                              activa, aparecerá pero la ruta no existe
--                              hoy para su rol — el Admin igual puede
--                              esconderla del Docente desde el panel).
--   - Estudiante enabled=false (la pizarra del alumno es read-only y
--                              vive dentro de la vista del curso, no
--                              como módulo del nav).
--   - SuperAdmin enabled=false (idem Admin — el módulo se gestiona por
--                              tenant a futuro).
--
-- display_order = 65: ubicado en el bloque del docente, entre Talleres
-- (60) y Proyectos (70). Cuando el admin guarda desde el panel los
-- valores se renormalizan en múltiplos de 10 — el 65 solo importa
-- para el ranking inicial.
--
-- Idempotente vía ON CONFLICT.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO public.module_visibility (module_key, role, enabled, display_order)
VALUES
  ('whiteboards', 'Docente',    true,  65),
  ('whiteboards', 'Admin',      false, 65),
  ('whiteboards', 'Estudiante', false, 65),
  ('whiteboards', 'SuperAdmin', false, 65)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';

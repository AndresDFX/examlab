-- ──────────────────────────────────────────────────────────────────────
-- Seed: módulo `statistics` en `module_visibility`.
--
-- El módulo Estadísticas (rutas /app/admin/statistics y
-- /app/teacher/statistics) existe en el código y en el NAV del sidebar
-- pero no tenía fila base en `module_visibility`. Sin fila el frontend
-- lo trata como ENABLED por default (compat), pero NO aparece en el
-- panel admin "Visibilidad y orden de módulos" ni participa del sort
-- por display_order. Esta migración lo registra explícitamente.
--
-- Defaults:
--   - Admin       enabled=true   (estadísticas agregadas de la plataforma)
--   - Docente     enabled=true   (estadísticas del/los curso(s) que enseña)
--   - Estudiante  enabled=false  (no tiene ruta /app/student/statistics —
--                                explicitamos para que NO aparezca como
--                                "visible" en el panel del admin)
--
-- display_order = 80: lo posicionamos antes de Prompts (85) y Cron (95)
-- en el NAV — Estadísticas pertenece al bloque "vista del docente sobre
-- sus cursos", junto a Gradebook/Asistencia/Calendario. Cuando el admin
-- guarde por primera vez desde el panel los valores se renormalizan a
-- múltiplos de 10 según el orden visual; el 80 solo importa para el
-- ranking inicial.
--
-- Idempotente vía ON CONFLICT.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO public.module_visibility (module_key, role, enabled, display_order)
VALUES
  ('statistics', 'Admin',      true,  80),
  ('statistics', 'Docente',    true,  80),
  ('statistics', 'Estudiante', false, 80)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';

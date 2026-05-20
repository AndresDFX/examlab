-- ──────────────────────────────────────────────────────────────────────
-- Seed: módulo `ai_cron` en `module_visibility`.
--
-- El módulo "Cron IA" (rutas /app/admin/ai-cron y /app/teacher/ai-cron)
-- existe pero no tenía fila base en `module_visibility`. Sin fila el
-- frontend lo trata como ENABLED por default (compat), pero no aparece
-- en el panel admin "Visibilidad y orden de módulos" ni participa del
-- sort por display_order. Esta migración lo registra explícitamente.
--
-- Defaults:
--   - Admin    enabled=true  (gestiona la cola IA + jobs Supabase)
--   - Docente  enabled=true  (ve la cola IA limitada a sus cursos vía RLS)
--   - Estudiante enabled=false (no tiene ruta /app/student/ai-cron, no
--                              le aplica — explicitamos para que no
--                              aparezca como "visible" en el panel).
--
-- display_order = 95: lo posicionamos justo después de Prompts IA en el
-- nav (Prompts queda como configuración, Cron como operacional). Cuando
-- el admin guarde por primera vez desde el panel, los valores se
-- renormalizan a múltiplos de 10 según el orden visual — el 95 solo
-- importa para el ranking inicial.
--
-- Idempotente vía ON CONFLICT.
-- ──────────────────────────────────────────────────────────────────────

INSERT INTO public.module_visibility (module_key, role, enabled, display_order)
VALUES
  ('ai_cron', 'Admin',      true,  95),
  ('ai_cron', 'Docente',    true,  95),
  ('ai_cron', 'Estudiante', false, 95)
ON CONFLICT (module_key, role) DO NOTHING;

NOTIFY pgrst, 'reload schema';

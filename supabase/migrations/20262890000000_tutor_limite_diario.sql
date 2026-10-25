-- ═══════════════════════════════════════════════════════════════════════
-- Asistente IA (Tutor IA): límite diario de preguntas por estudiante y curso
-- ═══════════════════════════════════════════════════════════════════════
--
-- Cada estudiante puede hacer hasta N preguntas al Tutor IA por curso y por
-- día calendario de Bogotá (se reinicia a las 12:00 a. m. hora Colombia). El
-- edge `tutor-chat` cuenta los mensajes role='user' de las sesiones del
-- estudiante en ese curso desde la medianoche de Bogotá y, si se alcanza el
-- tope, no procesa ni guarda ni cobra la pregunta.
--
-- Lo configura SOLO la institución (Admin del tenant; SuperAdmin cualquiera).
-- No hay override por curso. Se monta sobre `app_settings` (singleton POR
-- institución, con tenant_id, ya provisionado por `tg_provision_tenant_defaults`
-- —que hace INSERT (tenant_id), así que la columna nueva queda NULL sola— y ya
-- con RLS scopeada por tenant, legible por cualquier miembro). No hace falta
-- tabla, RLS, provisión ni backfill nuevos.
--
-- NULL = "usar el default del código" (25, en limite-diario.ts). El front y el
-- edge caen a ese default cuando la columna es NULL o inválida.
--
-- NO se agrega índice: el conteo filtra por (session_id, created_at) y ya existe
-- idx_tutor_chat_messages_session(session_id, created_at) (mig 20260521100000).
-- El filtro role='user' queda como residual sobre ese índice.
--
-- Nota defensiva: ALTER/COMMENT van DENTRO del guard para no abortar el deploy
-- si `app_settings` no existe en este entorno.

DO $$
BEGIN
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE NOTICE 'app_settings no existe; se omite tutor_daily_limit';
    RETURN;
  END IF;

  ALTER TABLE public.app_settings
    ADD COLUMN IF NOT EXISTS tutor_daily_limit INTEGER;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'app_settings_tutor_daily_limit_range'
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_tutor_daily_limit_range
      CHECK (
        tutor_daily_limit IS NULL
        OR (tutor_daily_limit >= 1 AND tutor_daily_limit <= 500)
      );
  END IF;

  COMMENT ON COLUMN public.app_settings.tutor_daily_limit IS
    'Tutor IA: preguntas por día (Bogotá) por estudiante y curso. NULL = default del código (25). Rango 1..500.';
END $$;

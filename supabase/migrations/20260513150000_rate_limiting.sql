-- ──────────────────────────────────────────────────────────────────────
-- Rate limiting básico para endpoints de IA. Razón: hoy un docente
-- puede disparar `ai-generate-questions` o `ai-grade-submission` en loop
-- (script, cliente roto, etc.) y consumir todos los créditos de IA del
-- proyecto en minutos. Esta migración agrega un check server-side por
-- usuario + acción + ventana deslizante.
--
-- Diseño:
--   * Tabla `rate_limit_events(actor_id, action, created_at)` append-only.
--   * RPC `check_rate_limit(p_action, p_max, p_window_seconds)` que:
--       1. Cuenta cuántos eventos `p_action` tiene `auth.uid()` en los
--          últimos `p_window_seconds`.
--       2. Si supera `p_max` devuelve `{ ok:false, remaining:0, retry_after }`.
--       3. Si pasa, INSERTA un nuevo evento y devuelve `{ ok:true, remaining }`.
--   * Cleanup periódico: índice + un cron borraría eventos viejos. Por
--     ahora dejamos solo el índice — Postgres aguanta miles de filas y
--     el filtro `created_at >= now() - window` no escanea full table.
--
-- Las edge functions llaman al RPC con el JWT del usuario. Estudiantes
-- nunca tocan estos endpoints, así que limitamos solo Docente/Admin.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.rate_limit_events (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice optimizado para el query del check: por (actor, action, time DESC).
CREATE INDEX IF NOT EXISTS rate_limit_events_actor_action_idx
  ON public.rate_limit_events(actor_id, action, created_at DESC);

ALTER TABLE public.rate_limit_events ENABLE ROW LEVEL SECURITY;
-- Sin políticas = nadie lee/escribe directo. Solo el RPC SECURITY DEFINER.

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_action          TEXT,
  p_max             INT,
  p_window_seconds  INT
)
RETURNS jsonb
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
DECLARE
  v_uid     uuid := auth.uid();
  v_count   int;
  v_oldest  timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthenticated', 'remaining', 0);
  END IF;

  -- Cuenta eventos dentro de la ventana.
  SELECT count(*), min(created_at)
    INTO v_count, v_oldest
    FROM public.rate_limit_events
    WHERE actor_id = v_uid
      AND action = p_action
      AND created_at >= now() - make_interval(secs => p_window_seconds);

  IF v_count >= p_max THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'rate_limited',
      'remaining', 0,
      'retry_after_seconds',
        GREATEST(
          1,
          extract(epoch FROM (v_oldest + make_interval(secs => p_window_seconds) - now()))::int
        ),
      'limit', p_max,
      'window_seconds', p_window_seconds
    );
  END IF;

  INSERT INTO public.rate_limit_events (actor_id, action) VALUES (v_uid, p_action);

  RETURN jsonb_build_object(
    'ok', true,
    'remaining', p_max - v_count - 1,
    'limit', p_max,
    'window_seconds', p_window_seconds
  );
END;
$$;

-- Solo callable por usuarios autenticados — anon no debería poder
-- consumir el contador de otros.
REVOKE ALL ON FUNCTION public.check_rate_limit(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_rate_limit(text, int, int) TO authenticated, service_role;

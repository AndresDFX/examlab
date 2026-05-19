-- ──────────────────────────────────────────────────────────────────────
-- Cap de mensajes por activación de override IA inmediata.
--
-- Hoy los códigos override tienen DOS dimensiones de control:
--   - `window_minutes`            → cuánto dura la ventana sync (tiempo)
--   - `max_uses` / `uses_count`   → cuántas veces se puede ACTIVAR
--
-- Falta la tercera: cuántas calificaciones IA puede consumir UNA
-- activación. Sin esto, un código de 1h podría disparar cientos de
-- llamadas sync a Gemini si el docente recalifica todo un curso —
-- agotando la cuota o sumando costos no presupuestados.
--
-- Modelo:
--   - `ai_override_codes.max_messages_per_activation` (INT, nullable)
--     NULL = sin tope (comportamiento previo, se mantiene compat).
--     N    = la activación caduca cuando `messages_consumed >= N`.
--   - `ai_override_activations.messages_consumed` (INT, default 0)
--     Counter atómico, incrementado por `claim_ai_override_message`.
--
-- Helper `has_active_ai_override` mantiene la firma `RETURNS TIMESTAMPTZ`
-- por compat con el código actual — devuelve NULL si la activación más
-- reciente alcanzó su cap (igual que si hubiera expirado por tiempo).
--
-- Nuevo RPC `claim_ai_override_message`: lo llama el cliente JUSTO
-- antes de cada invocación sync por override. Atómico — usa UPDATE
-- ... RETURNING para verificar cap + incrementar en una sola tx
-- (evita race entre dos pestañas del mismo docente).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.ai_override_codes
  ADD COLUMN IF NOT EXISTS max_messages_per_activation INT
    CHECK (max_messages_per_activation IS NULL OR max_messages_per_activation BETWEEN 1 AND 10000);

COMMENT ON COLUMN public.ai_override_codes.max_messages_per_activation IS
  'Cap de mensajes IA (calificaciones) que cada activación puede consumir antes de caer en async. NULL = sin tope.';

ALTER TABLE public.ai_override_activations
  ADD COLUMN IF NOT EXISTS messages_consumed INT NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.ai_override_activations.messages_consumed IS
  'Cuántos mensajes IA sync se han consumido en esta activación. Incrementado por claim_ai_override_message en cada llamada sync por override.';

-- ─── Helper: ¿tiene override activo? (con cap aplicado) ───────────────
-- Override sigue el modelo: la activación más reciente del user es la
-- que cuenta. Si esa activación está expirada por tiempo OR alcanzó
-- el cap, retorna NULL — el cliente cae a async como si no tuviera
-- override.
CREATE OR REPLACE FUNCTION public.has_active_ai_override()
RETURNS TIMESTAMPTZ
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH latest AS (
    SELECT a.expires_at, a.messages_consumed, c.max_messages_per_activation
    FROM public.ai_override_activations a
    JOIN public.ai_override_codes c ON c.id = a.code_id
    WHERE a.user_id = auth.uid() AND a.expires_at > now()
    ORDER BY a.activated_at DESC
    LIMIT 1
  )
  SELECT expires_at
  FROM latest
  WHERE max_messages_per_activation IS NULL
     OR messages_consumed < max_messages_per_activation;
$$;

REVOKE ALL ON FUNCTION public.has_active_ai_override() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_active_ai_override() TO authenticated;

-- ─── Claim atómico de un mensaje ──────────────────────────────────────
-- Devuelve TRUE si reservó 1 mensaje exitosamente (override activo,
-- dentro del cap si aplica). Devuelve FALSE si:
--   - No hay activación vigente para el caller.
--   - La activación expiró por tiempo.
--   - El cap ya está agotado.
--
-- El UPDATE es la única forma de incrementar `messages_consumed` —
-- así garantizamos que el contador refleja consumo real y no estimación
-- del cliente.
CREATE OR REPLACE FUNCTION public.claim_ai_override_message()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _activation_id UUID;
  _cap INT;
  _consumed INT;
  _expires TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'unauthenticated');
  END IF;

  -- Selección con FOR UPDATE evita race entre dos requests concurrentes
  -- del mismo user (e.g. dos pestañas calificando en paralelo).
  SELECT a.id, c.max_messages_per_activation, a.messages_consumed, a.expires_at
    INTO _activation_id, _cap, _consumed, _expires
    FROM public.ai_override_activations a
    JOIN public.ai_override_codes c ON c.id = a.code_id
   WHERE a.user_id = auth.uid() AND a.expires_at > now()
   ORDER BY a.activated_at DESC
   LIMIT 1
   FOR UPDATE OF a;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'no_active_override');
  END IF;

  -- Cap NULL = ilimitado (legacy + valor por defecto).
  IF _cap IS NOT NULL AND _consumed >= _cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cap_reached', 'consumed', _consumed, 'cap', _cap);
  END IF;

  UPDATE public.ai_override_activations
     SET messages_consumed = messages_consumed + 1
   WHERE id = _activation_id;

  RETURN jsonb_build_object(
    'ok', true,
    'consumed', _consumed + 1,
    'cap', _cap,
    'remaining', CASE WHEN _cap IS NULL THEN NULL ELSE _cap - (_consumed + 1) END,
    'expires_at', _expires
  );
END
$$;

REVOKE ALL ON FUNCTION public.claim_ai_override_message() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_ai_override_message() TO authenticated;

-- ─── Helper de lectura: estado de la activación actual ────────────────
-- Para que el cliente pueda mostrar "Te quedan X/Y mensajes" sin
-- consumir. Devuelve la activación más reciente vigente con todos los
-- counts. Si no hay vigente, todos los campos NULL.
CREATE OR REPLACE FUNCTION public.current_ai_override_status()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH latest AS (
    SELECT a.expires_at, a.messages_consumed, c.max_messages_per_activation, c.window_minutes
    FROM public.ai_override_activations a
    JOIN public.ai_override_codes c ON c.id = a.code_id
    WHERE a.user_id = auth.uid() AND a.expires_at > now()
    ORDER BY a.activated_at DESC
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'active', CASE WHEN expires_at IS NULL THEN false
                   WHEN max_messages_per_activation IS NOT NULL
                        AND messages_consumed >= max_messages_per_activation THEN false
                   ELSE true END,
    'expires_at', expires_at,
    'window_minutes', window_minutes,
    'consumed', messages_consumed,
    'cap', max_messages_per_activation,
    'remaining', CASE WHEN max_messages_per_activation IS NULL THEN NULL
                      ELSE max_messages_per_activation - messages_consumed END
  )
  FROM latest;
$$;

REVOKE ALL ON FUNCTION public.current_ai_override_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_ai_override_status() TO authenticated;

-- ─── Update activate_ai_override para incluir cap en la respuesta ─────
-- El RPC existente devuelve `{ok, expires_at, window_minutes}`. Lo
-- extendemos con `max_messages_per_activation` y `remaining` para que
-- el cliente arme el state local sin un round-trip extra.
CREATE OR REPLACE FUNCTION public.activate_ai_override(_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _code_row  RECORD;
  _expires   TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin')) THEN
    RAISE EXCEPTION 'Solo Docente o Admin pueden activar override';
  END IF;

  SELECT * INTO _code_row
  FROM public.ai_override_codes
  WHERE code = _code AND revoked_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;
  IF _code_row.expires_at IS NOT NULL AND _code_row.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;
  IF _code_row.uses_count >= _code_row.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exhausted');
  END IF;

  _expires := now() + (_code_row.window_minutes || ' minutes')::interval;

  UPDATE public.ai_override_codes
     SET uses_count = uses_count + 1
   WHERE id = _code_row.id;

  INSERT INTO public.ai_override_activations (code_id, user_id, expires_at)
  VALUES (_code_row.id, auth.uid(), _expires);

  RETURN jsonb_build_object(
    'ok', true,
    'expires_at', _expires,
    'window_minutes', _code_row.window_minutes,
    'max_messages_per_activation', _code_row.max_messages_per_activation,
    'remaining', _code_row.max_messages_per_activation
  );
END
$$;

REVOKE ALL ON FUNCTION public.activate_ai_override(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.activate_ai_override(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

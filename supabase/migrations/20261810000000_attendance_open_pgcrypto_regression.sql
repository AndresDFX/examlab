-- ══════════════════════════════════════════════════════════════════════
-- Arregla `function gen_random_bytes(integer) does not exist` al iniciar el
-- check-in con QR.
--
-- ── Qué pasó ──────────────────────────────────────────────────────────
-- En Supabase pgcrypto vive en el schema `extensions`, así que una función
-- SECURITY DEFINER con `SET search_path = public` NO resuelve
-- `gen_random_bytes`. Eso ya se había arreglado en mayo:
-- `20260507100100_attendance_check_in_pgcrypto_fix.sql` reescribió
-- `teacher_open_attendance_check_in` con `search_path = public, extensions` y
-- `extensions.gen_random_bytes(16)`.
--
-- Y ese arreglo se DESHIZO: la migración 20261750000000 (modo "solo correo")
-- reescribió la función completa copiando la versión ANTERIOR al fix —con
-- `SET search_path = public` y la llamada sin prefijo— y 20261800000000 (topes
-- más largos) arrastró lo mismo. Desde entonces, iniciar el check-in fallaba.
--
-- La lección, que es la que importa: al reescribir una función con CREATE OR
-- REPLACE hay que partir de la versión VIGENTE en la base, no de la primera que
-- aparece en el repositorio buscando por nombre. Una migración posterior pudo
-- haberla corregido, y copiar la vieja revierte ese arreglo en silencio — no
-- falla al aplicar, falla cuando alguien usa la función.
--
-- Se restaura `search_path = public, extensions` + `extensions.gen_random_bytes`,
-- conservando todo lo que sí aportaron las dos migraciones intermedias: el
-- parámetro `p_email_only`, la acotación por institución
-- (`attendance_session_in_my_tenant`) y los topes de 1440 min / 7200 s.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.teacher_open_attendance_check_in(
  p_session_id uuid,
  p_duration_minutes int DEFAULT 10,
  p_rotation_seconds int DEFAULT 60,
  p_email_only boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
-- `extensions` en el search_path: sin esto, `gen_random_bytes` no resuelve.
SET search_path = public, extensions AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_session public.attendance_sessions%ROWTYPE;
  v_seed text;
  v_closes_at timestamptz;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF NOT (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'Docente')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  IF NOT public.attendance_session_in_my_tenant(p_session_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  SELECT * INTO v_session FROM public.attendance_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'session_not_found');
  END IF;
  IF p_duration_minutes < 1 OR p_duration_minutes > 1440 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_duration');
  END IF;
  IF p_rotation_seconds < 15 OR p_rotation_seconds > 7200 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_rotation');
  END IF;

  -- Con prefijo explícito, además del search_path: cinturón y tirantes, porque
  -- este es el tercer intento de que esta línea quede bien.
  v_seed := encode(extensions.gen_random_bytes(16), 'hex');
  v_closes_at := now() + (p_duration_minutes || ' minutes')::interval;

  INSERT INTO public.attendance_check_in_state
    (session_id, seed, rotation_seconds, opened_at, closes_at, email_only)
  VALUES (p_session_id, v_seed, p_rotation_seconds, now(), v_closes_at, coalesce(p_email_only, false))
  ON CONFLICT (session_id) DO UPDATE
    SET seed = EXCLUDED.seed,
        rotation_seconds = EXCLUDED.rotation_seconds,
        opened_at = EXCLUDED.opened_at,
        closes_at = EXCLUDED.closes_at,
        email_only = EXCLUDED.email_only;

  UPDATE public.attendance_sessions SET check_in_open = true WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    'seed', v_seed,
    'rotation_seconds', p_rotation_seconds,
    'opened_at', now(),
    'closes_at', v_closes_at,
    'email_only', coalesce(p_email_only, false)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, int, int, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_open_attendance_check_in(uuid, int, int, boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_open_attendance_check_in(uuid, int, int, boolean) TO authenticated;

-- ── Y la otra que tenía el mismo defecto ──────────────────────────────
-- Barriendo TODAS las migraciones por funciones vigentes que llaman a pgcrypto
-- sin `extensions` en el search_path apareció una más: `poll_set_public`, la
-- que genera el token del enlace público de una encuesta. Nadie la había
-- reportado porque el único enlace público que existe se creó por otra vía;
-- desde la app habría fallado igual que el check-in. Se arregla acá y no en su
-- migración original, que ya está aplicada.

CREATE OR REPLACE FUNCTION public.poll_set_public(
  _poll_id UUID,
  _enabled BOOLEAN,
  _regenerate BOOLEAN DEFAULT FALSE
)
RETURNS TEXT
LANGUAGE plpgsql
-- `extensions` en el search_path + prefijo explícito: pgcrypto vive en ese
-- schema y sin esto `gen_random_bytes` no resuelve (el mismo error que rompía
-- el check-in con QR).
SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_poll  public.polls;
  v_token TEXT;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_poll FROM public.polls WHERE id = _poll_id AND deleted_at IS NULL;
  IF v_poll.id IS NULL THEN
    RAISE EXCEPTION 'Encuesta inexistente' USING ERRCODE = '22023';
  END IF;

  -- Solo el docente del curso ancla, un docente de un curso vinculado, o un
  -- Admin de la MISMA institución. La rama de Admin va con scope de tenant a
  -- propósito: `has_role` es global y sin el scope un Admin de otra institución
  -- podría publicar esta encuesta.
  IF NOT (
        public._poll_anchor_teacher(_poll_id, v_uid)
     OR public._poll_linked_teacher(_poll_id, v_uid)
     OR (
          (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'SuperAdmin'))
          AND public.course_in_my_tenant(v_poll.course_id)
        )
  ) THEN
    RAISE EXCEPTION 'No puedes cambiar el enlace público de esta encuesta' USING ERRCODE = '42501';
  END IF;

  -- Mismo límite que el CHECK, pero con un mensaje que el docente entiende:
  -- una violación de CHECK saldría como 23514 y friendlyError la traduce a algo
  -- genérico.
  IF _enabled AND v_poll.poll_type <> 'mixed' THEN
    RAISE EXCEPTION 'Solo las encuestas con preguntas propias se pueden compartir por enlace público'
      USING ERRCODE = 'P0001';
  END IF;

  v_token := v_poll.public_token;
  IF _enabled AND (v_token IS NULL OR _regenerate) THEN
    v_token := encode(extensions.gen_random_bytes(16), 'hex');
  END IF;

  UPDATE public.polls
     SET public_enabled = _enabled,
         public_token   = CASE WHEN _enabled THEN v_token ELSE public_token END,
         updated_at     = now()
   WHERE id = _poll_id;

  RETURN CASE WHEN _enabled THEN v_token ELSE NULL END;
END;
$$;

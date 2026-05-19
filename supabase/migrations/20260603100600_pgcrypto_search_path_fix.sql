-- ──────────────────────────────────────────────────────────────────────
-- Fix: `function gen_random_bytes(integer) does not exist`.
--
-- En Supabase moderno la extensión `pgcrypto` vive en el schema
-- `extensions`, NO en `public`. Cualquier función SECURITY DEFINER que
-- declare `SET search_path = public` no la encuentra y aborta con el
-- error de arriba.
--
-- Los puntos afectados que reporta el usuario:
--   - Calendario del estudiante (`get_or_create_calendar_token`,
--     `regenerate_calendar_token`).
--   - Emisión de certificados (`issue_certificate`).
--
-- Solución uniforme: re-declaramos las funciones con
--   SET search_path = public, extensions
-- y prefijo explícito `extensions.gen_random_bytes(...)`. El mismo
-- patrón se aplicó en 20260507100100 para attendance — esto extiende
-- la corrección al resto de las funciones que la heredan.
-- ──────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ── Calendario externo del estudiante ──
CREATE OR REPLACE FUNCTION public.get_or_create_calendar_token()
RETURNS TABLE(token text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _user uuid := auth.uid();
  _row record;
  _new_token text;
  i INT;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT t.token, t.created_at INTO _row
    FROM public.student_calendar_tokens t
    WHERE t.user_id = _user AND t.revoked_at IS NULL
    LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT _row.token, _row.created_at;
    RETURN;
  END IF;

  FOR i IN 1..10 LOOP
    _new_token := translate(
      encode(extensions.gen_random_bytes(24), 'base64'),
      '+/=', '-_'
    );
    _new_token := substring(_new_token, 1, 32);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.student_calendar_tokens WHERE token = _new_token
    );
  END LOOP;

  INSERT INTO public.student_calendar_tokens (user_id, token)
    VALUES (_user, _new_token);

  RETURN QUERY SELECT _new_token, now();
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_or_create_calendar_token() TO authenticated;

CREATE OR REPLACE FUNCTION public.regenerate_calendar_token()
RETURNS TABLE(token text, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _user uuid := auth.uid();
  _new_token text;
  i INT;
BEGIN
  IF _user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  UPDATE public.student_calendar_tokens
     SET revoked_at = now()
   WHERE user_id = _user AND revoked_at IS NULL;

  FOR i IN 1..10 LOOP
    _new_token := translate(
      encode(extensions.gen_random_bytes(24), 'base64'),
      '+/=', '-_'
    );
    _new_token := substring(_new_token, 1, 32);
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.student_calendar_tokens WHERE token = _new_token
    );
  END LOOP;

  INSERT INTO public.student_calendar_tokens (user_id, token)
    VALUES (_user, _new_token);

  RETURN QUERY SELECT _new_token, now();
END;
$$;

REVOKE ALL ON FUNCTION public.regenerate_calendar_token() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.regenerate_calendar_token() TO authenticated;

-- ── Emisión de certificados ──
-- Re-creamos la función con el search_path corregido + prefijo explícito.
-- El cuerpo es idéntico al de 20260603100500 (snapshot completo de
-- settings, fix de la columna `identification`). Cambiar el body en ese
-- punto requiere replicar acá si se vuelve a recrear.
DROP FUNCTION IF EXISTS public.issue_certificate(UUID, UUID, NUMERIC);

CREATE OR REPLACE FUNCTION public.issue_certificate(
  _user_id UUID,
  _course_id UUID,
  _final_grade NUMERIC
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _student       RECORD;
  _course        RECORD;
  _teacher_names TEXT[];
  _settings      RECORD;
  _short         TEXT;
  _hash          TEXT;
  _new_id        UUID;
  i              INT;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'Admin') OR EXISTS (
    SELECT 1 FROM public.course_teachers WHERE course_id = _course_id AND user_id = auth.uid()
  )) THEN
    RAISE EXCEPTION 'No autorizado para emitir certificados de este curso';
  END IF;

  SELECT id, full_name, institutional_email INTO _student
    FROM public.profiles WHERE id = _user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Estudiante no encontrado'; END IF;

  SELECT id, name, period, grade_scale_max, passing_grade INTO _course
    FROM public.courses WHERE id = _course_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Curso no encontrado'; END IF;

  IF _final_grade < _course.passing_grade THEN
    RAISE EXCEPTION 'La nota final % está por debajo de la mínima aprobatoria %',
      _final_grade, _course.passing_grade;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.certificates
    WHERE user_id = _user_id AND course_id = _course_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Ya existe un certificado vigente para este estudiante en este curso';
  END IF;

  SELECT array_agg(COALESCE(p.full_name, 'Docente') ORDER BY p.full_name)
    INTO _teacher_names
    FROM public.course_teachers ct
    JOIN public.profiles p ON p.id = ct.user_id
    WHERE ct.course_id = _course_id;

  SELECT * INTO _settings FROM public.resolve_certificate_settings(_course_id);

  FOR i IN 1..10 LOOP
    _short := upper(
      translate(
        encode(extensions.gen_random_bytes(8), 'base64'),
        '/+=', 'XYZ'
      )
    );
    _short := regexp_replace(_short, '[^A-Z0-9]', '', 'g');
    _short := substring(_short, 1, 12);
    EXIT WHEN length(_short) = 12 AND NOT EXISTS (
      SELECT 1 FROM public.certificates WHERE short_code = _short
    );
  END LOOP;

  IF length(_short) <> 12 THEN
    RAISE EXCEPTION 'No se pudo generar un short_code único';
  END IF;

  _hash := encode(
    extensions.digest(
      _short || '|' || _user_id::text || '|' || _course_id::text || '|' ||
      _student.full_name || '|' || _course.name || '|' ||
      _final_grade::text || '|' || _course.grade_scale_max::text || '|' ||
      now()::text,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO public.certificates (
    short_code, user_id, course_id,
    student_full_name, student_identification,
    course_name, course_period,
    final_grade, grade_scale_max, passing_grade,
    teacher_names, university_name, university_logo_url,
    signature_name, signature_title, signature_image_url,
    certificate_message, footer_text,
    issued_by, payload_hash
  ) VALUES (
    _short, _user_id, _course_id,
    _student.full_name, _student.institutional_email,
    _course.name, _course.period,
    _final_grade, _course.grade_scale_max, _course.passing_grade,
    COALESCE(_teacher_names, '{}'::text[]),
    _settings.institution_name, _settings.institution_logo_url,
    _settings.signature_name, _settings.signature_title, _settings.signature_image_url,
    _settings.certificate_message, _settings.footer_text,
    auth.uid(), _hash
  ) RETURNING id INTO _new_id;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    _user_id,
    'Tu certificado del curso "' || _course.name || '" está disponible',
    'Ya puedes descargar tu certificado de finalización en formato PDF.',
    'certificate',
    '/app/certificates'
  );

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.issue_certificate(UUID, UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_certificate(UUID, UUID, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';

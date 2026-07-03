-- ══════════════════════════════════════════════════════════════════════
-- issue_certificate: la notificación al estudiante apuntaba a /app/certificates
-- (vista de Admin/Docente, bloqueada por RBAC para el estudiante) → al hacer
-- click caía en /app/unauthorized. Sus certificados viven en
-- /app/student/certificates (igual que revoke_certificate y las versiones
-- previas 20260518140000/20260525100000). Regresión introducida en
-- 20260603100500 y arrastrada por 20261045000000.
--
-- Reproduce la firma/cuerpo de 20261045000000 VERBATIM cambiando SOLO el literal
-- del link del INSERT de notificación. No toca authz, matrícula, short_code, hash
-- ni el INSERT del certificado.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.issue_certificate(_user_id uuid, _course_id uuid, _final_grade numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  IF NOT (public.is_admin_of_course_tenant(_course_id) OR EXISTS (
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
  IF NOT EXISTS (
    SELECT 1 FROM public.course_enrollments
    WHERE course_id = _course_id AND user_id = _user_id
  ) THEN
    RAISE EXCEPTION 'El estudiante no está matriculado en este curso';
  END IF;
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
    '/app/student/certificates'
  );
  RETURN _new_id;
END
$function$;

NOTIFY pgrst, 'reload schema';

-- ──────────────────────────────────────────────────────────────────────
-- Fix de bug + ampliación del snapshot de certificados.
--
-- Dos problemas resueltos en una sola migración:
--
--  1) BUG bloqueante en `issue_certificate`:
--     SELECT id, full_name, identification ... — la columna `identification`
--     NUNCA existió en `public.profiles` (sus columnas son id/full_name/
--     personal_email/institutional_email). Cuando el docente clickea
--     "Emitir certificado" la función falla con:
--       column "identification" does not exist
--     y no se emite. Reemplazamos por `institutional_email` que sí existe.
--
--  2) Snapshot de settings incompleto:
--     `certificates` solo guardaba `university_name` + `university_logo_url`.
--     El admin (y/o el docente por curso) configuran adicionalmente
--     `signature_name`, `signature_title`, `signature_image_url`,
--     `certificate_message` y `footer_text` — pero esos campos nunca se
--     snapshotean al emitir y el PDF nunca los muestra. Resultado: la
--     configuración del admin no surte efecto.
--
--     Agregamos esas 5 columnas al snapshot y las poblamos desde
--     `resolve_certificate_settings(course_id)` (que ya hace el merge
--     course-override > global > legacy).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.certificates
  ADD COLUMN IF NOT EXISTS signature_name TEXT,
  ADD COLUMN IF NOT EXISTS signature_title TEXT,
  ADD COLUMN IF NOT EXISTS signature_image_url TEXT,
  ADD COLUMN IF NOT EXISTS certificate_message TEXT,
  ADD COLUMN IF NOT EXISTS footer_text TEXT;

COMMENT ON COLUMN public.certificates.signature_name IS
  'Snapshot del nombre de quien firma (ej. "Juan Pérez"). Resuelto desde resolve_certificate_settings al emitir.';
COMMENT ON COLUMN public.certificates.signature_title IS
  'Snapshot del cargo de quien firma (ej. "Decano de Ingeniería").';
COMMENT ON COLUMN public.certificates.signature_image_url IS
  'URL de la imagen de firma (PNG/SVG con fondo transparente).';
COMMENT ON COLUMN public.certificates.certificate_message IS
  'Texto principal personalizable del cuerpo. Soporta placeholders {student}, {course}, {grade}, {period}, {teacher}, {date}.';
COMMENT ON COLUMN public.certificates.footer_text IS
  'Pie de página opcional. La URL de verificación se anexa siempre.';

-- ── Recrear issue_certificate con el fix + snapshot completo ──
DROP FUNCTION IF EXISTS public.issue_certificate(UUID, UUID, NUMERIC);

CREATE OR REPLACE FUNCTION public.issue_certificate(
  _user_id UUID,
  _course_id UUID,
  _final_grade NUMERIC
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Antes leíamos `identification` que no existe en profiles. Usamos
  -- `institutional_email` como identificador secundario opcional —
  -- aparece en el PDF si el docente lo quiere mostrar, o se ignora.
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

  -- Resolver settings efectivas (course override > global > legacy)
  SELECT * INTO _settings FROM public.resolve_certificate_settings(_course_id);

  FOR i IN 1..10 LOOP
    _short := upper(
      translate(
        encode(gen_random_bytes(8), 'base64'),
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
    digest(
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

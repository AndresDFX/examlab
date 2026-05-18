-- ──────────────────────────────────────────────────────────────────────
-- Configuración de certificaciones — global (Admin) + override por curso (Docente).
--
-- Flujo de resolución al emitir certificado:
--   course_certificate_settings (curso)
--     → certificate_settings (global)
--     → content_brand_config (legacy, backward compat)
--     → defaults hardcodeados en el PDF generator
--
-- Campos:
--   - institution_name        Nombre que aparece en el header del cert.
--   - institution_logo_url    URL del logo institucional (PNG/SVG/JPG).
--   - signature_name          Nombre de quien firma (Decano, Director, etc.).
--   - signature_title         Cargo de quien firma.
--   - signature_image_url     Imagen de la firma (PNG con fondo transparente).
--   - certificate_message     Texto principal del certificado (puede tener placeholders {student}, {course}, {grade}).
--   - footer_text             Pie de página opcional (URL de verificación se anexa siempre).
--
-- RLS:
--   - certificate_settings: SELECT abierto a authenticated (los nombres
--     son públicos cuando aparecen en el PDF descargado); WRITE solo Admin.
--   - course_certificate_settings: SELECT abierto a authenticated;
--     WRITE solo docentes del curso (course_teachers) o Admin.
-- ──────────────────────────────────────────────────────────────────────

-- ── Singleton global (Admin) ──
CREATE TABLE IF NOT EXISTS public.certificate_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_name      TEXT,
  institution_logo_url  TEXT,
  signature_name        TEXT,
  signature_title       TEXT,
  signature_image_url   TEXT,
  certificate_message   TEXT,
  footer_text           TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS certificate_settings_singleton
  ON public.certificate_settings ((true));

INSERT INTO public.certificate_settings DEFAULT VALUES
ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS trg_certificate_settings_updated_at ON public.certificate_settings;
CREATE TRIGGER trg_certificate_settings_updated_at
  BEFORE UPDATE ON public.certificate_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.certificate_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "certificate_settings_select" ON public.certificate_settings;
CREATE POLICY "certificate_settings_select"
  ON public.certificate_settings FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "certificate_settings_write" ON public.certificate_settings;
CREATE POLICY "certificate_settings_write"
  ON public.certificate_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ── Override por curso (Docente del curso o Admin) ──
CREATE TABLE IF NOT EXISTS public.course_certificate_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL UNIQUE REFERENCES public.courses(id) ON DELETE CASCADE,
  institution_name      TEXT,
  institution_logo_url  TEXT,
  signature_name        TEXT,
  signature_title       TEXT,
  signature_image_url   TEXT,
  certificate_message   TEXT,
  footer_text           TEXT,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

DROP TRIGGER IF EXISTS trg_course_certificate_settings_updated_at ON public.course_certificate_settings;
CREATE TRIGGER trg_course_certificate_settings_updated_at
  BEFORE UPDATE ON public.course_certificate_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.course_certificate_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ccs_select" ON public.course_certificate_settings;
CREATE POLICY "ccs_select"
  ON public.course_certificate_settings FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "ccs_write" ON public.course_certificate_settings;
CREATE POLICY "ccs_write"
  ON public.course_certificate_settings FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_certificate_settings.course_id
        AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_certificate_settings.course_id
        AND ct.user_id = auth.uid()
    )
  );

-- ── RPC: resolver settings efectivos para un curso ──
-- Devuelve el merge de course override + global + legacy content_brand_config.
-- El llamador (issue_certificate, panel docente "Vista previa") usa esto para
-- ver qué se va a aplicar sin duplicar la lógica de fallback en cada caller.
CREATE OR REPLACE FUNCTION public.resolve_certificate_settings(_course_id UUID)
RETURNS TABLE (
  institution_name      TEXT,
  institution_logo_url  TEXT,
  signature_name        TEXT,
  signature_title       TEXT,
  signature_image_url   TEXT,
  certificate_message   TEXT,
  footer_text           TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _global  RECORD;
  _course  RECORD;
  _legacy  RECORD;
BEGIN
  SELECT * INTO _global FROM public.certificate_settings LIMIT 1;
  SELECT * INTO _course FROM public.course_certificate_settings WHERE course_id = _course_id;
  SELECT university_name, logo_url INTO _legacy FROM public.content_brand_config LIMIT 1;

  RETURN QUERY SELECT
    COALESCE(_course.institution_name,     _global.institution_name,     _legacy.university_name),
    COALESCE(_course.institution_logo_url, _global.institution_logo_url, _legacy.logo_url),
    COALESCE(_course.signature_name,       _global.signature_name),
    COALESCE(_course.signature_title,      _global.signature_title),
    COALESCE(_course.signature_image_url,  _global.signature_image_url),
    COALESCE(_course.certificate_message,  _global.certificate_message),
    COALESCE(_course.footer_text,          _global.footer_text);
END
$$;

REVOKE ALL ON FUNCTION public.resolve_certificate_settings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_certificate_settings(UUID) TO authenticated;

-- ── Actualizar issue_certificate para usar las settings efectivas ──
-- Reemplazamos la lectura directa de content_brand_config con un join al
-- nuevo RPC. Preservamos el resto del comportamiento (snapshot inmutable).
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
  _student      RECORD;
  _course       RECORD;
  _teacher_names TEXT[];
  _settings     RECORD;
  _short        TEXT;
  _hash         TEXT;
  _new_id       UUID;
  i             INT;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'Admin') OR EXISTS (
    SELECT 1 FROM public.course_teachers WHERE course_id = _course_id AND user_id = auth.uid()
  )) THEN
    RAISE EXCEPTION 'No autorizado para emitir certificados de este curso';
  END IF;

  SELECT id, full_name, identification INTO _student
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
    issued_by, payload_hash
  ) VALUES (
    _short, _user_id, _course_id,
    _student.full_name, _student.identification,
    _course.name, _course.period,
    _final_grade, _course.grade_scale_max, _course.passing_grade,
    COALESCE(_teacher_names, '{}'::text[]),
    _settings.institution_name, _settings.institution_logo_url,
    auth.uid(), _hash
  ) RETURNING id INTO _new_id;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    _user_id,
    'Tu certificado del curso "' || _course.name || '" está disponible',
    'Ya puedes descargar tu certificado de finalización en formato PDF.',
    'grade',
    '/app/student/certificates'
  );

  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.issue_certificate(UUID, UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_certificate(UUID, UUID, NUMERIC) TO authenticated;

NOTIFY pgrst, 'reload schema';

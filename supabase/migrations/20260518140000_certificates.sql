-- ──────────────────────────────────────────────────────────────────────
-- Certificados verificables con QR.
--
-- Concepto:
--   - El docente o admin emite un certificado al finalizar un curso
--     (cuando la nota final del estudiante >= passing_grade).
--   - Snapshot de datos al emitir — si después se edita el curso/nombre
--     del estudiante/docente, el certificado conserva los valores
--     originales (auditoría histórica fiel).
--   - Identificador público corto `short_code` (12 chars alfanuméricos)
--     que va en el QR. Apunta a /verify/<short_code> en la app —
--     accesible SIN auth (RPC público).
--   - Revocable: si después se descubre fraude o expulsión, admin/docente
--     marca como revocado. La página pública muestra "Revocado".
--
-- NO almacenamos el binario del PDF — se genera bajo demanda en el
-- cliente con jspdf + qrcode usando el snapshot de esta tabla.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.certificates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificador público corto para la URL de verificación.
  -- Generamos uno aleatorio en el RPC con `gen_random_bytes(8) | base32`.
  short_code TEXT NOT NULL UNIQUE
    CHECK (short_code ~ '^[A-Z0-9]{8,16}$'),

  -- Relaciones lógicas (referencias para joins; el snapshot abajo es la
  -- fuente de verdad inmutable).
  user_id   UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,

  -- ──────── Snapshot inmutable al momento de emisión ────────
  student_full_name      TEXT    NOT NULL,
  student_identification TEXT,
  course_name            TEXT    NOT NULL,
  course_period          TEXT,
  final_grade            NUMERIC NOT NULL,
  grade_scale_max        NUMERIC NOT NULL,
  passing_grade          NUMERIC NOT NULL,
  teacher_names          TEXT[]  NOT NULL DEFAULT '{}',
  university_name        TEXT,
  university_logo_url    TEXT,
  -- ─────────────────────────────────────────────────────────

  -- Estado
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by   UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at  TIMESTAMPTZ,
  revoked_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoke_reason TEXT,

  -- Hash del payload canónico — sirve como verificador adicional cuando
  -- alguien sospecha que el PDF fue modificado. Se computa al emitir.
  payload_hash TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_certificates_user   ON public.certificates(user_id);
CREATE INDEX IF NOT EXISTS idx_certificates_course ON public.certificates(course_id);
CREATE INDEX IF NOT EXISTS idx_certificates_issued ON public.certificates(issued_at DESC);

-- Solo un certificado ACTIVO por (user, course). Si se revoca, se puede emitir otro.
CREATE UNIQUE INDEX IF NOT EXISTS idx_certificates_user_course_active
  ON public.certificates(user_id, course_id)
  WHERE revoked_at IS NULL;

-- ── RLS ──

ALTER TABLE public.certificates ENABLE ROW LEVEL SECURITY;

-- SELECT: estudiante dueño + docentes del curso + admin
DROP POLICY IF EXISTS "certificates_select" ON public.certificates;
CREATE POLICY "certificates_select"
  ON public.certificates FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = certificates.course_id AND ct.user_id = auth.uid()
    )
  );

-- INSERT/UPDATE/DELETE: NO directo del cliente. Solo vía RPCs SECURITY DEFINER.
-- Esto evita que se inserten certificados manualmente saltando validaciones.

-- ────────────────────────────────────────────────────────────────────
-- RPC: emitir un certificado
-- ────────────────────────────────────────────────────────────────────
-- Validaciones:
--   - El llamador debe ser docente del curso o Admin.
--   - El estudiante debe estar matriculado en el curso.
--   - La nota final calculada debe ser >= passing_grade del curso.
--   - No debe existir ya un certificado activo para (user, course).
-- Si todo OK, snapshotea datos y crea la fila.

CREATE OR REPLACE FUNCTION public.issue_certificate(
  _user_id   UUID,
  _course_id UUID,
  _final_grade NUMERIC
) RETURNS TABLE(short_code TEXT, certificate_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_admin BOOLEAN;
  _is_teacher BOOLEAN;
  _course RECORD;
  _student RECORD;
  _teacher_names TEXT[];
  _brand RECORD;
  _short TEXT;
  _hash TEXT;
  _new_id UUID;
BEGIN
  -- Autorización
  _is_admin := public.has_role(auth.uid(), 'Admin');
  SELECT EXISTS (
    SELECT 1 FROM public.course_teachers
    WHERE course_id = _course_id AND user_id = auth.uid()
  ) INTO _is_teacher;

  IF NOT (_is_admin OR _is_teacher) THEN
    RAISE EXCEPTION 'No autorizado para emitir certificados de este curso';
  END IF;

  -- Validar curso
  SELECT c.id, c.name, c.period, c.grade_scale_max, c.passing_grade
    INTO _course
    FROM public.courses c WHERE c.id = _course_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Curso no encontrado';
  END IF;

  -- Validar matrícula
  IF NOT EXISTS (
    SELECT 1 FROM public.course_enrollments
    WHERE course_id = _course_id AND user_id = _user_id
  ) THEN
    RAISE EXCEPTION 'El estudiante no está matriculado en este curso';
  END IF;

  -- Validar nota
  IF _final_grade IS NULL OR _final_grade < _course.passing_grade THEN
    RAISE EXCEPTION 'La nota final (%) es menor al puntaje mínimo de aprobación (%)',
      COALESCE(_final_grade, 0), _course.passing_grade;
  END IF;

  -- Validar duplicado (índice único cubre la concurrencia, pero damos mensaje claro)
  IF EXISTS (
    SELECT 1 FROM public.certificates
    WHERE user_id = _user_id AND course_id = _course_id AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Ya existe un certificado activo para este estudiante en este curso. Revócalo antes de emitir uno nuevo.';
  END IF;

  -- Snapshot del estudiante
  SELECT
    COALESCE(p.full_name, 'Estudiante') AS full_name,
    p.institutional_email,
    NULL::text AS identification  -- ajustar cuando profiles tenga ese campo
    INTO _student
    FROM public.profiles p WHERE p.id = _user_id;

  -- Snapshot de docentes del curso
  SELECT array_agg(COALESCE(p.full_name, 'Docente') ORDER BY p.full_name)
    INTO _teacher_names
    FROM public.course_teachers ct
    JOIN public.profiles p ON p.id = ct.user_id
    WHERE ct.course_id = _course_id;

  -- Snapshot de marca institucional (singleton, ya existe content_brand_config)
  SELECT university_name, logo_url INTO _brand
    FROM public.content_brand_config LIMIT 1;

  -- Generar short_code único (12 chars de base32 desde bytes aleatorios)
  -- Reintentamos en caso muy improbable de colisión.
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

  -- Hash del payload canónico (verificación adicional)
  _hash := encode(
    digest(
      _short || '|' ||
      _user_id::text || '|' ||
      _course_id::text || '|' ||
      _student.full_name || '|' ||
      _course.name || '|' ||
      _final_grade::text || '|' ||
      _course.grade_scale_max::text || '|' ||
      now()::text,
      'sha256'
    ),
    'hex'
  );

  -- Insertar
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
    _brand.university_name, _brand.logo_url,
    auth.uid(), _hash
  ) RETURNING id INTO _new_id;

  -- Notificación al estudiante
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    _user_id,
    'Tu certificado del curso "' || _course.name || '" está disponible',
    'Ya puedes descargar tu certificado de finalización en formato PDF.',
    'grade',
    '/app/student/certificates'
  );

  RETURN QUERY SELECT _short, _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.issue_certificate(UUID, UUID, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.issue_certificate(UUID, UUID, NUMERIC) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- RPC: revocar un certificado
-- ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.revoke_certificate(
  _certificate_id UUID,
  _reason TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cert RECORD;
BEGIN
  SELECT * INTO _cert FROM public.certificates WHERE id = _certificate_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Certificado no encontrado';
  END IF;

  IF _cert.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'El certificado ya está revocado';
  END IF;

  -- Solo admin o docente del curso
  IF NOT (
    public.has_role(auth.uid(), 'Admin') OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = _cert.course_id AND user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para revocar este certificado';
  END IF;

  UPDATE public.certificates
    SET revoked_at = now(),
        revoked_by = auth.uid(),
        revoke_reason = _reason
    WHERE id = _certificate_id;

  -- Notificación al estudiante
  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    _cert.user_id,
    'Tu certificado del curso "' || _cert.course_name || '" fue revocado',
    COALESCE('Motivo: ' || _reason, 'Sin motivo especificado.'),
    'system',
    '/app/student/certificates'
  );
END
$$;

REVOKE ALL ON FUNCTION public.revoke_certificate(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.revoke_certificate(UUID, TEXT) TO authenticated;

-- ────────────────────────────────────────────────────────────────────
-- RPC público: verificar certificado por short_code
-- ────────────────────────────────────────────────────────────────────
-- Esta función la pueden llamar usuarios NO autenticados desde la
-- página /verify. Solo retorna datos del snapshot — nada sensible más
-- allá de lo que el estudiante decida mostrar al QR.

CREATE OR REPLACE FUNCTION public.verify_certificate(_short_code TEXT)
RETURNS TABLE(
  exists_flag           BOOLEAN,
  is_revoked            BOOLEAN,
  short_code            TEXT,
  student_full_name     TEXT,
  course_name           TEXT,
  course_period         TEXT,
  final_grade           NUMERIC,
  grade_scale_max       NUMERIC,
  university_name       TEXT,
  university_logo_url   TEXT,
  teacher_names         TEXT[],
  issued_at             TIMESTAMPTZ,
  revoked_at            TIMESTAMPTZ,
  revoke_reason         TEXT,
  payload_hash          TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cert RECORD;
BEGIN
  SELECT * INTO _cert FROM public.certificates WHERE certificates.short_code = upper(_short_code);
  IF NOT FOUND THEN
    RETURN QUERY SELECT
      false, false,
      _short_code,
      NULL::text, NULL::text, NULL::text,
      NULL::numeric, NULL::numeric,
      NULL::text, NULL::text,
      NULL::text[], NULL::timestamptz, NULL::timestamptz, NULL::text,
      NULL::text;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    true,
    (_cert.revoked_at IS NOT NULL),
    _cert.short_code,
    _cert.student_full_name,
    _cert.course_name,
    _cert.course_period,
    _cert.final_grade,
    _cert.grade_scale_max,
    _cert.university_name,
    _cert.university_logo_url,
    _cert.teacher_names,
    _cert.issued_at,
    _cert.revoked_at,
    _cert.revoke_reason,
    _cert.payload_hash;
END
$$;

REVOKE ALL ON FUNCTION public.verify_certificate(TEXT) FROM PUBLIC;
-- Crítico: GRANT a `anon` para que la página de verify funcione sin login.
GRANT EXECUTE ON FUNCTION public.verify_certificate(TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

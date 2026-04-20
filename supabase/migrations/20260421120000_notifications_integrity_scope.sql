-- ============================================================
-- Notificaciones sensibles (integridad del examen): solo el
-- destinatario de cada fila puede leerla vía RLS; los docentes
-- del curso reciben cada uno su propia copia desde RPC segura.
-- Restringe INSERT de docentes para no poder falsificar tipos
-- exam_integrity_* manualmente.
-- ============================================================

ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS exam_id UUID REFERENCES public.exams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS related_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.notifications.exam_id IS 'Examen asociado (alertas de integridad, etc.)';
COMMENT ON COLUMN public.notifications.related_user_id IS 'Usuario relacionado (p. ej. estudiante del incidente); no amplía quién puede leer la fila — la RLS sigue siendo por user_id.';

CREATE INDEX IF NOT EXISTS idx_notifications_exam_id
  ON public.notifications(exam_id)
  WHERE exam_id IS NOT NULL;

-- SELECT: únicamente el destinatario o administración
DROP POLICY IF EXISTS "Users see own notifications" ON public.notifications;

CREATE POLICY "notifications_select_recipient_or_admin"
  ON public.notifications FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Admin')
  );

-- UPDATE: solo el destinatario marca leído
DROP POLICY IF EXISTS "Users update own notifications" ON public.notifications;

CREATE POLICY "notifications_update_recipient"
  ON public.notifications FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- INSERT: uno mismo, admin, o docente con kinds operacionales (no incidentes de examen)
DROP POLICY IF EXISTS "Teachers insert notifications" ON public.notifications;

CREATE POLICY "notifications_insert"
  ON public.notifications FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    OR public.has_role(auth.uid(), 'Admin')
    OR (
      public.has_role(auth.uid(), 'Docente')
      AND kind IN ('exam', 'info', 'grade', 'workshop', 'system')
    )
  );

-- Los tipos exam_integrity_* solo pueden crearse vía funciones SECURITY DEFINER (bypass RLS al insertar)

CREATE OR REPLACE FUNCTION public.notify_exam_teachers(
  _exam_id UUID,
  _title TEXT,
  _body TEXT,
  _link TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _staff_rows INTEGER := 0;
  _course_id UUID;
  _exam_title TEXT;
BEGIN
  SELECT e.course_id, e.title INTO _course_id, _exam_title
  FROM public.exams e
  WHERE e.id = _exam_id;

  IF _course_id IS NULL THEN
    RETURN 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.submissions s
    WHERE s.exam_id = _exam_id AND s.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized';
  END IF;

  -- Docentes del curso (course_teachers) + autor del examen
  INSERT INTO public.notifications (
    user_id, title, body, kind, link, exam_id, related_user_id
  )
  SELECT DISTINCT
    x.tid,
    _title,
    _body,
    'exam_integrity_staff',
    _link,
    _exam_id,
    auth.uid()
  FROM (
    SELECT e.created_by AS tid
    FROM public.exams e
    WHERE e.id = _exam_id AND e.created_by IS NOT NULL
    UNION
    SELECT ct.user_id AS tid
    FROM public.course_teachers ct
    WHERE ct.course_id = _course_id
  ) x
  WHERE x.tid IS NOT NULL;

  GET DIAGNOSTICS _staff_rows = ROW_COUNT;

  INSERT INTO public.notifications (
    user_id, title, body, kind, link, exam_id, related_user_id
  )
  VALUES (
    auth.uid(),
    'Examen marcado como sospechoso',
    format(
      'Tu intento del examen "%s" quedó registrado como sospechoso por superar el límite de advertencias de foco o integridad. Los docentes del curso han sido informados.',
      COALESCE(_exam_title, 'el examen')
    ),
    'exam_integrity_student',
    '/app/student/exams',
    _exam_id,
    auth.uid()
  );

  RETURN _staff_rows + 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.notify_exam_teachers(UUID, TEXT, TEXT, TEXT) TO authenticated;

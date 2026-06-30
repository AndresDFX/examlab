-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase 7, cont.) — abuelo curso para el resto de hijos
-- DUEÑOS de curso: attendance_sessions, whiteboards y sus hijas.
--
-- Mismo defecto que exams/workshops/projects (cerrado en 20261023): un curso en
-- papelera NO cascadea, así que su sesión/pizarra (y snippets/páginas) quedan con
-- deleted_at=NULL y la rama no-staff de su policy solo miraba el deleted_at
-- PROPIO, no el del curso abuelo. Un alumno matriculado leía por REST el
-- whiteboard_scene/meeting/recording de la sesión, la escena de la pizarra
-- compartida y el código de clase de un CURSO en papelera.
--
-- Fix: añadir `AND NOT public._course_in_papelera(<course_id>)` a la rama
-- alumno/matrícula (staff conserva acceso para la Papelera). course_id es columna
-- propia (attendance_sessions/whiteboards) o de la fila padre joineada
-- (s.course_id / w.course_id); _course_in_papelera es SECURITY DEFINER (RLS-inmune).
--
-- NO aplica a polls/generated_contents: son MULTI-curso (poll_courses /
-- content_course_assignments). "El curso en papelera" es ambiguo (pueden estar
-- compartidos con varios cursos) y ya están gateados por su PROPIO deleted_at.
-- ══════════════════════════════════════════════════════════════════════

ALTER POLICY attendance_sessions_select_in_tenant ON public.attendance_sessions
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      (deleted_at IS NULL AND NOT public._course_in_papelera(course_id))
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

ALTER POLICY whiteboards_select ON public.whiteboards
  USING (
    (owner_id = auth.uid())
    OR public.is_super_admin()
    OR ((public.has_role(auth.uid(), 'Admin'::public.app_role) OR public.has_role(auth.uid(), 'Docente'::public.app_role)) AND (tenant_id = public.current_tenant_id()))
    OR ((course_id IS NOT NULL) AND (EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = whiteboards.course_id AND ct.user_id = auth.uid()
    )))
    OR ((is_shared_with_course = true) AND (course_id IS NOT NULL) AND (deleted_at IS NULL) AND NOT public._course_in_papelera(course_id) AND (EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = whiteboards.course_id AND ce.user_id = auth.uid()
    )))
  );

ALTER POLICY whiteboard_pages_select ON public.whiteboard_pages
  USING (EXISTS (
    SELECT 1 FROM public.whiteboards w
    WHERE w.id = whiteboard_pages.whiteboard_id
      AND (
        (w.owner_id = auth.uid())
        OR public.is_super_admin()
        OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND (w.tenant_id = public.current_tenant_id()))
        OR ((w.is_shared_with_course = true) AND (w.course_id IS NOT NULL) AND (w.deleted_at IS NULL) AND NOT public._course_in_papelera(w.course_id) AND (EXISTS (
          SELECT 1 FROM public.course_enrollments ce
          WHERE ce.course_id = w.course_id AND ce.user_id = auth.uid()
        )))
      )
  ));

ALTER POLICY session_code_snippets_select ON public.session_code_snippets
  USING (EXISTS (
    SELECT 1 FROM public.attendance_sessions s
    WHERE s.id = session_code_snippets.session_id
      AND (
        public.has_role(auth.uid(), 'Admin'::public.app_role)
        OR public.is_super_admin()
        OR (EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid()
        ))
        OR ((COALESCE(s.code_shared, false) = true) AND (s.deleted_at IS NULL) AND NOT public._course_in_papelera(s.course_id) AND (EXISTS (
          SELECT 1 FROM public.course_enrollments ce
          WHERE ce.course_id = s.course_id AND ce.user_id = auth.uid()
        )))
      )
  ));

NOTIFY pgrst, 'reload schema';

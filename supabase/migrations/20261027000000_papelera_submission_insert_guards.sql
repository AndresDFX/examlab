-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (dimensión ESCRITURA) — no crear entregas/sesiones bajo un
-- padre en papelera.
--
-- El lado LECTURA quedó seco (un alumno no VE entidades en papelera). Pero las
-- policies INSERT de submissions/workshop_submissions/project_submissions/
-- tutor_chat_sessions no gateaban el `deleted_at` del padre: con un id stale, un
-- alumno podía CREAR por REST una entrega bajo un examen/taller/proyecto en
-- papelera (o de un curso abuelo en papelera), o una sesión de tutor de un curso
-- en papelera. Bajo daño (no expone datos; genera huérfanos) pero "usable en un
-- flujo" → se cierra para escrituras NUEVAS.
--
-- Gate SOLO la rama ESTUDIANTE (own/grupo) con `padre activo Y curso abuelo
-- activo` (EXISTS positivo, RLS-safe). Las ramas docente/admin quedan intactas
-- (gestión). El take-flow inserta solo sobre exámenes ACTIVOS (sus lecturas ya
-- filtran papelera), así que NO se ve afectado.
--
-- INTENCIONALMENTE NO se gatea UPDATE: si el docente manda el examen a la
-- papelera MIENTRAS un alumno lo resuelve, bloquear el autosave/entrega (UPDATE)
-- le haría perder el trabajo en curso. El gate de INSERT ya evita huérfanos
-- nuevos; el UPDATE de una entrega ya existente es protección del alumno.
-- ══════════════════════════════════════════════════════════════════════

ALTER POLICY submissions_insert ON public.submissions
  WITH CHECK (
    (
      (auth.uid() = user_id)
      AND EXISTS (
        SELECT 1 FROM public.exams e JOIN public.courses c ON c.id = e.course_id
        WHERE e.id = submissions.exam_id AND e.deleted_at IS NULL AND c.deleted_at IS NULL
      )
    )
    OR (EXISTS (
      SELECT 1 FROM public.exams e JOIN public.course_teachers ct ON ct.course_id = e.course_id
      WHERE e.id = submissions.exam_id AND ct.user_id = auth.uid()
    ))
    OR (EXISTS (
      SELECT 1 FROM public.exams e WHERE e.id = submissions.exam_id AND public.is_admin_of_course_tenant(e.course_id)
    ))
  );

ALTER POLICY workshop_submissions_insert ON public.workshop_submissions
  WITH CHECK (
    (
      (
        (auth.uid() = user_id)
        OR ((group_id IS NOT NULL) AND EXISTS (
          SELECT 1 FROM public.workshop_group_members m
          WHERE m.group_id = workshop_submissions.group_id AND m.user_id = auth.uid()
        ))
      )
      AND EXISTS (
        SELECT 1 FROM public.workshops w JOIN public.courses c ON c.id = w.course_id
        WHERE w.id = workshop_submissions.workshop_id AND w.deleted_at IS NULL AND c.deleted_at IS NULL
      )
    )
    OR (EXISTS (
      SELECT 1 FROM public.workshops w JOIN public.course_teachers ct ON ct.course_id = w.course_id
      WHERE w.id = workshop_submissions.workshop_id AND ct.user_id = auth.uid()
    ))
    OR (EXISTS (
      SELECT 1 FROM public.workshops w WHERE w.id = workshop_submissions.workshop_id AND public.is_admin_of_course_tenant(w.course_id)
    ))
  );

ALTER POLICY project_submissions_insert ON public.project_submissions
  WITH CHECK (
    (
      (
        (auth.uid() = user_id)
        OR ((group_id IS NOT NULL) AND EXISTS (
          SELECT 1 FROM public.project_group_members m
          WHERE m.group_id = project_submissions.group_id AND m.user_id = auth.uid()
        ))
      )
      AND EXISTS (
        SELECT 1 FROM public.projects p JOIN public.courses c ON c.id = p.course_id
        WHERE p.id = project_submissions.project_id AND p.deleted_at IS NULL AND c.deleted_at IS NULL
      )
    )
    OR (EXISTS (
      SELECT 1 FROM public.projects p JOIN public.course_teachers ct ON ct.course_id = p.course_id
      WHERE p.id = project_submissions.project_id AND ct.user_id = auth.uid()
    ))
    OR (EXISTS (
      SELECT 1 FROM public.projects p WHERE p.id = project_submissions.project_id AND public.is_admin_of_course_tenant(p.course_id)
    ))
  );

ALTER POLICY tutor_sessions_insert ON public.tutor_chat_sessions
  WITH CHECK (
    (user_id = auth.uid())
    AND (EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_enrollments.course_id = tutor_chat_sessions.course_id AND course_enrollments.user_id = auth.uid()
    ))
    AND NOT public._course_in_papelera(tutor_chat_sessions.course_id)
  );

NOTIFY pgrst, 'reload schema';

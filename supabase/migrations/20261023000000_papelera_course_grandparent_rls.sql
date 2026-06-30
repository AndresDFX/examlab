-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase 7) — el ABUELO curso.
--
-- El soft-delete de un CURSO NO cascadea (softDelete = UPDATE de una sola tabla;
-- mig 20260816). Así que un curso en papelera deja sus exams/workshops/projects
-- (y sus questions/files) con deleted_at=NULL. Las policies de pases previos
-- gatean el deleted_at del PADRE INMEDIATO (exam/workshop/project) pero NO el del
-- curso ABUELO → un alumno matriculado lee por REST el content+options (CLAVE de
-- respuesta) / rúbrica / instructions de la assessment de un CURSO en papelera.
-- courses es una de las 8 → su contenido debe ocultarse al no-staff.
--
-- Fix (rama no-staff; staff sigue cubierto por *_staff_manage [ALL] / bypass):
--  - Hijas (questions/workshop_questions/project_files): extender el EXISTS
--    positivo a JOIN courses + `c.deleted_at IS NULL` (RLS-safe: positivo, el
--    ocultamiento por RLS refuerza el deny; el check explícito lo garantiza).
--  - Entidades (exams/workshops/projects): añadir `AND NOT
--    public._course_in_papelera(course_id)` a la rama no-staff (course_id es
--    columna propia → helper SECURITY DEFINER RLS-inmune, sin subquery frágil).
-- ══════════════════════════════════════════════════════════════════════

-- ── Hijas: padre activo Y curso activo ──
ALTER POLICY questions_select_in_tenant ON public.questions
  USING (
    public.exam_in_my_tenant(exam_id)
    AND EXISTS (
      SELECT 1 FROM public.exams e
      JOIN public.courses c ON c.id = e.course_id
      WHERE e.id = questions.exam_id AND e.deleted_at IS NULL AND c.deleted_at IS NULL
    )
  );

ALTER POLICY workshop_questions_select_in_tenant ON public.workshop_questions
  USING (
    public.workshop_in_my_tenant(workshop_id)
    AND EXISTS (
      SELECT 1 FROM public.workshops w
      JOIN public.courses c ON c.id = w.course_id
      WHERE w.id = workshop_questions.workshop_id AND w.deleted_at IS NULL AND c.deleted_at IS NULL
    )
  );

ALTER POLICY project_files_select_in_tenant ON public.project_files
  USING (
    public.project_in_my_tenant(project_id)
    AND EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.courses c ON c.id = p.course_id
      WHERE p.id = project_files.project_id AND p.deleted_at IS NULL AND c.deleted_at IS NULL
    )
  );

-- ── Entidades: rama no-staff exige entidad activa Y curso (abuelo) activo ──
ALTER POLICY exams_select_in_tenant ON public.exams
  USING (
    public.is_super_admin()
    OR (
      public.course_in_my_tenant(course_id)
      AND (
        (deleted_at IS NULL AND NOT public._course_in_papelera(course_id))
        OR public.has_role(auth.uid(), 'Docente'::public.app_role)
        OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      )
    )
  );

ALTER POLICY workshops_select_in_tenant ON public.workshops
  USING (
    public.is_super_admin()
    OR (
      public.course_in_my_tenant(course_id)
      AND (
        (deleted_at IS NULL AND NOT public._course_in_papelera(course_id))
        OR public.has_role(auth.uid(), 'Docente'::public.app_role)
        OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      )
    )
  );

ALTER POLICY projects_select_in_tenant ON public.projects
  USING (
    public.is_super_admin()
    OR (
      public.course_in_my_tenant(course_id)
      AND (
        (deleted_at IS NULL AND NOT public._course_in_papelera(course_id))
        OR public.has_role(auth.uid(), 'Docente'::public.app_role)
        OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      )
    )
  );

NOTIFY pgrst, 'reload schema';

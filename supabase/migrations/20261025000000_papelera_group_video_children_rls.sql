-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase 8) — hijas de workshops/projects que faltaban:
-- grupos, miembros de grupo y videos intro.
--
-- Estas 6 policies SELECT estaban gateadas SOLO por `*_in_my_tenant` (tenant), sin
-- `deleted_at` del taller/proyecto padre NI del curso abuelo. Un NO-staff
-- (alumno matriculado / cualquier autenticado del tenant) con un id stale leía
-- por REST: nombre + signup_code de grupos, composición de grupos (PII:
-- user_id↔group), y url+title de los videos intro, de un taller/proyecto (o curso
-- abuelo) en papelera. Mismo patrón ya cerrado para questions/workshop_questions/
-- project_files; estas hijas se habían omitido (pase 4 las dio por OK por error).
--
-- Fix (rama no-staff): EXISTS positivo que joinea padre + curso abuelo y exige
-- ambos `deleted_at IS NULL` (RLS-safe). Staff (Docente/Admin/SA) conserva acceso.
--
-- FUERA DE ALCANCE (documentado, NO tocado): course_enrollments / course_teachers
-- (infraestructura de membresía leída por EXISTS de MUCHAS otras policies →
-- gatearlas tiene blast radius cross-policy; la fila es plumbing, no contenido
-- sensible), project_courses / workshop_courses (junctions) y
-- course_certificate_settings (config). Si se decide cerrarlas, va en un esfuerzo
-- aparte con su propia verificación de blast radius.
-- ══════════════════════════════════════════════════════════════════════

ALTER POLICY workshop_groups_select_in_tenant ON public.workshop_groups
  USING (
    public.workshop_in_my_tenant(workshop_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.workshops w JOIN public.courses c ON c.id = w.course_id
        WHERE w.id = workshop_groups.workshop_id AND w.deleted_at IS NULL AND c.deleted_at IS NULL
      )
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

ALTER POLICY project_groups_select_in_tenant ON public.project_groups
  USING (
    public.project_in_my_tenant(project_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.projects p JOIN public.courses c ON c.id = p.course_id
        WHERE p.id = project_groups.project_id AND p.deleted_at IS NULL AND c.deleted_at IS NULL
      )
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

ALTER POLICY workshop_group_members_select_in_tenant ON public.workshop_group_members
  USING (
    public.workshop_group_in_my_tenant(group_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.workshop_groups g
        JOIN public.workshops w ON w.id = g.workshop_id
        JOIN public.courses c ON c.id = w.course_id
        WHERE g.id = workshop_group_members.group_id AND w.deleted_at IS NULL AND c.deleted_at IS NULL
      )
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

ALTER POLICY project_group_members_select_in_tenant ON public.project_group_members
  USING (
    public.project_group_in_my_tenant(group_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.project_groups g
        JOIN public.projects p ON p.id = g.project_id
        JOIN public.courses c ON c.id = p.course_id
        WHERE g.id = project_group_members.group_id AND p.deleted_at IS NULL AND c.deleted_at IS NULL
      )
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

ALTER POLICY workshop_intro_videos_select_in_tenant ON public.workshop_intro_videos
  USING (
    public.workshop_in_my_tenant(workshop_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.workshops w JOIN public.courses c ON c.id = w.course_id
        WHERE w.id = workshop_intro_videos.workshop_id AND w.deleted_at IS NULL AND c.deleted_at IS NULL
      )
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

ALTER POLICY project_intro_videos_select_in_tenant ON public.project_intro_videos
  USING (
    public.project_in_my_tenant(project_id)
    AND (
      EXISTS (
        SELECT 1 FROM public.projects p JOIN public.courses c ON c.id = p.course_id
        WHERE p.id = project_intro_videos.project_id AND p.deleted_at IS NULL AND c.deleted_at IS NULL
      )
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

NOTIFY pgrst, 'reload schema';

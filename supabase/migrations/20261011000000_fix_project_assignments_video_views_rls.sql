-- ──────────────────────────────────────────────────────────────────────
-- Fix de 2 policies SELECT con rama de rol SIN scope de tenant (leak
-- cross-tenant). Detectadas en la auditoría exhaustiva de pg_policies del
-- 2026-06-28 (revisión por rol/módulo).
--
-- project_assignments (LEAK CONFIRMADO, 17 filas):
--   El round 4 (20260996) agregó la policy correcta `..._manage_staff [ALL]`
--   = `project_in_my_tenant(project_id) AND (Docente|Admin)` PERO dejó viva la
--   vieja `..._owner_or_staff [SELECT]` = `user_id=auth.uid() OR has_role(Docente)
--   OR has_role(Admin)`. Como RLS combina policies permisivas con OR, la rama
--   `has_role(...)` SIN scope dejaba que CUALQUIER Docente/Admin (de cualquier
--   tenant) leyera TODAS las asignaciones de proyecto. Verificado: un Docente de
--   un tenant sin proyectos veía las 17 filas de otros tenants.
--   Fix: drop de la policy rota; el `manage_staff [ALL]` ya cubre el SELECT del
--   staff (scopeado por tenant). Se agrega solo la rama del DUEÑO (alumno ve su
--   propia asignación) + is_super_admin (consistencia con el resto del esquema).
--
-- video_views (mismo anti-patrón; 0 filas hoy, pero la policy es incorrecta):
--   `..._read_self [SELECT]` = `user_id=auth.uid() OR has_role(Docente) OR
--   has_role(Admin)` → un Docente/Admin de cualquier tenant vería TODAS las
--   vistas de video. Fix: el alumno ve las suyas; el staff solo las de videos
--   de SU tenant (join a videos.tenant_id); SA todo.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  -- ── project_assignments ──
  IF to_regclass('public.project_assignments') IS NOT NULL THEN
    DROP POLICY IF EXISTS project_assignments_owner_or_staff ON public.project_assignments;
    -- El staff (Docente/Admin del tenant del proyecto) ya tiene SELECT vía la
    -- policy ALL `project_assignments_manage_staff` (scopeada por
    -- project_in_my_tenant). Acá solo agregamos al DUEÑO + SuperAdmin.
    DROP POLICY IF EXISTS project_assignments_select_own ON public.project_assignments;
    CREATE POLICY project_assignments_select_own
      ON public.project_assignments FOR SELECT TO authenticated
      USING (auth.uid() = user_id OR public.is_super_admin());
  END IF;

  -- ── video_views ──
  IF to_regclass('public.video_views') IS NOT NULL THEN
    DROP POLICY IF EXISTS video_views_read_self ON public.video_views;
    CREATE POLICY video_views_read_self
      ON public.video_views FOR SELECT TO authenticated
      USING (
        user_id = auth.uid()
        OR public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.videos v
          WHERE v.id = video_views.video_id
            AND v.tenant_id = public.current_tenant_id()
            AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
        )
      );
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

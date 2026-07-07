-- ══════════════════════════════════════════════════════════════════════
-- RLS pizarras: un estudiante NO matriculado veía una pizarra de ese curso.
--
-- CAUSA: whiteboards_select y whiteboards_owner_write (FOR ALL → aplica también a
-- SELECT, y las policies permissivas se OR-ean) otorgaban
--   (has_role('Admin') OR has_role('Docente')) AND tenant_id = current_tenant_id()
-- → CUALQUIER usuario con el rol Docente (rol POSEÍDO, global) veía/editaba TODAS
-- las pizarras de su tenant, sin importar si dicta el curso o está matriculado.
-- Como muchos usuarios son multi-rol (Docente+Estudiante), uno "actuando como
-- estudiante" veía pizarras de cursos ajenos. Reproducido contra prod: un
-- Docente+Estudiante veía una pizarra de otro dueño sin curso (solo por la rama
-- tenant); al acotar la rama, deja de verla.
--
-- FIX: la rama tenant-wide queda SOLO para Admin (gestión de la institución). El
-- Docente conserva acceso por la rama de course_teachers (cursos que DICTA) + las
-- suyas (owner_id). El estudiante por la rama is_shared_with_course + matrícula.
-- Se corrigen las 3 policies con la rama Docente-tenant: whiteboards_select,
-- whiteboards_owner_write y whiteboard_pages_owner_write (whiteboard_pages_select
-- ya era Admin-only). Idempotente + guard to_regclass.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.whiteboards') IS NOT NULL THEN
    DROP POLICY IF EXISTS whiteboards_select ON public.whiteboards;
    CREATE POLICY whiteboards_select ON public.whiteboards
      FOR SELECT USING (
        (owner_id = auth.uid())
        OR public.is_super_admin()
        OR (public.has_role(auth.uid(), 'Admin') AND (tenant_id = public.current_tenant_id()))
        OR (
          (course_id IS NOT NULL) AND EXISTS (
            SELECT 1 FROM public.course_teachers ct
            WHERE ct.course_id = whiteboards.course_id AND ct.user_id = auth.uid()
          )
        )
        OR (
          (is_shared_with_course = true)
          AND (course_id IS NOT NULL)
          AND (deleted_at IS NULL)
          AND (NOT public._course_in_papelera(course_id))
          AND EXISTS (
            SELECT 1 FROM public.course_enrollments ce
            WHERE ce.course_id = whiteboards.course_id AND ce.user_id = auth.uid()
          )
        )
      );

    DROP POLICY IF EXISTS whiteboards_owner_write ON public.whiteboards;
    CREATE POLICY whiteboards_owner_write ON public.whiteboards
      FOR ALL
      USING (
        (owner_id = auth.uid())
        OR public.is_super_admin()
        OR (public.has_role(auth.uid(), 'Admin') AND (tenant_id = public.current_tenant_id()))
        OR (
          (course_id IS NOT NULL) AND EXISTS (
            SELECT 1 FROM public.course_teachers ct
            WHERE ct.course_id = whiteboards.course_id AND ct.user_id = auth.uid()
          )
        )
      )
      WITH CHECK (
        (owner_id = auth.uid())
        OR public.is_super_admin()
        OR (public.has_role(auth.uid(), 'Admin') AND (tenant_id = public.current_tenant_id()))
        OR (
          (course_id IS NOT NULL) AND EXISTS (
            SELECT 1 FROM public.course_teachers ct
            WHERE ct.course_id = whiteboards.course_id AND ct.user_id = auth.uid()
          )
        )
      );
  END IF;

  IF to_regclass('public.whiteboard_pages') IS NOT NULL THEN
    DROP POLICY IF EXISTS whiteboard_pages_owner_write ON public.whiteboard_pages;
    CREATE POLICY whiteboard_pages_owner_write ON public.whiteboard_pages
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM public.whiteboards w
          WHERE w.id = whiteboard_pages.whiteboard_id
            AND (
              (w.owner_id = auth.uid())
              OR public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin') AND (w.tenant_id = public.current_tenant_id()))
              OR (
                (w.course_id IS NOT NULL) AND EXISTS (
                  SELECT 1 FROM public.course_teachers ct
                  WHERE ct.course_id = w.course_id AND ct.user_id = auth.uid()
                )
              )
            )
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.whiteboards w
          WHERE w.id = whiteboard_pages.whiteboard_id
            AND (
              (w.owner_id = auth.uid())
              OR public.is_super_admin()
              OR (public.has_role(auth.uid(), 'Admin') AND (w.tenant_id = public.current_tenant_id()))
              OR (
                (w.course_id IS NOT NULL) AND EXISTS (
                  SELECT 1 FROM public.course_teachers ct
                  WHERE ct.course_id = w.course_id AND ct.user_id = auth.uid()
                )
              )
            )
        )
      );
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════
-- Arreglar la edición de pizarras (público/privado, asociar/desasociar curso)
-- por el staff del tenant (reporte: FESNA no deja editar pizarras).
--
-- Causa: tras 20260945 la escritura quedó como
--   owner_id = auth.uid() OR is_super_admin() OR (Admin AND tenant_id = current)
-- Dos huecos:
--   1) `tenant_id` se derivaba SOLO del owner. Si la pizarra la creó un
--      SuperAdmin (profiles.tenant_id NULL) o quedó NULL por histórico, la
--      rama Admin (tenant_id = current) falla → ningún Admin del tenant puede
--      editarla (solo el owner / SA).
--   2) Un Docente que NO es el owner no podía editar pizarras de SU tenant
--      (las pizarras son una herramienta colaborativa de aula).
--
-- Fix:
--   - El trigger de tenant: si el owner no tiene tenant, derivarlo del CURSO
--     asociado (course_id → courses.tenant_id).
--   - Backfill: poblar tenant_id NULL desde owner o curso.
--   - Política de escritura/lectura: permitir al staff del tenant (Admin O
--     Docente, scopeado a su tenant) además del owner y el SuperAdmin.
-- ═══════════════════════════════════════════════════════════════════════

-- 1) Trigger más robusto: owner.tenant_id, si no, el del curso asociado.
CREATE OR REPLACE FUNCTION public._tg_whiteboard_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL OR (TG_OP = 'UPDATE' AND OLD.owner_id IS DISTINCT FROM NEW.owner_id) THEN
    SELECT tenant_id INTO NEW.tenant_id
      FROM public.profiles
     WHERE id = NEW.owner_id;
  END IF;
  -- Fallback: si el owner no tiene tenant (ej. SuperAdmin) pero la pizarra
  -- está asociada a un curso, usar el tenant del curso.
  IF NEW.tenant_id IS NULL AND NEW.course_id IS NOT NULL THEN
    SELECT tenant_id INTO NEW.tenant_id
      FROM public.courses
     WHERE id = NEW.course_id;
  END IF;
  RETURN NEW;
END
$$;

-- 2) Backfill de pizarras con tenant_id NULL.
DO $$
BEGIN
  IF to_regclass('public.whiteboards') IS NOT NULL THEN
    -- Desde el owner.
    UPDATE public.whiteboards w
       SET tenant_id = p.tenant_id
      FROM public.profiles p
     WHERE w.tenant_id IS NULL AND p.id = w.owner_id AND p.tenant_id IS NOT NULL;
    -- Lo que quede NULL, desde el curso asociado.
    UPDATE public.whiteboards w
       SET tenant_id = c.tenant_id
      FROM public.courses c
     WHERE w.tenant_id IS NULL AND c.id = w.course_id AND c.tenant_id IS NOT NULL;
  END IF;
END $$;

-- 3) Políticas: staff del tenant (Admin O Docente) además de owner + SA.
DROP POLICY IF EXISTS whiteboards_select ON public.whiteboards;
CREATE POLICY whiteboards_select
  ON public.whiteboards FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.is_super_admin()
    OR (
      (public.has_role(auth.uid(), 'Admin'::public.app_role)
        OR public.has_role(auth.uid(), 'Docente'::public.app_role))
      AND tenant_id = public.current_tenant_id()
    )
    OR (
      is_shared_with_course = true
      AND course_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.course_enrollments ce
         WHERE ce.course_id = whiteboards.course_id AND ce.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS whiteboards_owner_write ON public.whiteboards;
CREATE POLICY whiteboards_owner_write
  ON public.whiteboards FOR ALL TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.is_super_admin()
    OR (
      (public.has_role(auth.uid(), 'Admin'::public.app_role)
        OR public.has_role(auth.uid(), 'Docente'::public.app_role))
      AND tenant_id = public.current_tenant_id()
    )
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR public.is_super_admin()
    OR (
      (public.has_role(auth.uid(), 'Admin'::public.app_role)
        OR public.has_role(auth.uid(), 'Docente'::public.app_role))
      AND tenant_id = public.current_tenant_id()
    )
  );

-- 4) whiteboard_pages (contenido/dibujo) — mismo criterio: staff del tenant.
DROP POLICY IF EXISTS whiteboard_pages_owner_write ON public.whiteboard_pages;
CREATE POLICY whiteboard_pages_owner_write
  ON public.whiteboard_pages FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.is_super_admin()
          OR (
            (public.has_role(auth.uid(), 'Admin'::public.app_role)
              OR public.has_role(auth.uid(), 'Docente'::public.app_role))
            AND w.tenant_id = public.current_tenant_id()
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.is_super_admin()
          OR (
            (public.has_role(auth.uid(), 'Admin'::public.app_role)
              OR public.has_role(auth.uid(), 'Docente'::public.app_role))
            AND w.tenant_id = public.current_tenant_id()
          )
        )
    )
  );

NOTIFY pgrst, 'reload schema';

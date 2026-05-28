-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy: scopear `videos` per-tenant.
--
-- Hasta ahora la biblioteca de videos era global cross-tenant (cualquier
-- usuario veía todos los videos de la plataforma). Decisión del producto:
-- cada institución gestiona SU propia biblioteca.
--
-- Cambios:
--   1. Agrega columna tenant_id en videos.
--   2. Backfill: por prioridad → tenant del course_id si está seteado,
--      sino tenant del uploaded_by, sino el tenant 'default'.
--   3. NOT NULL después del backfill.
--   4. Trigger BEFORE INSERT autocompleta tenant_id si viene NULL.
--   5. Policies nuevas: SELECT/WRITE filtran por tenant.
--
-- Nota: la columna `course_id` se mantiene. Su semántica sigue siendo
-- "video atado a un curso específico (NOT NULL) o global dentro del
-- tenant (NULL)". Lo que cambia es que "global" ya no es global de
-- plataforma — es global del TENANT.
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Agregar tenant_id ─────────────────────────────────────────────
ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE RESTRICT;

-- ─── 2) Backfill ──────────────────────────────────────────────────────
-- Prioridad: course.tenant_id → profile.tenant_id (del uploader) → default.
UPDATE public.videos v
   SET tenant_id = COALESCE(
     (SELECT c.tenant_id FROM public.courses c WHERE c.id = v.course_id),
     (SELECT p.tenant_id FROM public.profiles p WHERE p.id = v.uploaded_by),
     (SELECT id FROM public.tenants WHERE slug = 'default')
   )
 WHERE v.tenant_id IS NULL;

-- ─── 3) NOT NULL ──────────────────────────────────────────────────────
ALTER TABLE public.videos
  ALTER COLUMN tenant_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_videos_tenant_id
  ON public.videos(tenant_id);

-- ─── 4) Trigger auto-set tenant_id en INSERT ──────────────────────────
-- Reusa la función genérica tg_set_tenant_id() creada en la Fase 2
-- (migración 20260622000000_tenants_academic_scoping.sql).
DROP TRIGGER IF EXISTS trg_videos_set_tenant ON public.videos;
CREATE TRIGGER trg_videos_set_tenant
  BEFORE INSERT ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.tg_set_tenant_id();

-- ─── 5) Policies con tenant filter ────────────────────────────────────
DROP POLICY IF EXISTS videos_read_all ON public.videos;
DROP POLICY IF EXISTS videos_write_staff ON public.videos;

CREATE POLICY "videos_read_in_tenant"
  ON public.videos FOR SELECT TO authenticated
  USING (tenant_id = public.current_tenant_id() OR public.is_super_admin());

CREATE POLICY "videos_write_staff"
  ON public.videos FOR ALL TO authenticated
  USING (
    (
      tenant_id = public.current_tenant_id()
      AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    (
      tenant_id = public.current_tenant_id()
      AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
    )
    OR public.is_super_admin()
  );

NOTIFY pgrst, 'reload schema';

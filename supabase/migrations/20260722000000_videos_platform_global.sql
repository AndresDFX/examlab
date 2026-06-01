-- ──────────────────────────────────────────────────────────────────────
-- Videos cross-tenant: SuperAdmin publica videos disponibles a TODAS
-- las instituciones.
--
-- Antes (mig 20260528020000) `videos.tenant_id` era NOT NULL: cada
-- video pertenecía a UN tenant y solo se veía dentro de él. Producto
-- pidió que el SuperAdmin pueda subir videos "del catálogo global"
-- (introducciones a Java, lectures grabadas, tutoriales) que cualquier
-- institución pueda referenciar en sus talleres/proyectos sin tener
-- que volver a subir el mismo material.
--
-- Modelo (mismo patrón que module_visibility, ai_prompts,
-- ai_model_settings):
--   - tenant_id IS NOT NULL → video del tenant; visible solo dentro.
--   - tenant_id IS NULL     → video PLATFORM-GLOBAL; visible para
--                             cualquier tenant. Solo SuperAdmin lo crea.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Permitir tenant_id NULL (era NOT NULL).
ALTER TABLE public.videos
  ALTER COLUMN tenant_id DROP NOT NULL;

-- 2) Trigger auto-set: antes usaba `tg_set_tenant_id` genérico que
-- siempre forzaba `current_tenant_id()` cuando llegaba NULL. Ahora
-- queremos que el SuperAdmin pueda INSERTAR con NULL intencionalmente
-- (= "publicalo como global"). Reemplazamos por uno específico que
-- respeta el NULL del SuperAdmin, igual patrón que ai_prompts /
-- ai_model_settings post-mig.
CREATE OR REPLACE FUNCTION public.tg_videos_set_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- SuperAdmin que envía tenant_id NULL: respetamos, es video global
  -- de la plataforma. (Si un SuperAdmin quisiera subir el video para
  -- un tenant específico, lo envía con tenant_id != NULL — el cliente
  -- decide.)
  IF public.is_super_admin() THEN
    RETURN NEW;
  END IF;
  -- Resto de roles: si la fila no trae tenant_id, lo derivamos del
  -- caller — comportamiento previo de tg_set_tenant_id().
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := public.current_tenant_id();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_videos_set_tenant ON public.videos;
CREATE TRIGGER trg_videos_set_tenant
  BEFORE INSERT ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public.tg_videos_set_tenant();

-- 3) Policies — SELECT y WRITE actualizadas para contemplar
-- tenant_id IS NULL (= platform global). La lectura del global es para
-- TODOS los authenticated (cualquier tenant lo puede ver y referenciar
-- en sus talleres/proyectos). La escritura del global es SuperAdmin only.
DROP POLICY IF EXISTS videos_read_in_tenant ON public.videos;
DROP POLICY IF EXISTS videos_read_in_tenant_or_global ON public.videos;
CREATE POLICY "videos_read_in_tenant_or_global"
  ON public.videos FOR SELECT TO authenticated
  USING (
    -- Mi tenant ve sus propios videos.
    tenant_id = public.current_tenant_id()
    -- Cualquier authenticated ve los globales de plataforma.
    OR tenant_id IS NULL
    -- SuperAdmin ve todo (cross-tenant).
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS videos_write_staff ON public.videos;
CREATE POLICY "videos_write_staff"
  ON public.videos FOR ALL TO authenticated
  USING (
    -- Docente/Admin del tenant manejan los videos de su tenant.
    (
      tenant_id = public.current_tenant_id()
      AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
    )
    -- SuperAdmin maneja los suyos (cualquier tenant) y los globales (NULL).
    OR public.is_super_admin()
  )
  WITH CHECK (
    (
      tenant_id = public.current_tenant_id()
      AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
    )
    OR public.is_super_admin()
  );

-- 4) Comentario actualizado para reflejar el modelo nuevo.
COMMENT ON COLUMN public.videos.tenant_id IS
  'Tenant dueño del video. NULL = video PLATFORM-GLOBAL (lo subió el SuperAdmin), visible y referenciable por cualquier tenant.';

NOTIFY pgrst, 'reload schema';

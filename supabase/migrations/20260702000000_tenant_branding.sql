-- ──────────────────────────────────────────────────────────────────────
-- Branding del tenant: secondary_color + bucket tenant-logos.
--
-- Hasta ahora `tenants` tenia `logo_url` (TEXT) que el admin pegaba
-- manualmente. Bajo este modelo el admin tenia que subir el logo a un
-- hosting externo, lo cual es friccion. Ahora ofrecemos upload directo
-- al bucket `tenant-logos` de Supabase Storage.
--
-- Cambios:
--   1. tenants.secondary_color TEXT (hex opcional) — el color que
--      acompaña al primario en la app (ej. acentos, hovers).
--   2. tenants.logo_path TEXT — ruta dentro del bucket
--      `tenant-logos/<tenant_id>/logo.<ext>`. logo_url queda para
--      retrocompat (URLs externas legacy); el cliente prefiere logo_path
--      si esta seteado.
--   3. Bucket `tenant-logos` con RLS:
--      - SELECT abierto a authenticated — los logos los ven todos los
--        usuarios de la institución.
--      - INSERT/UPDATE/DELETE solo Admin de su tenant o SuperAdmin.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS secondary_color TEXT,
  ADD COLUMN IF NOT EXISTS logo_path TEXT;

COMMENT ON COLUMN public.tenants.secondary_color IS
  'Color acento de la institucion (hex). Aplica en hovers, badges secundarios. Opcional.';
COMMENT ON COLUMN public.tenants.logo_path IS
  'Path dentro del bucket tenant-logos. Forma: <tenant_id>/logo.<ext>. NULL si el admin no subio logo o usa logo_url externa.';

-- ─── Bucket de logos ─────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'tenant-logos',
  'tenant-logos',
  TRUE,  -- publico: los logos los pinta el browser desde el bucket via URL publica.
  2 * 1024 * 1024,  -- 2 MB max por logo (suficiente para PNG/SVG razonable)
  ARRAY['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public = EXCLUDED.public,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- ─── RLS de storage.objects para el bucket ──────────────────────────
DROP POLICY IF EXISTS "tenant_logos_select" ON storage.objects;
CREATE POLICY "tenant_logos_select"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'tenant-logos');

-- INSERT/UPDATE/DELETE: Admin de SU tenant (la carpeta es <tenant_id>)
-- o SuperAdmin. Resolvemos tenant_id desde el path:
--   tenant-logos/<tenant_id>/logo.<ext>
-- → (storage.foldername(name))[1] = tenant_id.
DROP POLICY IF EXISTS "tenant_logos_insert" ON storage.objects;
CREATE POLICY "tenant_logos_insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'tenant-logos'
    AND (
      public.is_super_admin()
      OR (
        public.has_role(auth.uid(), 'Admin'::public.app_role)
        AND (storage.foldername(name))[1] = public.current_tenant_id()::text
      )
    )
  );

DROP POLICY IF EXISTS "tenant_logos_update" ON storage.objects;
CREATE POLICY "tenant_logos_update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'tenant-logos'
    AND (
      public.is_super_admin()
      OR (
        public.has_role(auth.uid(), 'Admin'::public.app_role)
        AND (storage.foldername(name))[1] = public.current_tenant_id()::text
      )
    )
  );

DROP POLICY IF EXISTS "tenant_logos_delete" ON storage.objects;
CREATE POLICY "tenant_logos_delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'tenant-logos'
    AND (
      public.is_super_admin()
      OR (
        public.has_role(auth.uid(), 'Admin'::public.app_role)
        AND (storage.foldername(name))[1] = public.current_tenant_id()::text
      )
    )
  );

-- ─── RPC admin_update_my_tenant: aceptar tambien secondary_color y logo_path ─
-- Extension de la RPC que ya existe (mig 20260628000000). Reemplazamos
-- la firma agregando dos parametros opcionales al final para mantener
-- retrocompat con llamadas viejas.
DROP FUNCTION IF EXISTS public.admin_update_my_tenant(TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.admin_update_my_tenant(
  _name            TEXT,
  _logo_url        TEXT DEFAULT NULL,
  _primary_color   TEXT DEFAULT NULL,
  _email_domain    TEXT DEFAULT NULL,
  _secondary_color TEXT DEFAULT NULL,
  _logo_path       TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid     UUID := auth.uid();
  v_tenant  UUID;
  v_is_adm  BOOLEAN;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;

  SELECT
    public.has_role(v_uid, 'Admin'::public.app_role)
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = v_uid AND role::text = 'SuperAdmin'
    )
  INTO v_is_adm;

  IF NOT v_is_adm THEN
    RAISE EXCEPTION 'Permiso denegado: requiere rol Admin' USING ERRCODE = '42501';
  END IF;

  SELECT public.current_tenant_id() INTO v_tenant;
  IF v_tenant IS NULL THEN
    RAISE EXCEPTION 'Tu usuario no tiene institucion asignada' USING ERRCODE = 'P0001';
  END IF;

  IF _name IS NULL OR length(trim(_name)) = 0 THEN
    RAISE EXCEPTION 'El nombre de la institucion no puede estar vacio'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.tenants
     SET name            = trim(_name),
         logo_url        = NULLIF(trim(COALESCE(_logo_url, '')), ''),
         primary_color   = NULLIF(trim(COALESCE(_primary_color, '')), ''),
         email_domain    = LOWER(NULLIF(trim(COALESCE(_email_domain, '')), '')),
         secondary_color = NULLIF(trim(COALESCE(_secondary_color, '')), ''),
         logo_path       = NULLIF(trim(COALESCE(_logo_path, '')), ''),
         updated_at      = now()
   WHERE id = v_tenant;

  BEGIN
    INSERT INTO public.audit_logs (
      actor_id, action, category, severity, entity_type, entity_id, entity_name
    )
    VALUES (
      v_uid,
      'tenant.updated',
      'tenants',
      'info',
      'tenant',
      v_tenant::text,
      trim(_name)
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_update_my_tenant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT)
  TO authenticated;

NOTIFY pgrst, 'reload schema';

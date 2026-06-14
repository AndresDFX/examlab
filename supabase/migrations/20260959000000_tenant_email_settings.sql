-- ═══════════════════════════════════════════════════════════════════════
-- Configuración de envío de correo POR TENANT.
--
-- Hasta ahora el SMTP era GLOBAL (env vars SMTP_HOST/PORT/USER/PASSWORD/
-- EMAIL_FROM en el edge send-email) → TODOS los tenants compartían la misma
-- cuenta (p. ej. una sola cuenta Gmail). Eso significa que el límite/throttle
-- de ese proveedor es compartido (de ahí los `421 4.3.0 Temporary System
-- Problem ... gsmtp` cuando un tenant manda muchos correos).
--
-- Esta tabla permite que cada institución configure su PROPIO SMTP desde la
-- plataforma. El edge send-email resuelve el tenant del DESTINATARIO y, si
-- ese tenant tiene `use_custom_smtp = true` con credenciales completas, usa
-- las suyas; si no, cae al SMTP global (env) — comportamiento actual.
--
-- Seguridad: `smtp_password` se guarda en la fila (no hay secret store por
-- tenant). La RLS lo restringe a SuperAdmin y al Admin del propio tenant; el
-- edge lo lee con service_role. No se expone a Docente/Estudiante.
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.tenant_email_settings (
  tenant_id       UUID PRIMARY KEY REFERENCES public.tenants(id) ON DELETE CASCADE,
  use_custom_smtp BOOLEAN NOT NULL DEFAULT false,
  smtp_host       TEXT,
  smtp_port       INTEGER,
  smtp_user       TEXT,
  smtp_password   TEXT,
  email_from      TEXT,
  email_from_name TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.tenant_email_settings ENABLE ROW LEVEL SECURITY;

-- SELECT: SuperAdmin (cualquier tenant) o Admin del propio tenant.
DROP POLICY IF EXISTS tenant_email_settings_select ON public.tenant_email_settings;
CREATE POLICY tenant_email_settings_select
  ON public.tenant_email_settings FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- INSERT/UPDATE: idem (SA todo; Admin solo su tenant).
DROP POLICY IF EXISTS tenant_email_settings_insert ON public.tenant_email_settings;
CREATE POLICY tenant_email_settings_insert
  ON public.tenant_email_settings FOR INSERT TO authenticated
  WITH CHECK (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

DROP POLICY IF EXISTS tenant_email_settings_update ON public.tenant_email_settings;
CREATE POLICY tenant_email_settings_update
  ON public.tenant_email_settings FOR UPDATE TO authenticated
  USING (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  )
  WITH CHECK (
    public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin') AND tenant_id = public.current_tenant_id())
  );

-- DELETE: solo SuperAdmin.
DROP POLICY IF EXISTS tenant_email_settings_delete ON public.tenant_email_settings;
CREATE POLICY tenant_email_settings_delete
  ON public.tenant_email_settings FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- Seed: una fila por tenant existente, heredando el SMTP global
-- (use_custom_smtp = false). Así la tabla queda poblada y editable.
INSERT INTO public.tenant_email_settings (tenant_id, use_custom_smtp)
SELECT id, false FROM public.tenants
ON CONFLICT (tenant_id) DO NOTHING;

-- "Replicar el de Camacho al FESNA": como Camacho hoy usa el SMTP GLOBAL
-- (no tiene custom), replicar = dejar a FESNA igual (global). Copiamos la
-- fila de Camacho a la de FESNA explícitamente para que queden idénticas
-- (match por nombre, defensivo: si algún tenant no existe, no hace nada).
DO $$
DECLARE
  _camacho UUID;
  _fesna   UUID;
BEGIN
  SELECT id INTO _camacho FROM public.tenants
   WHERE name ILIKE '%camacho%' OR slug ILIKE '%camacho%' OR slug = 'uniaj'
   ORDER BY created_at ASC LIMIT 1;
  SELECT id INTO _fesna FROM public.tenants
   WHERE name ILIKE '%fesna%' OR slug ILIKE '%fesna%'
   ORDER BY created_at ASC LIMIT 1;

  IF _camacho IS NOT NULL AND _fesna IS NOT NULL THEN
    UPDATE public.tenant_email_settings dst
       SET use_custom_smtp = src.use_custom_smtp,
           smtp_host       = src.smtp_host,
           smtp_port       = src.smtp_port,
           smtp_user       = src.smtp_user,
           smtp_password   = src.smtp_password,
           email_from      = src.email_from,
           email_from_name = src.email_from_name,
           updated_at      = now()
      FROM public.tenant_email_settings src
     WHERE src.tenant_id = _camacho
       AND dst.tenant_id = _fesna;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

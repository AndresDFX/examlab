-- ──────────────────────────────────────────────────────────────────────
-- Multitenant — Fase E: singletons → per-tenant.
--
-- Antes: cada una de estas tablas tenía una sola fila para toda la
-- plataforma (UNIQUE INDEX parcial WHERE true / WHERE is_active=true).
-- Después: una fila por tenant. Cada tenant tiene su propia
-- configuración de correos, compilador, retención de auditoría, etc.
--
-- Tablas afectadas:
--   - email_settings
--   - code_execution_settings
--   - audit_retention_settings
--   - app_settings
--   - content_brand_config
--   - ai_model_settings   (cuidado: usa UNIQUE PARTIAL is_active=true)
--   - push_config         (si existe)
--
-- Patrón aplicado a cada una:
--   1) Asegurar columna `tenant_id` (Fase C ya la agregó al backfill)
--   2) DROP el UNIQUE INDEX viejo (global) — lo redefinimos por tenant
--   3) CREATE UNIQUE INDEX nuevo sobre (tenant_id)
--   4) RESTRICTIVE policy de aislamiento (Fase D ya cubre via DO block
--      si la tabla estaba en su lista; si no, se agrega acá)
--   5) Función helper que asegura, al crear un nuevo tenant, las filas
--      default de configuración para ese tenant
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) email_settings ───────────────────────────────────────────────
-- El UNIQUE original era por id=1 (PK fijo). Lo reemplazamos por
-- UNIQUE(tenant_id) para que haya UNA fila por tenant.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='email_settings') THEN
    -- Asegurar columna tenant_id (puede haberse omitido si email_settings
    -- no estaba en la lista de Fase C — agregamos defensivamente).
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='email_settings' AND column_name='tenant_id') THEN
      ALTER TABLE public.email_settings ADD COLUMN tenant_id UUID;
      UPDATE public.email_settings SET tenant_id = (SELECT id FROM public.tenants WHERE slug='examlab' LIMIT 1)
        WHERE tenant_id IS NULL;
      ALTER TABLE public.email_settings ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE public.email_settings
        ADD CONSTRAINT email_settings_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;

    -- Asegurar único por tenant
    DROP INDEX IF EXISTS public.email_settings_singleton;
    CREATE UNIQUE INDEX IF NOT EXISTS email_settings_one_per_tenant
      ON public.email_settings(tenant_id);

    -- Si la PK era `id=1`, la dejamos pero ya no es la razón del singleton
    -- (el UNIQUE(tenant_id) lo es).

    -- RESTRICTIVE de aislamiento
    DROP POLICY IF EXISTS tenant_isolation ON public.email_settings;
    CREATE POLICY tenant_isolation
      ON public.email_settings AS RESTRICTIVE
      FOR ALL TO authenticated
      USING (public.has_tenant_access(tenant_id))
      WITH CHECK (public.has_tenant_access(tenant_id));
  END IF;
END $$;

-- ── 2) code_execution_settings ──────────────────────────────────────
-- El UNIQUE original era parcial sobre is_active=true. Lo reemplazamos
-- por UNIQUE(tenant_id) WHERE is_active=true (un activo por tenant).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='code_execution_settings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='code_execution_settings' AND column_name='tenant_id') THEN
      ALTER TABLE public.code_execution_settings ADD COLUMN tenant_id UUID;
      UPDATE public.code_execution_settings SET tenant_id = (SELECT id FROM public.tenants WHERE slug='examlab' LIMIT 1)
        WHERE tenant_id IS NULL;
      ALTER TABLE public.code_execution_settings ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE public.code_execution_settings
        ADD CONSTRAINT code_execution_settings_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;

    DROP INDEX IF EXISTS public.code_execution_settings_one_active;
    CREATE UNIQUE INDEX IF NOT EXISTS code_execution_settings_one_active_per_tenant
      ON public.code_execution_settings(tenant_id)
      WHERE is_active = true;

    DROP POLICY IF EXISTS tenant_isolation ON public.code_execution_settings;
    CREATE POLICY tenant_isolation
      ON public.code_execution_settings AS RESTRICTIVE
      FOR ALL TO authenticated
      USING (public.has_tenant_access(tenant_id))
      WITH CHECK (public.has_tenant_access(tenant_id));
  END IF;
END $$;

-- ── 3) audit_retention_settings ─────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='audit_retention_settings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='audit_retention_settings' AND column_name='tenant_id') THEN
      ALTER TABLE public.audit_retention_settings ADD COLUMN tenant_id UUID;
      UPDATE public.audit_retention_settings SET tenant_id = (SELECT id FROM public.tenants WHERE slug='examlab' LIMIT 1)
        WHERE tenant_id IS NULL;
      ALTER TABLE public.audit_retention_settings ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE public.audit_retention_settings
        ADD CONSTRAINT audit_retention_settings_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;

    DROP INDEX IF EXISTS public.audit_retention_settings_singleton;
    CREATE UNIQUE INDEX IF NOT EXISTS audit_retention_settings_one_per_tenant
      ON public.audit_retention_settings(tenant_id);

    DROP POLICY IF EXISTS tenant_isolation ON public.audit_retention_settings;
    CREATE POLICY tenant_isolation
      ON public.audit_retention_settings AS RESTRICTIVE
      FOR ALL TO authenticated
      USING (public.has_tenant_access(tenant_id))
      WITH CHECK (public.has_tenant_access(tenant_id));
  END IF;
END $$;

-- ── 4) app_settings ─────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='app_settings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='app_settings' AND column_name='tenant_id') THEN
      ALTER TABLE public.app_settings ADD COLUMN tenant_id UUID;
      UPDATE public.app_settings SET tenant_id = (SELECT id FROM public.tenants WHERE slug='examlab' LIMIT 1)
        WHERE tenant_id IS NULL;
      ALTER TABLE public.app_settings ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE public.app_settings
        ADD CONSTRAINT app_settings_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;

    DROP INDEX IF EXISTS public.app_settings_singleton;
    CREATE UNIQUE INDEX IF NOT EXISTS app_settings_one_per_tenant
      ON public.app_settings(tenant_id);

    DROP POLICY IF EXISTS tenant_isolation ON public.app_settings;
    CREATE POLICY tenant_isolation
      ON public.app_settings AS RESTRICTIVE
      FOR ALL TO authenticated
      USING (public.has_tenant_access(tenant_id))
      WITH CHECK (public.has_tenant_access(tenant_id));
  END IF;
END $$;

-- ── 5) content_brand_config ─────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='content_brand_config') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='content_brand_config' AND column_name='tenant_id') THEN
      ALTER TABLE public.content_brand_config ADD COLUMN tenant_id UUID;
      UPDATE public.content_brand_config SET tenant_id = (SELECT id FROM public.tenants WHERE slug='examlab' LIMIT 1)
        WHERE tenant_id IS NULL;
      ALTER TABLE public.content_brand_config ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE public.content_brand_config
        ADD CONSTRAINT content_brand_config_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;

    DROP INDEX IF EXISTS public.content_brand_config_singleton;
    CREATE UNIQUE INDEX IF NOT EXISTS content_brand_config_one_per_tenant
      ON public.content_brand_config(tenant_id);

    DROP POLICY IF EXISTS tenant_isolation ON public.content_brand_config;
    CREATE POLICY tenant_isolation
      ON public.content_brand_config AS RESTRICTIVE
      FOR ALL TO authenticated
      USING (public.has_tenant_access(tenant_id))
      WITH CHECK (public.has_tenant_access(tenant_id));
  END IF;
END $$;

-- ── 6) ai_model_settings ────────────────────────────────────────────
-- UNIQUE original era parcial: WHERE is_active=true.
-- Mantenemos esa semántica pero scoped por tenant.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='ai_model_settings') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='ai_model_settings' AND column_name='tenant_id') THEN
      ALTER TABLE public.ai_model_settings ADD COLUMN tenant_id UUID;
      UPDATE public.ai_model_settings SET tenant_id = (SELECT id FROM public.tenants WHERE slug='examlab' LIMIT 1)
        WHERE tenant_id IS NULL;
      ALTER TABLE public.ai_model_settings ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE public.ai_model_settings
        ADD CONSTRAINT ai_model_settings_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;

    -- El índice original puede tener un nombre variable; intentamos los comunes.
    DROP INDEX IF EXISTS public.ai_model_settings_one_active;
    DROP INDEX IF EXISTS public.ai_model_settings_active_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS ai_model_settings_one_active_per_tenant
      ON public.ai_model_settings(tenant_id)
      WHERE is_active = true;

    DROP POLICY IF EXISTS tenant_isolation ON public.ai_model_settings;
    CREATE POLICY tenant_isolation
      ON public.ai_model_settings AS RESTRICTIVE
      FOR ALL TO authenticated
      USING (public.has_tenant_access(tenant_id))
      WITH CHECK (public.has_tenant_access(tenant_id));
  END IF;
END $$;

-- ── 7) push_config (si existe) ──────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='push_config') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema='public' AND table_name='push_config' AND column_name='tenant_id') THEN
      ALTER TABLE public.push_config ADD COLUMN tenant_id UUID;
      UPDATE public.push_config SET tenant_id = (SELECT id FROM public.tenants WHERE slug='examlab' LIMIT 1)
        WHERE tenant_id IS NULL;
      ALTER TABLE public.push_config ALTER COLUMN tenant_id SET NOT NULL;
      ALTER TABLE public.push_config
        ADD CONSTRAINT push_config_tenant_id_fkey
        FOREIGN KEY (tenant_id) REFERENCES public.tenants(id) ON DELETE CASCADE;
    END IF;

    DROP INDEX IF EXISTS public.push_config_singleton;
    CREATE UNIQUE INDEX IF NOT EXISTS push_config_one_per_tenant
      ON public.push_config(tenant_id);

    DROP POLICY IF EXISTS tenant_isolation ON public.push_config;
    CREATE POLICY tenant_isolation
      ON public.push_config AS RESTRICTIVE
      FOR ALL TO authenticated
      USING (public.has_tenant_access(tenant_id))
      WITH CHECK (public.has_tenant_access(tenant_id));
  END IF;
END $$;

-- ── Auto-seed de configuración default al crear un nuevo tenant ─────
-- Cuando el Superadmin crea un tenant, este trigger crea filas vacías
-- de configuración para ese tenant para que los Admins no encuentren
-- pantallas vacías al entrar por primera vez.

CREATE OR REPLACE FUNCTION public._seed_tenant_defaults()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- email_settings: kill switch encendido, todas las categorías ON
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='email_settings') THEN
    INSERT INTO public.email_settings (tenant_id, globally_enabled, enabled_kinds)
    VALUES (NEW.id, true, '{}'::jsonb)
    ON CONFLICT (tenant_id) DO NOTHING;
  END IF;

  -- code_execution_settings: onlinecompiler por default
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='code_execution_settings') THEN
    INSERT INTO public.code_execution_settings (tenant_id, provider, is_active)
    VALUES (NEW.id, 'onlinecompiler', true)
    ON CONFLICT DO NOTHING;
  END IF;

  -- audit_retention_settings: 0 = sin purga (cada tenant decide)
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='audit_retention_settings') THEN
    INSERT INTO public.audit_retention_settings (tenant_id, info_days, warning_days, error_days)
    VALUES (NEW.id, 0, 0, 0)
    ON CONFLICT (tenant_id) DO NOTHING;
  END IF;

  -- content_brand_config: usa los colores del tenant si están seteados
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='public' AND table_name='content_brand_config') THEN
    INSERT INTO public.content_brand_config (tenant_id, university_name, primary_color, secondary_color)
    VALUES (NEW.id, COALESCE(NEW.name, ''), COALESCE(NEW.primary_color, '#1e40af'), COALESCE(NEW.secondary_color, '#64748b'))
    ON CONFLICT (tenant_id) DO NOTHING;
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_seed_tenant_defaults ON public.tenants;
CREATE TRIGGER trg_seed_tenant_defaults
  AFTER INSERT ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public._seed_tenant_defaults();

NOTIFY pgrst, 'reload schema';

-- ──────────────────────────────────────────────────────────────────────
-- Multitenant — Fase A: fundación.
--
-- Crea la tabla `tenants`, el rol `Superadmin`, helpers SQL para
-- resolver el tenant del usuario actual, y un tenant inicial al que
-- pertenecerán todos los datos existentes.
--
-- IMPORTANTE: esta migración por sí sola NO aisla nada. Solo establece
-- la estructura. Las migraciones B/C/D que vienen después agregan
-- `tenant_id` a todas las tablas y reescriben las RLS.
--
-- Decisiones de diseño confirmadas:
--  - 1 usuario = 1 tenant (excepto Superadmin que es global)
--  - Subdomain identifica al tenant (fallback: query param ?tenant=slug)
--  - Solo invitación (no self-signup)
--  - Superadmin con acceso completo a todos los tenants
--  - Cuotas con enforcement básico desde día 1
--  - Tenant inicial: slug='examlab', name='ExamLab' (editable después desde
--    el panel Superadmin → Tenants → Editar). El SLUG es inmutable post
--    creación porque se usa en URLs; el NAME sí es editable.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. Rol Superadmin ────────────────────────────────────────────────
-- Lo agregamos al enum existente `app_role`. Postgres no permite agregar
-- valores a un enum dentro de una transacción si se referencia en otra
-- statement de la misma transacción; por eso lo agregamos en su propio
-- bloque con COMMIT explícito.

ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'Superadmin';

-- ── 2. Tabla `tenants` ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,49}$'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'trial')),

  -- Contacto / admin primario (se popula al crear el tenant)
  contact_email TEXT,
  primary_admin_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  -- Cuotas y límites — NULL = ilimitado. Triggers en fases siguientes
  -- enforzarán estos límites al INSERT en las tablas relevantes.
  max_users INT CHECK (max_users IS NULL OR max_users > 0),
  max_courses INT CHECK (max_courses IS NULL OR max_courses > 0),
  max_storage_mb INT CHECK (max_storage_mb IS NULL OR max_storage_mb > 0),
  ai_credits_remaining INT CHECK (ai_credits_remaining IS NULL OR ai_credits_remaining >= 0),

  -- Branding rápido (alternativa pre-tenant a content_brand_config)
  logo_url TEXT,
  primary_color TEXT,
  secondary_color TEXT,

  -- Dominio personalizado opcional (para subdomain ya está el slug)
  custom_domain TEXT UNIQUE,

  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at TIMESTAMPTZ,
  suspended_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  suspension_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON public.tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_slug   ON public.tenants(slug);

DROP TRIGGER IF EXISTS trg_tenants_updated_at ON public.tenants;
CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 3. Tenant inicial — todos los datos existentes pasan acá ─────────
-- Slug 'examlab'. El NAME 'ExamLab' es placeholder y el Superadmin lo puede
-- renombrar después desde el panel (el ID sigue siendo la FK real, no
-- el name ni el slug).
--
-- Idempotencia: ON CONFLICT (slug) DO NOTHING para no fallar si la
-- migración se re-ejecuta.

INSERT INTO public.tenants (slug, name, status)
VALUES ('examlab', 'ExamLab', 'active')
ON CONFLICT (slug) DO NOTHING;

DO $$
DECLARE
  _tenant_id UUID;
BEGIN
  SELECT id INTO _tenant_id FROM public.tenants WHERE slug = 'examlab' LIMIT 1;
  IF _tenant_id IS NULL THEN
    RAISE EXCEPTION 'No fue posible crear el tenant inicial "examlab". Aborta.';
  END IF;
  RAISE NOTICE 'Tenant inicial verificado: slug=examlab id=%', _tenant_id;
END $$;

-- ── 4. RLS de la tabla `tenants` ──────────────────────────────────────

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

-- SELECT: cualquier authenticated puede ver SU tenant (para mostrar nombre,
-- logo en la UI). Solo Superadmin ve todos.
DROP POLICY IF EXISTS "tenants_select" ON public.tenants;
CREATE POLICY "tenants_select"
  ON public.tenants FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Superadmin')
    OR id = public.current_tenant_id_safe()
  );

-- INSERT/UPDATE/DELETE: solo Superadmin. Crear y administrar tenants es
-- exclusivo del superadmin.
DROP POLICY IF EXISTS "tenants_write" ON public.tenants;
CREATE POLICY "tenants_write"
  ON public.tenants FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Superadmin'))
  WITH CHECK (public.has_role(auth.uid(), 'Superadmin'));

-- ── 5. Helpers SQL ───────────────────────────────────────────────────

-- current_tenant_id_safe: lee del JWT `app_metadata.tenant_id` o (legacy)
-- de profiles. Función separada de la policy para evitar recursión RLS.
-- Devuelve NULL si no se puede resolver (e.g., Superadmin sin tenant
-- activo todavía).

CREATE OR REPLACE FUNCTION public.current_tenant_id_safe()
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _t UUID;
  _claim TEXT;
BEGIN
  -- 1) Intentar leer del JWT (preferido). Supabase mete app_metadata en
  --    el JWT bajo la key 'app_metadata' → 'tenant_id'.
  BEGIN
    _claim := nullif(current_setting('request.jwt.claims', true), '')::jsonb
              -> 'app_metadata' ->> 'tenant_id';
    IF _claim IS NOT NULL THEN
      _t := _claim::uuid;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    _t := NULL;
  END;

  -- 2) Fallback: leer del profile (durante transición, antes de que el
  --    JWT hook esté completamente desplegado).
  IF _t IS NULL AND auth.uid() IS NOT NULL THEN
    SELECT tenant_id INTO _t
      FROM public.profiles
      WHERE id = auth.uid()
      LIMIT 1;
  END IF;

  RETURN _t;
END
$$;

REVOKE ALL ON FUNCTION public.current_tenant_id_safe() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_tenant_id_safe() TO authenticated, anon, service_role;

-- has_tenant_access(target_tenant_id): true si el usuario es Superadmin
-- O si current_tenant_id_safe() = target_tenant_id. Usado por RLS de
-- las tablas con tenant_id en las fases siguientes.

CREATE OR REPLACE FUNCTION public.has_tenant_access(_target_tenant_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _is_super BOOLEAN;
BEGIN
  -- Superadmin tiene acceso a TODOS los tenants
  _is_super := public.has_role(auth.uid(), 'Superadmin');
  IF _is_super THEN
    RETURN TRUE;
  END IF;
  -- Resto: solo su propio tenant
  RETURN _target_tenant_id IS NOT NULL
    AND _target_tenant_id = public.current_tenant_id_safe();
END
$$;

REVOKE ALL ON FUNCTION public.has_tenant_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_tenant_access(UUID) TO authenticated, anon, service_role;

-- ── 6. RPC público: resolver tenant por slug ──────────────────────────
-- Lo usa el cliente ANTES de loguearse para detectar el tenant del
-- subdomain o query param, y aplicar branding al login. Solo expone
-- datos públicos (nombre, logo, colores). No incluye contact_email,
-- cuotas, etc.

CREATE OR REPLACE FUNCTION public.resolve_tenant_by_slug(_slug TEXT)
RETURNS TABLE(
  id UUID,
  slug TEXT,
  name TEXT,
  status TEXT,
  logo_url TEXT,
  primary_color TEXT,
  secondary_color TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, slug, name, status, logo_url, primary_color, secondary_color
    FROM public.tenants
    WHERE slug = lower(_slug)
      AND status IN ('active', 'trial')
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_tenant_by_slug(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_tenant_by_slug(TEXT) TO anon, authenticated;

-- ── 7. Auditoría obligatoria de superadmin accediendo a tenants ──────
-- Cualquier acción que el Superadmin haga en `tenants` queda registrada
-- por el trigger `_audit_tenant_action`. Esto es transparencia: aunque
-- el Superadmin tenga acceso completo, queda rastro.

CREATE OR REPLACE FUNCTION public._audit_tenant_action()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _row_id TEXT;
  _row_name TEXT;
  _action TEXT;
BEGIN
  _action := lower(TG_OP);  -- 'insert' | 'update' | 'delete'
  IF TG_OP = 'DELETE' THEN
    _row_id := OLD.id::text;
    _row_name := OLD.name;
  ELSE
    _row_id := NEW.id::text;
    _row_name := NEW.name;
  END IF;

  INSERT INTO public.audit_logs (
    actor_id, action, category, severity, entity_type, entity_id, entity_name, metadata
  ) VALUES (
    auth.uid(),
    'tenant.' || _action,
    'system',
    'warning',
    'tenant',
    _row_id,
    _row_name,
    CASE
      WHEN TG_OP = 'UPDATE' THEN jsonb_build_object('before', to_jsonb(OLD), 'after', to_jsonb(NEW))
      WHEN TG_OP = 'INSERT' THEN jsonb_build_object('new', to_jsonb(NEW))
      WHEN TG_OP = 'DELETE' THEN jsonb_build_object('deleted', to_jsonb(OLD))
    END
  );
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_audit_tenant_action ON public.tenants;
CREATE TRIGGER trg_audit_tenant_action
  AFTER INSERT OR UPDATE OR DELETE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public._audit_tenant_action();

NOTIFY pgrst, 'reload schema';

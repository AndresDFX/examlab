-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy Fase 1: Foundation.
--
-- Permite que la plataforma aloje múltiples instituciones (universidades,
-- institutos, colegios, academias). Esta fase NO cambia el comportamiento
-- de RLS de otras tablas — eso lo hacen las fases siguientes
-- (academic backbone, content, cross-cutting, globals). Después de
-- aplicar esta migración la app sigue funcionando exactamente igual con
-- un único tenant "default" donde quedan todos los usuarios existentes.
--
-- Entregables:
--   1. Tabla `tenants` (id, slug, name, branding) — la fuente de verdad
--      de qué instituciones existen.
--   2. `profiles.tenant_id` — a qué institución pertenece un usuario.
--      NULLABLE temporalmente hasta que la Fase 6 cierre invitaciones.
--   3. Rol SuperAdmin (cross-tenant) — agregado al enum app_role.
--   4. Helpers SQL: `current_tenant_id()`, `is_super_admin()`,
--      `same_tenant(user_a, user_b)`.
--   5. Backfill: crea tenant "default" (slug='default') y asigna a todos
--      los usuarios existentes.
--
-- Decisiones:
--   - El `tenant_id` actual se resuelve por `profiles.tenant_id` del
--     `auth.uid()`. NO usamos JWT claims — es más simple y respeta el
--     "single source of truth" en DB. Si un usuario pertenece a varios
--     tenants en el futuro, agregaremos una tabla `user_tenants` y la
--     función leerá un override session-set por el cliente.
--   - SuperAdmin vive en `user_roles` igual que los demás roles. RLS
--     respeta `has_role(uid, 'SuperAdmin')` como bypass cross-tenant.
--   - `tenants.slug` se usará en URLs (`/t/<slug>/app/...`). Lowercase,
--     alfanumérico + guiones, 3..50 chars. CHECK constraint lo enforza.
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Agregar 'SuperAdmin' al enum app_role ─────────────────────────
ALTER TYPE public.app_role ADD VALUE IF NOT EXISTS 'SuperAdmin';

-- ─── 2) Tabla tenants ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- slug se usa en la URL: /t/<slug>/app/...
  slug            TEXT NOT NULL UNIQUE
                  CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$' OR length(slug) BETWEEN 3 AND 50),
  name            TEXT NOT NULL,
  -- Branding institucional (se mostrará en PageHeader, login, certificados).
  -- Cuando la Fase 5 mueva certificate_settings a per-tenant, eso será
  -- el override fino; estos campos son el fallback rápido.
  logo_url        TEXT,
  primary_color   TEXT,   -- hex "#3B82F6" opcional
  -- Dominio email para auto-asignación opcional (Fase 6 lo usa si el
  -- admin la activa). Ej: "uniandes.edu.co" → cualquier @uniandes.edu.co
  -- cae a este tenant.
  email_domain    TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;

CREATE TRIGGER tenants_updated_at
  BEFORE UPDATE ON public.tenants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Índice de búsqueda por slug (caso típico en URL routing).
CREATE INDEX IF NOT EXISTS tenants_slug_idx ON public.tenants(slug);
CREATE INDEX IF NOT EXISTS tenants_email_domain_idx ON public.tenants(email_domain)
  WHERE email_domain IS NOT NULL;

COMMENT ON TABLE public.tenants IS
  'Instituciones (universidades / institutos / colegios / academias) que comparten el deploy. Cada tenant aísla sus usuarios, cursos, programas y contenido vía RLS.';

-- ─── 3) Backfill: tenant "default" + todos los usuarios ──────────────
-- Crea el tenant default solo si no existe (idempotente).
INSERT INTO public.tenants (slug, name)
SELECT 'default', 'Institución'
WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug = 'default');

-- ─── 4) profiles.tenant_id ───────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE RESTRICT;

-- Backfill: todos los profiles existentes → tenant default. NULL solo
-- queda para usuarios que se creen entre que esta migración corre y la
-- Fase 6 ata el sign-up flow — esos casos los maneja la lógica de
-- invitación (que rechaza profile sin tenant_id).
UPDATE public.profiles
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

CREATE INDEX IF NOT EXISTS profiles_tenant_id_idx ON public.profiles(tenant_id);

COMMENT ON COLUMN public.profiles.tenant_id IS
  'Institución a la que pertenece este usuario. NULL solo durante la ventana de invitación pendiente (profile creado pero el admin no ha asignado tenant). RLS de tablas tenant-scoped exige NOT NULL.';

-- ─── 5) Helpers SQL ──────────────────────────────────────────────────

-- current_tenant_id(): tenant del usuario autenticado. Devuelve NULL si
-- no hay sesión o el profile no tiene tenant_id (caso transitorio).
-- STABLE para que la planner la cachée dentro del query.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS UUID
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT tenant_id FROM public.profiles WHERE id = auth.uid();
$$;

GRANT EXECUTE ON FUNCTION public.current_tenant_id() TO authenticated;

COMMENT ON FUNCTION public.current_tenant_id() IS
  'Tenant del usuario autenticado. Usado por RLS de todas las tablas tenant-scoped en las fases 2-5. SECURITY DEFINER porque profiles tiene RLS estricta y queremos resolver el tenant sin recursión.';

-- is_super_admin(): bypass cross-tenant. Mantiene la misma forma que
-- has_role para que las policies puedan usar `OR is_super_admin()` de
-- forma legible.
--
-- IMPORTANTE: usamos `role::text = 'SuperAdmin'` en vez de
-- `'SuperAdmin'::public.app_role`. Postgres prohíbe USAR un valor recién
-- agregado al enum dentro de la misma transacción en la que se hizo el
-- ADD VALUE (error: "unsafe use of new value of enum type"). El cast de
-- la COLUMNA a text esquiva ese problema — la query funcional es
-- idéntica.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = auth.uid() AND role::text = 'SuperAdmin'
  );
$$;

GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

COMMENT ON FUNCTION public.is_super_admin() IS
  'TRUE si el usuario actual tiene el rol SuperAdmin (cross-tenant). Usado por RLS para permitir acceso global sin filtro de tenant_id.';

-- same_tenant(): predicado para checks rápidos en RLS donde un usuario
-- accede a un recurso de otro (ej: docente leyendo profile de su
-- estudiante). Cubre el caso comun "ambos están en mi tenant".
CREATE OR REPLACE FUNCTION public.same_tenant(_other_user UUID)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.profiles p1
      JOIN public.profiles p2 ON p2.tenant_id = p1.tenant_id
     WHERE p1.id = auth.uid()
       AND p2.id = _other_user
  );
$$;

GRANT EXECUTE ON FUNCTION public.same_tenant(UUID) TO authenticated;

-- ─── 6) RLS para tenants ─────────────────────────────────────────────
-- SELECT: cualquier authenticated puede ver SU tenant. SuperAdmin ve
-- todos. Esto permite al cliente cargar el branding del propio tenant
-- sin permisos especiales. NO exponemos `is_active=false` a usuarios
-- normales (eso lo controla la app, no RLS — Fase 6 lo afina si hace
-- falta).
DROP POLICY IF EXISTS tenants_select ON public.tenants;
CREATE POLICY tenants_select
  ON public.tenants FOR SELECT TO authenticated
  USING (id = public.current_tenant_id() OR public.is_super_admin());

-- INSERT/UPDATE/DELETE: solo SuperAdmin. La Fase 6 podrá habilitar
-- "Admin de tenant edita su propia institución" si querés, pero por
-- defecto los tenants son inmutables desde la app excepto para SuperAdmin.
DROP POLICY IF EXISTS tenants_insert ON public.tenants;
CREATE POLICY tenants_insert
  ON public.tenants FOR INSERT TO authenticated
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS tenants_update ON public.tenants;
CREATE POLICY tenants_update
  ON public.tenants FOR UPDATE TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS tenants_delete ON public.tenants;
CREATE POLICY tenants_delete
  ON public.tenants FOR DELETE TO authenticated
  USING (public.is_super_admin());

-- ─── 7) profiles RLS: respeta tenant + super_admin ──────────────────
-- La policy existente de profiles (mig original) permite SELECT/UPDATE
-- de mi propio profile + lectura per-rol. La Fase 6 extiende esto a
-- "Admin ve profiles de su tenant". Por ahora NO modificamos las
-- policies existentes — solo agregamos `is_super_admin()` como bypass
-- en lecturas si hace falta más adelante. La columna tenant_id ya está
-- presente para que las fases siguientes la usen.

-- ─── 8) Trigger: profile nuevo con tenant_id por defecto ─────────────
-- Si la app crea un profile sin tenant_id, lo seteamos al tenant
-- default automáticamente. Esto cubre el período transitorio entre que
-- esta migración corre y la Fase 6 cierra el sign-up. La Fase 6
-- reemplaza este trigger por uno que rechace profile sin invitación.
CREATE OR REPLACE FUNCTION public.tg_profile_default_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    SELECT id INTO NEW.tenant_id FROM public.tenants WHERE slug = 'default' LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_default_tenant ON public.profiles;
CREATE TRIGGER trg_profile_default_tenant
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_profile_default_tenant();

NOTIFY pgrst, 'reload schema';

-- ──────────────────────────────────────────────────────────────────────
-- Override del color de letra sobre las superficies con branding del
-- tenant (principalmente el sidebar — el resto de la app tiene fondo
-- mayormente blanco/oscuro y los textos siguen el theme default).
--
-- Antes:
--   TenantThemeProvider derivaba el foreground por luminancia: si el
--   primario era oscuro → texto blanco; si era claro → texto casi
--   negro. Funciona bien en el 95% de casos pero no respeta marcas con
--   un color de texto institucional específico (ej. crema, azul muy
--   oscuro, gris perla).
--
-- Ahora:
--   `tenants.text_color` (nullable). Si está seteado, manda — el
--   provider lo usa como `--sidebar-foreground` y `--primary-foreground`.
--   Si es NULL → comportamiento previo (auto-derivado por luminancia).
--
-- Validamos formato hex con CHECK para evitar valores sucios; el
-- TenantThemeProvider además sanitiza al leer.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS text_color TEXT,
  -- icon_color: override del color de los íconos del sidebar nav. Si
  -- NULL, los íconos heredan el text_color (o el derivado del primario
  -- por luminancia). Útil cuando la marca quiere íconos en un color
  -- contrastante con el texto (ej. íconos amarillos sobre texto blanco
  -- en un sidebar azul).
  ADD COLUMN IF NOT EXISTS icon_color TEXT;

-- Limpieza defensiva: si alguien insertó algo no-hex via SQL directo
-- antes de añadir el CHECK, lo normalizamos a NULL para no fallar el
-- ADD CONSTRAINT.
UPDATE public.tenants
   SET text_color = NULL
 WHERE text_color IS NOT NULL
   AND text_color !~ '^#[0-9a-fA-F]{6}$';
UPDATE public.tenants
   SET icon_color = NULL
 WHERE icon_color IS NOT NULL
   AND icon_color !~ '^#[0-9a-fA-F]{6}$';

-- CHECK: hex de 6 dígitos con `#` adelante. Coincide con la regex del
-- cliente (`/^#[0-9a-fA-F]{6}$/`).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name = 'tenants_text_color_format'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_text_color_format
      CHECK (text_color IS NULL OR text_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_name = 'tenants_icon_color_format'
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_icon_color_format
      CHECK (icon_color IS NULL OR icon_color ~ '^#[0-9a-fA-F]{6}$');
  END IF;
END
$$;

-- ─── RPC admin_update_my_tenant: aceptar text_color + icon_color ────
-- Extendemos la firma con dos parámetros opcionales al final para
-- mantener retrocompat con llamadas viejas. Cambio de firma → necesita
-- DROP previo (Postgres no permite cambiar el número de args con
-- CREATE OR REPLACE).
DROP FUNCTION IF EXISTS public.admin_update_my_tenant(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.admin_update_my_tenant(
  _name            TEXT,
  _logo_url        TEXT DEFAULT NULL,
  _primary_color   TEXT DEFAULT NULL,
  _email_domain    TEXT DEFAULT NULL,
  _secondary_color TEXT DEFAULT NULL,
  _logo_path       TEXT DEFAULT NULL,
  _text_color      TEXT DEFAULT NULL,
  _icon_color      TEXT DEFAULT NULL
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
         text_color      = NULLIF(trim(COALESCE(_text_color, '')), ''),
         icon_color      = NULLIF(trim(COALESCE(_icon_color, '')), ''),
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

GRANT EXECUTE ON FUNCTION public.admin_update_my_tenant(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

NOTIFY pgrst, 'reload schema';

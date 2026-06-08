-- ──────────────────────────────────────────────────────────────────────
-- admin_visible_passwords
--
-- Permite que un Admin (de su tenant) o un SuperAdmin puedan RE-VER la
-- contraseña temporal que ELLOS MISMOS asignaron al crear o resetear un
-- usuario, para poder comunicársela.
--
-- ⚠️ TRADEOFF DE SEGURIDAD ACEPTADO EXPLÍCITAMENTE: esta tabla guarda la
-- contraseña en TEXTO PLANO. Mitigaciones:
--   1. RLS estricta: solo la lee un SuperAdmin, o un Admin del MISMO
--      tenant que el dueño de la fila. Nadie más.
--   2. Sin policies de escritura para clientes: solo el service_role
--      (las edge functions bulk-import-users / admin-update-password)
--      escribe. La UI únicamente lee.
--   3. La fila se BORRA automáticamente cuando el usuario cambia su
--      contraseña (must_change_password pasa de true → false): a partir de
--      ahí la temporal ya no es válida y no tiene sentido conservarla.
--
-- NO es un mecanismo de "recuperar la contraseña actual" de un usuario —
-- las contraseñas de auth.users están hasheadas (bcrypt) y no se pueden
-- des-hashear. Esto solo expone la contraseña TEMPORAL conocida en el
-- momento de crearla/resetearla.
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.admin_visible_passwords (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Tenant del dueño de la contraseña, para que la RLS del Admin acote a
  -- su institución. NULL = usuario sin tenant (solo visible al SuperAdmin).
  tenant_id   UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
  password    TEXT NOT NULL,
  set_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  set_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_visible_passwords ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS admin_visible_passwords_tenant_idx
  ON public.admin_visible_passwords(tenant_id);

-- ─── RLS: SELECT solo SuperAdmin o Admin del mismo tenant ───────────────
DROP POLICY IF EXISTS avp_select ON public.admin_visible_passwords;
CREATE POLICY avp_select ON public.admin_visible_passwords
  FOR SELECT TO authenticated
  USING (
    public.is_super_admin()
    OR (
      public.has_role(auth.uid(), 'Admin')
      AND tenant_id IS NOT DISTINCT FROM public.current_tenant_id()
    )
  );

-- NO definimos policies de INSERT/UPDATE/DELETE: los clientes NO deben
-- escribir contraseñas en claro. El service_role de las edges bypassa la
-- RLS, y el trigger de limpieza es SECURITY DEFINER — ambos escriben sin
-- necesidad de policy.

-- ─── Limpieza automática al cambiar la contraseña ──────────────────────
-- Cuando must_change_password pasa de true → false (el usuario ya definió
-- su propia contraseña), la temporal guardada queda obsoleta → borrarla.
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    CREATE OR REPLACE FUNCTION public.tg_clear_visible_password()
    RETURNS TRIGGER
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
    AS $fn$
    BEGIN
      IF OLD.must_change_password IS DISTINCT FROM NEW.must_change_password
         AND NEW.must_change_password = false THEN
        DELETE FROM public.admin_visible_passwords WHERE user_id = NEW.id;
      END IF;
      RETURN NEW;
    END;
    $fn$;

    DROP TRIGGER IF EXISTS tg_clear_visible_password ON public.profiles;
    CREATE TRIGGER tg_clear_visible_password
      AFTER UPDATE OF must_change_password ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.tg_clear_visible_password();
  END IF;
END $$;

COMMENT ON TABLE public.admin_visible_passwords IS
  'Contraseña TEMPORAL en claro que un Admin/SuperAdmin asignó al crear/resetear un usuario, para poder re-verla y comunicarla. RLS: SA o Admin del mismo tenant. Se autoborra cuando el usuario cambia su contraseña.';

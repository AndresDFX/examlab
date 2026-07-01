-- ══════════════════════════════════════════════════════════════════════
-- Mensajería: eximir al SuperAdmin del check de tenant de conversations.
--
-- Hallazgo (workflow validación de errores, 2026-07-01): dos guardas no
-- concordaban. `can_message(Admin, SuperAdmin)` devuelve TRUE (por diseño el
-- SuperAdmin recibe mensajes de los Admins de tenants — 20260903), pero
-- `tg_conversations_tenant_check` (BEFORE INSERT en conversations) hace RAISE
-- cuando `tenant_id` de cualquiera de los dos es NULL — y el SuperAdmin tiene
-- `tenant_id IS NULL`. Resultado: `open_conversation(<SA>)` desde un Admin
-- revienta con "Uno de los usuarios no tiene institución asignada" y el Admin
-- NO puede escribirle al SuperAdmin, contradiciendo can_message.
--
-- Fix: eximir al SuperAdmin (si user_a o user_b tiene rol SuperAdmin → RETURN
-- NEW), paralelo a como `tg_check_profile_tenant_change` ya exime al SA. El
-- bloqueo cross-tenant real (Admin de tenant A ↔ usuario de tenant B) se
-- mantiene para todos los demás.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_conversations_tenant_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_ta UUID;
  v_tb UUID;
BEGIN
  -- El SuperAdmin opera cross-tenant (tenant_id NULL). can_message ya permite
  -- Admin↔SA; sin esta exención el trigger bloqueaba crear esa conversación.
  IF public.has_role(NEW.user_a, 'SuperAdmin'::app_role)
     OR public.has_role(NEW.user_b, 'SuperAdmin'::app_role) THEN
    RETURN NEW;
  END IF;
  SELECT tenant_id INTO v_ta FROM public.profiles WHERE id = NEW.user_a;
  SELECT tenant_id INTO v_tb FROM public.profiles WHERE id = NEW.user_b;
  IF v_ta IS NULL OR v_tb IS NULL THEN
    RAISE EXCEPTION 'Uno de los usuarios no tiene institución asignada'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_ta <> v_tb THEN
    RAISE EXCEPTION 'No se puede iniciar una conversación entre usuarios de instituciones distintas'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

NOTIFY pgrst, 'reload schema';

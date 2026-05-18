-- ──────────────────────────────────────────────────────────────────────
-- Multitenant — Fase I: enforcement de cuotas por tenant.
--
-- Triggers BEFORE INSERT que rechazan la operación si el tenant excede
-- su cuota configurada. NULL en `tenants.max_*` significa "sin límite".
--
-- Cuotas implementadas:
--   - max_users          → cuenta filas en `profiles` por tenant
--   - max_courses        → cuenta filas en `courses` por tenant
--   - max_storage_mb     → no enforzable en DB (storage es Supabase Storage)
--                          se documentará para futuro check vía edge function
--   - ai_credits_remaining → se decrementa al llamar a edge functions de IA
--                          (se hace fuera de DB; acá solo el check al consumir)
--
-- Mensaje de error claro para que el Admin del tenant sepa qué cuota se
-- alcanzó y a quién pedirle aumento (al Superadmin).
-- ──────────────────────────────────────────────────────────────────────

-- ── max_users ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._enforce_max_users()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _limit INT;
  _current INT;
BEGIN
  -- Superadmin global no cuenta (tenant_id NULL)
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT max_users INTO _limit FROM public.tenants WHERE id = NEW.tenant_id;
  IF _limit IS NULL THEN
    RETURN NEW; -- sin límite
  END IF;

  SELECT COUNT(*) INTO _current FROM public.profiles WHERE tenant_id = NEW.tenant_id;
  IF _current >= _limit THEN
    RAISE EXCEPTION 'Cuota alcanzada: este tenant tiene % usuarios y el máximo permitido es %. Contacta al Superadministrador para aumentar el límite.',
      _current, _limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_enforce_max_users ON public.profiles;
CREATE TRIGGER trg_enforce_max_users
  BEFORE INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public._enforce_max_users();

-- ── max_courses ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._enforce_max_courses()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _limit INT;
  _current INT;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT max_courses INTO _limit FROM public.tenants WHERE id = NEW.tenant_id;
  IF _limit IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*) INTO _current FROM public.courses WHERE tenant_id = NEW.tenant_id;
  IF _current >= _limit THEN
    RAISE EXCEPTION 'Cuota alcanzada: este tenant tiene % cursos y el máximo permitido es %. Contacta al Superadministrador para aumentar el límite.',
      _current, _limit
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_enforce_max_courses ON public.courses;
CREATE TRIGGER trg_enforce_max_courses
  BEFORE INSERT ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public._enforce_max_courses();

-- ── Verificación del tenant: bloquear logins si suspended ──
-- No podemos bloquear el login mismo (Supabase Auth es opaco), pero
-- SÍ podemos rechazar todas las INSERT/UPDATE del usuario via trigger
-- universal en profiles si el tenant está suspended.
--
-- Más simple: el cliente verifica `tenant.status` al boot. Si es
-- 'suspended', muestra pantalla bloqueante. Igual ponemos guard
-- adicional en DB para evitar abuso si el cliente se salta el check.

CREATE OR REPLACE FUNCTION public._block_suspended_tenant_writes()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _status TEXT;
BEGIN
  IF NEW.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT status INTO _status FROM public.tenants WHERE id = NEW.tenant_id;
  IF _status = 'suspended' THEN
    RAISE EXCEPTION 'Tu tenant está suspendido. Contacta al Superadministrador.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END
$$;

-- Aplicar el check a tablas críticas de escritura
DO $$
DECLARE
  _t TEXT;
  _tables TEXT[];
BEGIN
  _tables := ARRAY[
    'courses',
    'exams',
    'workshops',
    'projects',
    'submissions',
    'workshop_submissions',
    'project_submissions',
    'attendance_records',
    'notifications',
    'generated_contents',
    'forum_threads',
    'forum_replies',
    'tutor_chat_sessions',
    'tutor_chat_messages',
    'certificates'
  ];

  FOREACH _t IN ARRAY _tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name=_t AND column_name='tenant_id'
    ) THEN
      EXECUTE format(
        'DROP TRIGGER IF EXISTS %I ON public.%I',
        'trg_block_suspended_' || _t, _t
      );
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public._block_suspended_tenant_writes()',
        'trg_block_suspended_' || _t, _t
      );
    END IF;
  END LOOP;
END $$;

-- ── RPC público: chequear status del tenant ──
-- El cliente lo llama al boot. Si retorna 'suspended', muestra pantalla
-- bloqueante en lugar del login normal.

CREATE OR REPLACE FUNCTION public.check_tenant_status(_slug TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT status FROM public.tenants WHERE slug = lower(_slug) LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.check_tenant_status(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_tenant_status(TEXT) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';

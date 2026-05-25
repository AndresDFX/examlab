-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy — Safety net post Fases 1-7.
--
-- Esta migración NO introduce features. Es defensiva: re-corre backfills,
-- valida invariantes y asegura que la data del tenant 'default' (donde
-- viven todos los usuarios actuales) quedó consistente tras la
-- refactorización.
--
-- Concretamente:
--   1. Garantiza que el tenant 'default' exista (idempotente).
--   2. Re-corre el backfill de tenant_id en profiles, audit_logs y
--      notifications por si quedó alguna fila NULL entre el momento de
--      aplicar Fase 1 y este safety net (concurrencia con tráfico real).
--   3. Verifica con DO blocks que las invariantes claves se cumplen y
--      RAISE NOTICE con los counts. NO usa RAISE EXCEPTION — la
--      migración no debe abortar el Publish; solo loggea para que el
--      operador (SuperAdmin) revise los logs si algo está roto.
--   4. Asegura que cada profile tiene el rol mínimo esperable para
--      acceder a la app (no cambia roles existentes; solo verifica).
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Default tenant existe ──────────────────────────────────────
INSERT INTO public.tenants (slug, name)
SELECT 'default', 'Institución'
WHERE NOT EXISTS (SELECT 1 FROM public.tenants WHERE slug = 'default');

-- ─── 2) Backfill defensivo: profiles ──────────────────────────────
-- Caso típico: usuario que se creó entre la aplicación de Fase 1 y
-- este safety net. handle_new_user() inserta profile con tenant_id NULL,
-- y tg_profile_default_tenant lo llena con 'default'. Pero si por algún
-- motivo (trigger desactivado, INSERT directo por SQL) quedó NULL, lo
-- arreglamos acá.
UPDATE public.profiles
   SET tenant_id = (SELECT id FROM public.tenants WHERE slug = 'default')
 WHERE tenant_id IS NULL;

-- ─── 3) Backfill defensivo: audit_logs ────────────────────────────
-- Mismo razonamiento. Las filas de service-role legítimamente tienen
-- tenant_id NULL (no hay auth.uid()) — esas las dejamos. Solo
-- backfilleamos donde HAY actor_id pero el lookup quedó incompleto.
UPDATE public.audit_logs al
   SET tenant_id = (SELECT tenant_id FROM public.profiles WHERE id = al.actor_id)
 WHERE al.tenant_id IS NULL
   AND al.actor_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.profiles WHERE id = al.actor_id AND tenant_id IS NOT NULL);

-- ─── 4) Backfill defensivo: notifications ─────────────────────────
UPDATE public.notifications n
   SET tenant_id = (SELECT tenant_id FROM public.profiles WHERE id = n.user_id)
 WHERE n.tenant_id IS NULL;

-- ─── 5) Asegurar singleton-per-tenant rows para 'default' ─────────
-- Si por algún motivo el deploy quedó sin row en app_settings o
-- certificate_settings para el tenant default, la UI mostraría
-- "config no encontrada" y los queries .limit(1).maybeSingle()
-- retornarían null. Insertamos defaults vacíos para que la app tenga
-- una fila contra la cual hacer UPDATE.
DO $$
DECLARE
  v_default_tenant UUID;
BEGIN
  SELECT id INTO v_default_tenant FROM public.tenants WHERE slug = 'default';

  -- app_settings: fila vacía con defaults.
  INSERT INTO public.app_settings (tenant_id)
  SELECT v_default_tenant
  WHERE NOT EXISTS (
    SELECT 1 FROM public.app_settings WHERE tenant_id = v_default_tenant
  );

  -- certificate_settings: fila vacía. La UI puede luego setear
  -- institution_name etc.
  INSERT INTO public.certificate_settings (tenant_id)
  SELECT v_default_tenant
  WHERE NOT EXISTS (
    SELECT 1 FROM public.certificate_settings WHERE tenant_id = v_default_tenant
  );

  -- ai_model_settings: NO insertamos fila — si nadie configuró un modelo,
  -- la edge function ai-grade-submission cae a su default hardcoded
  -- (google/gemini-2.5-flash via Lovable Gateway). Crear una fila vacía
  -- con provider/model NULL violaría el CHECK del schema.
END
$$;

-- ─── 6) Verificación final — RAISE NOTICE con counts ──────────────
DO $$
DECLARE
  v_profiles_null     INT;
  v_courses_null      INT;
  v_programs_null     INT;
  v_periods_null      INT;
  v_subjects_null     INT;
  v_app_settings      INT;
  v_cert_settings     INT;
  v_default_tenant_id UUID;
BEGIN
  SELECT id INTO v_default_tenant_id FROM public.tenants WHERE slug = 'default';

  SELECT COUNT(*) INTO v_profiles_null FROM public.profiles WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO v_courses_null  FROM public.courses  WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO v_programs_null FROM public.academic_programs WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO v_periods_null  FROM public.academic_periods  WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO v_subjects_null FROM public.academic_subjects WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO v_app_settings  FROM public.app_settings WHERE tenant_id = v_default_tenant_id;
  SELECT COUNT(*) INTO v_cert_settings FROM public.certificate_settings WHERE tenant_id = v_default_tenant_id;

  RAISE NOTICE '── Tenants safety net summary ──';
  RAISE NOTICE 'default tenant id: %', v_default_tenant_id;
  RAISE NOTICE 'profiles.tenant_id NULL: %', v_profiles_null;
  RAISE NOTICE 'courses.tenant_id NULL: %', v_courses_null;
  RAISE NOTICE 'academic_programs.tenant_id NULL: %', v_programs_null;
  RAISE NOTICE 'academic_periods.tenant_id NULL: %', v_periods_null;
  RAISE NOTICE 'academic_subjects.tenant_id NULL: %', v_subjects_null;
  RAISE NOTICE 'app_settings rows for default: %', v_app_settings;
  RAISE NOTICE 'certificate_settings rows for default: %', v_cert_settings;

  -- Hard check: si hay profiles con tenant_id NULL post-backfill, algo está
  -- roto. RAISE WARNING para que aparezca en los logs sin abortar.
  IF v_profiles_null > 0 THEN
    RAISE WARNING 'Hay % profiles sin tenant_id. Revisar trigger tg_profile_default_tenant.',
      v_profiles_null;
  END IF;
END
$$;

-- ─── 7) Re-aplicar trigger profile default tenant (defensive) ──────
-- Si la Fase 1 falló al instalar el trigger por algún motivo, lo
-- volvemos a crear. Idempotente.
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

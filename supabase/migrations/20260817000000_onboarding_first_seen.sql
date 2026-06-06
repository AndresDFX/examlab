-- ──────────────────────────────────────────────────────────────────────
-- Onboarding tour: tracking de "primera vez visto" + reset masivo
--                  + diagnóstico de estado actual de la BD.
--
-- Esta migración hace TRES cosas:
--
-- 1) **Diagnóstico** vía `RAISE NOTICE`. El output aparece en los logs
--    de Lovable durante el Publish — copialo y pegámelo para detectar
--    inconsistencias post-deploys recientes (papelera, snippets,
--    pizarra compartida, python_gui, etc.).
--
-- 2) **Nueva columna** `profiles.onboarding_first_seen_at TIMESTAMPTZ`.
--    Se setea UNA sola vez por usuario, la primera vez que el tour se
--    abre en su sesión (no necesariamente cuando lo completa). Permite
--    métricas tipo "X% de usuarios vio el tour" vs "X% lo completó".
--    Set vía RPC `mark_onboarding_first_seen` (SECURITY INVOKER,
--    idempotente: solo actualiza si está NULL).
--
-- 3) **Reset masivo** de `onboarding_completed_roles` a `'{}'` para
--    TODOS los profiles. Es para pruebas — todos los usuarios verán el
--    tour en su próximo login. Esta parte se puede revertir con un
--    backup manual si después se arrepienten (el dato perdido es solo
--    el flag de "ya vi el tour", no datos académicos).
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) DIAGNÓSTICO via RAISE NOTICE ─────────────────────────────────
DO $$
DECLARE
  v_count INT;
  v_text TEXT;
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
  RAISE NOTICE '  DIAGNÓSTICO POST-DEPLOY — ExamLab';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';

  -- 1.1 Tablas críticas que deberían existir post recientes deploys.
  RAISE NOTICE '';
  RAISE NOTICE '── Tablas nuevas (deben existir) ──';
  RAISE NOTICE '  session_code_snippets:           %', to_regclass('public.session_code_snippets');
  RAISE NOTICE '  whiteboard_pages:                %', to_regclass('public.whiteboard_pages');
  RAISE NOTICE '  question_bank:                   %', to_regclass('public.question_bank');
  RAISE NOTICE '  code_execution_settings:         %', to_regclass('public.code_execution_settings');

  -- 1.2 Columnas críticas (soft-delete + shared whiteboard + python_gui).
  RAISE NOTICE '';
  RAISE NOTICE '── Columnas críticas ──';

  SELECT array_to_string(array_agg(table_name ORDER BY table_name), ', ')
    INTO v_text
    FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name = 'deleted_at';
  RAISE NOTICE '  Tablas con deleted_at: %', COALESCE(v_text, '(ninguna)');

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'attendance_sessions'
       AND column_name = 'whiteboard_shared'
  ) INTO v_text;
  RAISE NOTICE '  attendance_sessions.whiteboard_shared: %', v_text;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'code_execution_settings'
       AND column_name = 'python_gui_provider'
  ) INTO v_text;
  RAISE NOTICE '  code_execution_settings.python_gui_provider: %', v_text;

  -- 1.3 RPCs nuevas.
  RAISE NOTICE '';
  RAISE NOTICE '── RPCs (deben existir) ──';
  SELECT string_agg(proname, ', ' ORDER BY proname)
    INTO v_text
    FROM pg_proc
   WHERE pronamespace = 'public'::regnamespace
     AND proname IN (
       'trash_restore_item',
       'trash_hard_delete_item',
       'purge_deleted_items',
       'update_session_whiteboard_scene',
       'set_session_whiteboard_shared',
       'mark_onboarding_complete',
       'reset_onboarding'
     );
  RAISE NOTICE '  Presentes: %', COALESCE(v_text, '(ninguna — algo muy mal)');

  -- 1.4 Cron jobs.
  RAISE NOTICE '';
  RAISE NOTICE '── Cron jobs ──';
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN
      SELECT string_agg(jobname || ' (' || schedule || ', active=' || active::text || ')', E'\n  ')
        INTO v_text
        FROM cron.job;
      RAISE NOTICE '  %', COALESCE(v_text, '(ninguno)');
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '  (sin permisos para leer cron.job o tabla vacía)';
    END;
  ELSE
    RAISE NOTICE '  pg_cron no instalado';
  END IF;

  -- 1.5 Conteos de papelera (items soft-deletados activos).
  RAISE NOTICE '';
  RAISE NOTICE '── Estado de la papelera (items con deleted_at != NULL) ──';
  IF to_regclass('public.courses') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.courses WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  courses:             %', v_count;
  END IF;
  IF to_regclass('public.exams') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.exams WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  exams:               %', v_count;
  END IF;
  IF to_regclass('public.workshops') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.workshops WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  workshops:           %', v_count;
  END IF;
  IF to_regclass('public.projects') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.projects WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  projects:            %', v_count;
  END IF;
  IF to_regclass('public.attendance_sessions') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.attendance_sessions WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  attendance_sessions: %', v_count;
  END IF;
  IF to_regclass('public.whiteboards') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.whiteboards WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  whiteboards:         %', v_count;
  END IF;
  IF to_regclass('public.generated_contents') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.generated_contents WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  generated_contents:  %', v_count;
  END IF;
  IF to_regclass('public.polls') IS NOT NULL THEN
    SELECT COUNT(*) INTO v_count FROM public.polls WHERE deleted_at IS NOT NULL;
    RAISE NOTICE '  polls:               %', v_count;
  END IF;

  -- 1.6 Onboarding state pre-reset.
  RAISE NOTICE '';
  RAISE NOTICE '── Onboarding (antes del reset) ──';
  SELECT COUNT(*) INTO v_count FROM public.profiles
   WHERE onboarding_completed_roles IS NOT NULL
     AND array_length(onboarding_completed_roles, 1) > 0;
  RAISE NOTICE '  Profiles que YA vieron el tour: %', v_count;
  SELECT COUNT(*) INTO v_count FROM public.profiles;
  RAISE NOTICE '  Profiles totales: %', v_count;

  RAISE NOTICE '';
  RAISE NOTICE '═══════════════════════════════════════════════════════════';
END $$;

-- ── 2) Columna nueva: onboarding_first_seen_at ──────────────────────
DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE NOTICE 'public.profiles no existe — abortando migración';
    RETURN;
  END IF;

  ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS onboarding_first_seen_at TIMESTAMPTZ;

  COMMENT ON COLUMN public.profiles.onboarding_first_seen_at IS
    'Timestamp del PRIMER login en el que el tour se abrió para este usuario. Idempotente (solo se setea cuando NULL). Permite distinguir entre "vio el tour" y "lo completó" (que vive en onboarding_completed_roles).';
END $$;

-- ── 3) RPC: mark_onboarding_first_seen ──────────────────────────────
-- Idempotente: solo actualiza si onboarding_first_seen_at IS NULL.
-- SECURITY INVOKER porque el usuario actualiza su PROPIO profile bajo RLS.
DROP FUNCTION IF EXISTS public.mark_onboarding_first_seen();
CREATE OR REPLACE FUNCTION public.mark_onboarding_first_seen()
RETURNS VOID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.profiles
     SET onboarding_first_seen_at = now()
   WHERE id = auth.uid()
     AND onboarding_first_seen_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_onboarding_first_seen() TO authenticated;

COMMENT ON FUNCTION public.mark_onboarding_first_seen() IS
  'Marca el primer momento en que el tour se abrió para el usuario actual. Idempotente: si ya está seteado, no hace nada. La llama el hook useOnboarding cuando shouldShowFor pasa de null a un rol.';

-- ── 4) RESET MASIVO (para pruebas) ──────────────────────────────────
-- Vacía onboarding_completed_roles en TODOS los profiles. En el próximo
-- login cada usuario verá el tour de nuevo. NO toca onboarding_first_seen_at
-- (es la primera vez que se usa esa columna; se setea en el próximo open).
--
-- Si en producción no querés que pase esto, comenta este bloque ANTES
-- de Publish. Pero el usuario lo pidió explícito para pruebas.
DO $$
DECLARE
  v_reset_count INT;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RETURN;
  END IF;
  UPDATE public.profiles
     SET onboarding_completed_roles = '{}'::TEXT[]
   WHERE onboarding_completed_roles IS NOT NULL
     AND array_length(onboarding_completed_roles, 1) > 0;
  GET DIAGNOSTICS v_reset_count = ROW_COUNT;
  RAISE NOTICE '── Reset masivo de onboarding ──';
  RAISE NOTICE '  Profiles afectados: % (todos verán el tour en su próximo login)', v_reset_count;
END $$;

NOTIFY pgrst, 'reload schema';

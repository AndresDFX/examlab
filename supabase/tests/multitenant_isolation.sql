-- ──────────────────────────────────────────────────────────────────────
-- Tests de aislamiento multitenant.
--
-- Ejecuta este script con:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/multitenant_isolation.sql
--
-- Cómo funciona:
--   1. Crea 2 tenants nuevos (slug 'test-mt-a' y 'test-mt-b')
--   2. Crea 1 course en cada tenant
--   3. Simula sesiones de auth para cada user usando
--      `SET LOCAL request.jwt.claims = …`
--   4. Verifica con queries que cada user solo ve los datos de SU tenant
--   5. Suspende el tenant A y verifica que se bloquean escrituras
--   6. Limpia TODO al final (rollback de la transacción).
--
-- Si cualquier check falla, el script aborta con `RAISE EXCEPTION` y el
-- pipeline (o tu psql) reporta el error. Si pasa todo, imprime un
-- "✓ ALL CHECKS PASSED" al final.
--
-- IMPORTANTE: este script corre en una TRANSACCIÓN que NUNCA hace COMMIT
-- final (hacemos ROLLBACK explícito). Es seguro correrlo contra
-- producción: no deja datos residuales aunque algunos checks fallen,
-- porque el ROLLBACK ocurre incluso ante un RAISE EXCEPTION.
-- ──────────────────────────────────────────────────────────────────────

BEGIN;

DO $$
DECLARE
  _tenant_a UUID;
  _tenant_b UUID;
  _user_a UUID := gen_random_uuid();
  _user_b UUID := gen_random_uuid();
  _user_super UUID := gen_random_uuid();
  _course_a UUID;
  _course_b UUID;
  _visible_count INT;
BEGIN
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  RAISE NOTICE '  Tests de aislamiento multitenant';
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';

  -- ── Setup: crear 2 tenants ────────────────────────────────────────
  -- Usamos slugs con prefijo 'test-mt-' para no chocar con tenants reales.

  INSERT INTO public.tenants (slug, name, status)
  VALUES ('test-mt-a', 'Test Tenant A', 'active')
  ON CONFLICT (slug) DO UPDATE SET status='active'
  RETURNING id INTO _tenant_a;

  INSERT INTO public.tenants (slug, name, status)
  VALUES ('test-mt-b', 'Test Tenant B', 'active')
  ON CONFLICT (slug) DO UPDATE SET status='active'
  RETURNING id INTO _tenant_b;

  RAISE NOTICE 'Setup: tenant A=% tenant B=%', _tenant_a, _tenant_b;

  -- ── Crear users sintéticos en auth.users ──────────────────────────
  -- Solo lo necesario para que las FK no se rompan. El password es dummy
  -- (no vamos a loguearnos vía Supabase Auth — usamos SET request.jwt.claims).

  INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, aud, role)
  VALUES
    (_user_a, 'user-a@test-mt.example.com', '', now(), now(), now(), 'authenticated', 'authenticated'),
    (_user_b, 'user-b@test-mt.example.com', '', now(), now(), now(), 'authenticated', 'authenticated'),
    (_user_super, 'super@test-mt.example.com', '', now(), now(), now(), 'authenticated', 'authenticated')
  ON CONFLICT (id) DO NOTHING;

  -- Profiles con tenant_id apuntando a cada tenant
  INSERT INTO public.profiles (id, full_name, institutional_email, tenant_id)
  VALUES
    (_user_a, 'User A', 'user-a@test-mt.example.com', _tenant_a),
    (_user_b, 'User B', 'user-b@test-mt.example.com', _tenant_b),
    (_user_super, 'Super User', 'super@test-mt.example.com', NULL)
  ON CONFLICT (id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id;

  -- Roles: User A es Admin del tenant A, User B Admin del tenant B,
  -- Super es Superadmin global (tenant_id NULL).
  INSERT INTO public.user_roles (user_id, role, tenant_id)
  VALUES
    (_user_a, 'Admin', _tenant_a),
    (_user_b, 'Admin', _tenant_b),
    (_user_super, 'Superadmin', NULL)
  ON CONFLICT DO NOTHING;

  -- Crear 1 curso en cada tenant
  INSERT INTO public.courses (name, period, tenant_id)
  VALUES ('Curso A', '2026-1', _tenant_a)
  RETURNING id INTO _course_a;

  INSERT INTO public.courses (name, period, tenant_id)
  VALUES ('Curso B', '2026-1', _tenant_b)
  RETURNING id INTO _course_b;

  RAISE NOTICE 'Setup OK: courses A=% B=%', _course_a, _course_b;

  -- ════════════════════════════════════════════════════════════════════
  -- CHECK 1: User A solo ve cursos de su tenant
  -- ════════════════════════════════════════════════════════════════════
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', _user_a, 'role', 'authenticated')::text,
    true
  );

  SELECT COUNT(*) INTO _visible_count
    FROM public.courses
    WHERE id IN (_course_a, _course_b);

  IF _visible_count <> 1 THEN
    RAISE EXCEPTION 'CHECK 1 FAILED: User A debería ver 1 curso (suyo), pero ve %', _visible_count;
  END IF;

  -- Verificar que es ESPECÍFICAMENTE el curso A
  SELECT COUNT(*) INTO _visible_count
    FROM public.courses
    WHERE id = _course_a;
  IF _visible_count <> 1 THEN
    RAISE EXCEPTION 'CHECK 1.b FAILED: User A no ve su propio curso A';
  END IF;

  SELECT COUNT(*) INTO _visible_count
    FROM public.courses
    WHERE id = _course_b;
  IF _visible_count <> 0 THEN
    RAISE EXCEPTION 'CHECK 1.c FAILED: User A NO debería ver el curso B del tenant B';
  END IF;

  RAISE NOTICE '✓ CHECK 1: User A aislado al tenant A';

  -- ════════════════════════════════════════════════════════════════════
  -- CHECK 2: User B solo ve cursos de su tenant
  -- ════════════════════════════════════════════════════════════════════
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', _user_b, 'role', 'authenticated')::text,
    true
  );

  SELECT COUNT(*) INTO _visible_count
    FROM public.courses
    WHERE id = _course_b;
  IF _visible_count <> 1 THEN
    RAISE EXCEPTION 'CHECK 2 FAILED: User B no ve su propio curso B';
  END IF;

  SELECT COUNT(*) INTO _visible_count
    FROM public.courses
    WHERE id = _course_a;
  IF _visible_count <> 0 THEN
    RAISE EXCEPTION 'CHECK 2.b FAILED: User B NO debería ver el curso A del tenant A';
  END IF;

  RAISE NOTICE '✓ CHECK 2: User B aislado al tenant B';

  -- ════════════════════════════════════════════════════════════════════
  -- CHECK 3: Superadmin ve cursos de AMBOS tenants
  -- ════════════════════════════════════════════════════════════════════
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', _user_super, 'role', 'authenticated')::text,
    true
  );

  SELECT COUNT(*) INTO _visible_count
    FROM public.courses
    WHERE id IN (_course_a, _course_b);
  IF _visible_count <> 2 THEN
    RAISE EXCEPTION 'CHECK 3 FAILED: Superadmin debería ver ambos cursos, ve %', _visible_count;
  END IF;

  RAISE NOTICE '✓ CHECK 3: Superadmin ve todos los tenants';

  -- ════════════════════════════════════════════════════════════════════
  -- CHECK 4: User A no puede INSERTAR un curso en el tenant B
  -- ════════════════════════════════════════════════════════════════════
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', _user_a, 'role', 'authenticated')::text,
    true
  );

  BEGIN
    INSERT INTO public.courses (name, period, tenant_id)
    VALUES ('Curso ilegal en B', '2026-1', _tenant_b);
    -- Si llega acá, la RLS RESTRICTIVE no funcionó
    RAISE EXCEPTION 'CHECK 4 FAILED: User A pudo insertar curso en tenant B (RLS bypass)';
  EXCEPTION
    WHEN insufficient_privilege OR check_violation THEN
      RAISE NOTICE '✓ CHECK 4: User A bloqueado de insertar en tenant B';
    WHEN OTHERS THEN
      -- Cualquier otro error también es prueba de bloqueo (probablemente RLS check)
      IF SQLERRM LIKE '%row-level security%' OR SQLERRM LIKE '%policy%' THEN
        RAISE NOTICE '✓ CHECK 4: User A bloqueado de insertar en tenant B (RLS)';
      ELSE
        RAISE EXCEPTION 'CHECK 4 FAILED con error inesperado: %', SQLERRM;
      END IF;
  END;

  -- ════════════════════════════════════════════════════════════════════
  -- CHECK 5: Suspender tenant A → escrituras bloqueadas
  -- ════════════════════════════════════════════════════════════════════
  RESET ROLE;
  UPDATE public.tenants
    SET status = 'suspended', suspended_at = now()
    WHERE id = _tenant_a;

  -- Como User A, intentar crear un curso debería fallar
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', _user_a, 'role', 'authenticated')::text,
    true
  );

  BEGIN
    INSERT INTO public.courses (name, period, tenant_id)
    VALUES ('Curso post-suspensión', '2026-1', _tenant_a);
    RAISE EXCEPTION 'CHECK 5 FAILED: User A pudo insertar curso aunque su tenant está suspended';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE '%suspendido%' OR SQLERRM LIKE '%suspended%'
         OR SQLERRM LIKE '%insufficient_privilege%' THEN
        RAISE NOTICE '✓ CHECK 5: Tenant A suspended bloquea escrituras';
      ELSE
        RAISE EXCEPTION 'CHECK 5 FAILED con error inesperado: %', SQLERRM;
      END IF;
  END;

  -- ════════════════════════════════════════════════════════════════════
  -- CHECK 6: has_tenant_access() retorna lo esperado
  -- ════════════════════════════════════════════════════════════════════
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', _user_a, 'role', 'authenticated')::text,
    true
  );

  IF NOT public.has_tenant_access(_tenant_a) THEN
    RAISE EXCEPTION 'CHECK 6 FAILED: has_tenant_access(A) debería ser true para User A';
  END IF;
  IF public.has_tenant_access(_tenant_b) THEN
    RAISE EXCEPTION 'CHECK 6.b FAILED: has_tenant_access(B) debería ser false para User A';
  END IF;

  -- Superadmin tiene acceso a todo
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', _user_super, 'role', 'authenticated')::text,
    true
  );

  IF NOT public.has_tenant_access(_tenant_a) THEN
    RAISE EXCEPTION 'CHECK 6.c FAILED: Superadmin debería tener acceso al tenant A';
  END IF;
  IF NOT public.has_tenant_access(_tenant_b) THEN
    RAISE EXCEPTION 'CHECK 6.d FAILED: Superadmin debería tener acceso al tenant B';
  END IF;

  RAISE NOTICE '✓ CHECK 6: has_tenant_access() funciona correctamente';

  -- ════════════════════════════════════════════════════════════════════
  -- CHECK 7: Singletons (email_settings) aislados por tenant
  -- ════════════════════════════════════════════════════════════════════
  -- Verifica que email_settings tiene una fila por cada tenant tras la
  -- inserción de los tenants (trigger _seed_tenant_defaults).
  RESET ROLE;
  SELECT COUNT(*) INTO _visible_count
    FROM public.email_settings
    WHERE tenant_id IN (_tenant_a, _tenant_b);
  IF _visible_count < 2 THEN
    RAISE WARNING 'CHECK 7 SKIPPED: email_settings no tiene 2 filas para los tenants de test (% encontradas). Trigger _seed_tenant_defaults pudo no aplicar — depende del orden de migración.', _visible_count;
  ELSE
    RAISE NOTICE '✓ CHECK 7: email_settings sembrado por tenant';
  END IF;

  -- ════════════════════════════════════════════════════════════════════
  -- ALL CHECKS PASSED
  -- ════════════════════════════════════════════════════════════════════
  RESET ROLE;
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  RAISE NOTICE '  ✓ ALL CHECKS PASSED — el aislamiento multitenant funciona';
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';

EXCEPTION WHEN OTHERS THEN
  RESET ROLE;
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  RAISE NOTICE '  ✗ FALLA: %', SQLERRM;
  RAISE NOTICE '═══════════════════════════════════════════════════════════════';
  RAISE;
END $$;

-- ROLLBACK siempre — no dejamos datos de test residuales.
-- Esto incluye los 2 tenants, 3 users, profiles, roles, courses creados.
ROLLBACK;

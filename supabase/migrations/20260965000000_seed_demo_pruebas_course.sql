-- ══════════════════════════════════════════════════════════════════════
-- Seed: "Curso de pruebas" en el tenant DEMO (ExamLab Demo) con TODOS los
-- usuarios del tenant asignados como DOCENTES.
--
-- Motivo: un Docente NO puede auto-asignarse como docente de un curso (la RLS
-- lo bloquea a propósito, y el dialog de docentes filtra al usuario actual).
-- Por eso los usuarios de la demo necesitan un curso YA listo donde todos son
-- docentes, para practicar la plataforma sin depender de auto-asignarse.
--
-- Idempotente + guard por tenant: si el tenant demo no existe en este entorno
-- (otra instalación), la migración es no-op. Si el curso ya existe (creado por
-- nombre), lo reutiliza; sólo agrega las membresías de docente que falten.
-- Corre con privilegios de migración → salta la RLS de course_teachers.
-- ══════════════════════════════════════════════════════════════════════

DO $seed$
DECLARE
  v_tenant uuid := '729b3114-bf5d-4433-ac0e-d1e3aedb1358'; -- ExamLab Demo
  v_course uuid;
  v_added  int;
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_teachers') IS NULL
     OR to_regclass('public.profiles') IS NULL THEN
    RAISE NOTICE 'skip demo seed: tabla(s) ausente(s)';
    RETURN;
  END IF;

  -- Tenant demo ausente (otro entorno) → no-op.
  IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = v_tenant) THEN
    RAISE NOTICE 'skip demo seed: tenant ExamLab Demo ausente en este entorno';
    RETURN;
  END IF;

  -- Find-or-create el "Curso de pruebas" (no borrado) del tenant demo.
  SELECT id INTO v_course
    FROM public.courses
   WHERE tenant_id = v_tenant
     AND name = 'Curso de pruebas'
     AND deleted_at IS NULL
   ORDER BY created_at
   LIMIT 1;

  IF v_course IS NULL THEN
    INSERT INTO public.courses
      (name, description, tenant_id, grade_scale_min, grade_scale_max, passing_grade)
    VALUES
      ('Curso de pruebas',
       'Curso compartido para practicar: todos los usuarios de la demo están asignados como docentes.',
       v_tenant, 0, 5, 3)
    RETURNING id INTO v_course;
    RAISE NOTICE 'demo seed: curso creado %', v_course;
  ELSE
    RAISE NOTICE 'demo seed: curso ya existía %', v_course;
  END IF;

  -- Asignar como docentes a TODOS los usuarios del tenant que aún no lo estén.
  INSERT INTO public.course_teachers (course_id, user_id)
  SELECT v_course, p.id
    FROM public.profiles p
   WHERE p.tenant_id = v_tenant
     AND NOT EXISTS (
       SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = v_course AND ct.user_id = p.id
     );
  GET DIAGNOSTICS v_added = ROW_COUNT;
  RAISE NOTICE 'demo seed: % docente(s) agregado(s) al curso de pruebas', v_added;
END
$seed$;

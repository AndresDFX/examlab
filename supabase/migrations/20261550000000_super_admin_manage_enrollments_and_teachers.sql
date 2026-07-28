-- ═══════════════════════════════════════════════════════════════════════
-- El SuperAdmin no podía MATRICULAR alumnos ni ASIGNAR docentes.
--
-- Síntoma de campo (2026-07-28, cargando dos cursos nuevos en FESNA): un
-- INSERT en `course_enrollments` o en `course_teachers` como SuperAdmin
-- devuelve `42501 new row violates row-level security policy`.
--
-- Causa: las policies de escritura (mig 20260528000000) son
--   `course_in_my_tenant(course_id) AND has_role(auth.uid(), 'Admin'|'Docente')`.
-- `course_in_my_tenant()` YA contempla `is_super_admin()`, así que la primera
-- mitad pasa; lo que corta es la segunda: `has_role` mira roles del tenant y el
-- SuperAdmin tiene `SuperAdmin`, no `Admin`. Además su `tenant_id` es NULL, así
-- que ninguna rama por-tenant lo alcanza.
--
-- Es el mismo hueco que la mig 20261071000000 ya cerró para el **SELECT** de
-- `course_enrollments` (`OR public.is_super_admin()`): la escritura quedó sin
-- cubrir. Mismo patrón que se aplicó en 20260903100000 para db_backups y en
-- 20260910000000 para email_settings — módulos escritos antes de que existiera
-- el rol SuperAdmin, que necesitaron la rama paralela.
--
-- Enfoque ADITIVO a propósito: se agrega una policy nueva SOLO para el
-- SuperAdmin en vez de recrear las de Admin/Docente. Tocar esas implicaría
-- reescribir el scope por tenant que hoy funciona — riesgo innecesario para
-- resolver un permiso que le falta a un rol distinto.
--
-- Idempotente: DROP IF EXISTS + CREATE. Defensiva: sale limpio si las tablas o
-- `is_super_admin()` no existen en el entorno (Lovable a veces marca
-- migraciones como aplicadas sin que el CREATE TABLE haya corrido, y una
-- migración que falla ABORTA el deploy completo).
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  -- Sin la función no hay nada que hacer (entorno sin el módulo multi-tenant).
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'is_super_admin'
  ) THEN
    RAISE NOTICE 'public.is_super_admin() no existe — se omite la migración.';
    RETURN;
  END IF;

  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    DROP POLICY IF EXISTS "enrollments_super_admin_manage" ON public.course_enrollments;
    CREATE POLICY "enrollments_super_admin_manage"
      ON public.course_enrollments FOR ALL TO authenticated
      USING (public.is_super_admin())
      WITH CHECK (public.is_super_admin());
  END IF;

  IF to_regclass('public.course_teachers') IS NOT NULL THEN
    DROP POLICY IF EXISTS "course_teachers_super_admin_manage" ON public.course_teachers;
    CREATE POLICY "course_teachers_super_admin_manage"
      ON public.course_teachers FOR ALL TO authenticated
      USING (public.is_super_admin())
      WITH CHECK (public.is_super_admin());
  END IF;
END $$;

-- PostgREST cachea el esquema; sin esto las policies nuevas pueden tardar en
-- verse reflejadas en las peticiones REST.
NOTIFY pgrst, 'reload schema';

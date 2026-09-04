-- ══════════════════════════════════════════════════════════════════════════
-- `course_schedules`: la rama de Admin no estaba acotada a la institución, y el
-- SuperAdmin no podía escribir.
--
-- ── Lo que había ─────────────────────────────────────────────────────────
-- `course_schedules_write` (mig 20260618000000) exigía
-- `has_role(auth.uid(),'Admin') OR <docente del curso>`.
--
-- Dos problemas, los dos ya documentados en CLAUDE.md como antipatrones:
--
-- 1. **`has_role()` suelto = fuga cross-tenant.** Los roles son GLOBALES, así que
--    `has_role('Admin')` sin `AND <scope de tenant>` deja que el Admin de CUALQUIER
--    institución escriba, cambie o borre el horario de un curso de otra. Es el mismo
--    hallazgo que las migs 20260929 / 20260945 / 20261045-48 fueron cerrando tabla por
--    tabla; esta quedó afuera porque es de junio y el barrido no la alcanzó.
--
-- 2. **El SuperAdmin no estaba.** La tabla es de junio, anterior a que el rol existiera
--    como operador real, así que el dueño de la plataforma no puede cargar el horario
--    de un curso — que es justo lo que hace al provisionar una institución. Se detectó
--    al cargar los cursos de un semestre real: `42501 new row violates row-level
--    security policy for table "course_schedules"`.
--
-- ── Lo que queda ─────────────────────────────────────────────────────────
-- SELECT: sin cambios (ya era `course_in_my_tenant`, que incluye `is_super_admin()`).
-- WRITE: docente del curso **o** Admin del tenant del curso **o** SuperAdmin.
--
-- `course_in_my_tenant()` ya cubre la rama del SuperAdmin por dentro, así que la
-- condición no la repite: `is_super_admin()` está ahí a propósito y por separado sólo
-- en el sentido de que ese helper lo contempla. Ver los helpers de 20260929000000.
-- ══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.course_schedules') IS NULL THEN
    RAISE NOTICE 'course_schedules no existe en este entorno; nada que hacer.';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "course_schedules_write" ON public.course_schedules;
  CREATE POLICY "course_schedules_write"
    ON public.course_schedules FOR ALL TO authenticated
    USING (
      public.course_in_my_tenant(course_schedules.course_id)
      AND (
        EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = course_schedules.course_id AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
    )
    WITH CHECK (
      public.course_in_my_tenant(course_schedules.course_id)
      AND (
        EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = course_schedules.course_id AND ct.user_id = auth.uid()
        )
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
    );
END $$;

NOTIFY pgrst, 'reload schema';

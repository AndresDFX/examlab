-- ──────────────────────────────────────────────────────────────────────
-- course_enrollments.user_id FK: ON UPDATE CASCADE.
--
-- Contexto: la mig 20260906000000 (`handle_new_user_tolerate_unique`)
-- introdujo re-vinculación de profiles huérfanos cuando hay
-- UNIQUE violation por `institutional_email` durante el bulk import.
-- La re-vinculación hace `UPDATE profiles SET id = NEW.id WHERE id = <old>`.
--
-- `course_enrollments.user_id` referencia `profiles.id` con `ON DELETE
-- CASCADE` pero `ON UPDATE NO ACTION` (default). Si el profile huérfano
-- tenía enrollments (caso poco común pero posible si el bulk-import
-- anterior alcanzó a llegar al INSERT en course_enrollments antes de
-- fallar), el UPDATE del id rompe la FK y rollback-ea todo →
-- "Database error creating new user" continúa.
--
-- Fix: cambiar la FK a `ON UPDATE CASCADE` para que el UPDATE del
-- profile.id propague automáticamente al enrollment. La parte CASCADE
-- on DELETE se mantiene (default y deseado: borrar enrollment cuando se
-- borra el alumno).
--
-- Aplicable también si en el futuro se hacen otras re-vinculaciones
-- de profiles (merge de cuentas, etc.).
-- ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_constraint_name TEXT;
BEGIN
  -- Buscar el nombre exacto de la FK (puede variar entre entornos según
  -- cómo se creó la tabla; usamos pg_constraint para resolver).
  SELECT con.conname INTO v_constraint_name
    FROM pg_constraint con
    JOIN pg_class cls ON con.conrelid = cls.oid
    JOIN pg_namespace ns ON cls.relnamespace = ns.oid
   WHERE ns.nspname = 'public'
     AND cls.relname = 'course_enrollments'
     AND con.contype = 'f'
     AND con.confrelid = 'public.profiles'::regclass
   LIMIT 1;

  IF v_constraint_name IS NULL THEN
    RAISE NOTICE 'No se encontró FK de course_enrollments.user_id → profiles.id, omitiendo';
    RETURN;
  END IF;

  -- Dropear la vieja y recrear con ON UPDATE CASCADE.
  EXECUTE format(
    'ALTER TABLE public.course_enrollments DROP CONSTRAINT %I',
    v_constraint_name
  );

  ALTER TABLE public.course_enrollments
    ADD CONSTRAINT course_enrollments_user_profile_fk
    FOREIGN KEY (user_id) REFERENCES public.profiles(id)
    ON UPDATE CASCADE
    ON DELETE CASCADE;
END $$;

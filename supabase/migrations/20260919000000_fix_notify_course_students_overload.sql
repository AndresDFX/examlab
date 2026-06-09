-- ──────────────────────────────────────────────────────────────────────
-- Fix: `notify_course_students` tenía DOS overloads coexistiendo:
--   (UUID, TEXT, TEXT, TEXT, TEXT)              -- mig 20260419080000 (original)
--   (UUID, TEXT, TEXT, TEXT, TEXT, TEXT)        -- mig 20260513220000 (+ _source_role)
-- El `CREATE OR REPLACE` del de 6 args NO reemplazó al de 5 (firma distinta),
-- así que ambos quedaron en la DB. Una llamada con 5 argumentos —p. ej. el
-- trigger `_notify_content_assigned_to_session` al ASIGNAR contenido a una
-- sesión (PERFORM notify_course_students(course_id,'titulo','cuerpo',
-- 'content','/app/...')), donde los literales string llegan como `unknown`—
-- matchea AMBOS overloads y Postgres aborta con:
--   "function public.notify_course_students(uuid, unknown, text, unknown,
--    unknown) is not unique"
-- bloqueando la asignación de contenido a cursos/sesiones.
--
-- Solución: dropear el overload viejo de 5 args. El de 6 args lo cubre por
-- completo (su 6º parámetro `_source_role` tiene DEFAULT NULL, así que toda
-- llamada de 5 args resuelve a él sin cambios de comportamiento). Todos los
-- callers (triggers SQL + `db.rpc("notify_course_students", {...})` del
-- front, que pasa args nombrados) siguen funcionando contra el de 6 args.
--
-- Defensivo: si el de 5 args no existiera (entorno ya limpio), el
-- `IF EXISTS` lo hace no-op. Si el de 6 args faltara (entorno raro), lo
-- re-creamos al final como red de seguridad sería excesivo — la mig
-- 20260513220000 ya lo define; acá solo nos aseguramos del GRANT.
-- ──────────────────────────────────────────────────────────────────────

DROP FUNCTION IF EXISTS public.notify_course_students(UUID, TEXT, TEXT, TEXT, TEXT);

-- Re-aseguramos el EXECUTE sobre el overload sobreviviente (6 args), por si
-- el grant viejo apuntaba a la firma dropeada.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'notify_course_students'
      AND pg_get_function_identity_arguments(p.oid) =
          '_course_id uuid, _title text, _body text, _kind text, _link text, _source_role text'
  ) THEN
    GRANT EXECUTE ON FUNCTION public.notify_course_students(UUID, TEXT, TEXT, TEXT, TEXT, TEXT)
      TO authenticated;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

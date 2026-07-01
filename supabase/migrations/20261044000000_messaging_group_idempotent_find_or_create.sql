-- ══════════════════════════════════════════════════════════════════════
-- Mensajería/grupos: hacer idempotentes los find-or-create ante carrera.
--
-- Hallazgo (workflow de errores, 2026-07-01): open_conversation,
-- find_or_create_adhoc_group y find_or_create_course_group hacen
-- check-then-insert (SELECT id; si no existe INSERT) SIN atomicidad. Dos
-- llamadas concurrentes del mismo par/grupo (doble-click, doble-fire de React,
-- dos pestañas) pasan ambas el SELECT y la 2ª choca con el UNIQUE
-- (conversations_user_a_user_b, group_chats_members_key_unique,
-- group_chats_course_unique) → 23505 crudo al usuario (friendlyError no mapea
-- estos constraints). Fix: hacer el INSERT idempotente (ON CONFLICT DO NOTHING
-- + re-SELECT, o catch unique_violation → devolver el id ganador). El resto de
-- la lógica (permisos can_message, validaciones) se preserva VERBATIM.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.open_conversation(_other uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me UUID := auth.uid();
  v_a UUID;
  v_b UUID;
  v_id UUID;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  IF NOT public.can_message(v_me, _other) THEN
    RAISE EXCEPTION 'No tienes permiso para mensajear a este usuario'
      USING ERRCODE = '42501';
  END IF;
  IF v_me < _other THEN
    v_a := v_me;  v_b := _other;
  ELSE
    v_a := _other; v_b := v_me;
  END IF;
  SELECT id INTO v_id FROM public.conversations
  WHERE user_a = v_a AND user_b = v_b;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  -- Idempotente ante carrera: si otra llamada concurrente ya insertó el par,
  -- ON CONFLICT no reinserta y re-seleccionamos el id ganador (sin 23505).
  INSERT INTO public.conversations (user_a, user_b)
  VALUES (v_a, v_b)
  ON CONFLICT (user_a, user_b) DO NOTHING
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM public.conversations WHERE user_a = v_a AND user_b = v_b;
  END IF;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_or_create_adhoc_group(_member_ids uuid[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me UUID := auth.uid();
  v_all UUID[];
  v_key TEXT;
  v_id UUID;
  v_uid UUID;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  IF _member_ids IS NULL OR cardinality(_member_ids) = 0 THEN
    RAISE EXCEPTION 'Lista de miembros vacía' USING ERRCODE = '22023';
  END IF;
  SELECT ARRAY(SELECT DISTINCT unnest(_member_ids || ARRAY[v_me]) ORDER BY 1)
    INTO v_all;
  FOREACH v_uid IN ARRAY v_all LOOP
    IF v_uid <> v_me AND NOT public.can_message(v_me, v_uid) THEN
      RAISE EXCEPTION 'No tienes permiso para mensajear a uno de los usuarios'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF cardinality(v_all) < 2 THEN
    RAISE EXCEPTION 'Un grupo necesita al menos 2 miembros' USING ERRCODE = '22023';
  END IF;
  v_key := public.compute_members_key(v_all);
  SELECT id INTO v_id FROM public.group_chats WHERE members_key = v_key;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  -- Idempotente ante carrera: si otra llamada creó el grupo con el mismo
  -- members_key, capturamos el unique_violation y devolvemos el ganador.
  BEGIN
    INSERT INTO public.group_chats (members_key, created_by, created_at)
    VALUES (v_key, v_me, now())
    RETURNING id INTO v_id;
    INSERT INTO public.group_chat_members (group_id, user_id)
    SELECT v_id, unnest(v_all);
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id FROM public.group_chats WHERE members_key = v_key;
  END;
  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.find_or_create_course_group(_course_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_me UUID := auth.uid();
  v_id UUID;
  v_is_teacher BOOLEAN;
  v_is_admin BOOLEAN;
  v_course_name TEXT;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  IF _course_id IS NULL THEN
    RAISE EXCEPTION 'course_id requerido' USING ERRCODE = '22023';
  END IF;
  v_is_admin := public.has_role(v_me, 'Admin'::public.app_role)
    OR public.has_role(v_me, 'SuperAdmin'::public.app_role);
  v_is_teacher := EXISTS (
    SELECT 1 FROM public.course_teachers WHERE course_id = _course_id AND user_id = v_me
  );
  IF NOT (v_is_admin OR v_is_teacher) THEN
    RAISE EXCEPTION 'Solo administradores o docentes del curso pueden crear su chat grupal'
      USING ERRCODE = '42501';
  END IF;
  SELECT id INTO v_id FROM public.group_chats WHERE course_id = _course_id;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;
  SELECT name INTO v_course_name FROM public.courses WHERE id = _course_id;
  -- Idempotente ante carrera sobre group_chats_course_unique.
  BEGIN
    INSERT INTO public.group_chats (course_id, created_by, created_at, title)
    VALUES (_course_id, v_me, now(), COALESCE(v_course_name, 'Curso'))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_id FROM public.group_chats WHERE course_id = _course_id;
  END;
  RETURN v_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';

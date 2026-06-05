-- ──────────────────────────────────────────────────────────────────────
-- Group chats (chat de grupo) — para mensajería multi-usuario.
--
-- Hasta acá la mensajería era 1-a-1 (tabla `conversations` con `user_a`
-- y `user_b`). La difusión a curso fanout-eaba en N conversaciones
-- privadas: el docente acababa con N hilos paralelos, ninguno permitía
-- que los alumnos del curso se vieran entre sí.
--
-- Nuevo modelo:
--   - `group_chats` tabla nueva, paralela a conversations.
--   - Dos tipos:
--       a) Chat de curso (`course_id IS NOT NULL`): membresía DINÁMICA
--          derivada de `course_enrollments + course_teachers`. Reemplaza
--          la difusión por alumno. Un alumno nuevo que se matricula ve
--          el historial completo del chat.
--       b) Chat ad-hoc (`members_key IS NOT NULL`): docente selecciona
--          N alumnos → se crea (o se encuentra) un chat con esos miembros
--          exactos + el docente. Misma selección = mismo chat (dedup
--          determinístico por hash de IDs ordenados).
--   - XOR: cada group_chat es UN tipo (course_id XOR members_key).
--
-- Modelo de mensajes:
--   - `messages` recibe una columna `group_id` nullable, mutuamente
--     excluyente con `conversation_id`. UN trigger para ambos paths.
--   - Los mensajes 1-a-1 viejos siguen funcionando intactos.
--
-- RLS:
--   - `is_group_chat_member(_group, _user)` resuelve ambos tipos.
--   - SELECT: soy miembro. INSERT: soy miembro + sender.
--   - "Borrar para mí" (cleared_at) opera per-user en
--     `group_chat_members`. Para chat de curso, el cleared_at se
--     persiste lazy (insert-on-first-clear con member_id derivado).
--
-- Notificaciones:
--   - El trigger `tg_notify_new_message` extendido: si el message es
--     de grupo, notifica a TODOS los miembros menos el sender.
--   - Mismo GUC `app.skip_message_notif` para que la difusión SQL/edge
--     pueda saltarse el trigger cuando ya manejó notifs por su cuenta.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Tablas ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.group_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Chat de curso: membresía dinámica via course_enrollments. NULL para
  -- chats ad-hoc.
  course_id UUID NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- Hash determinístico de los IDs de miembros (ordenados, sha256).
  -- Permite dedup de "misma selección → mismo chat". NULL para chats de
  -- curso (la membresía no es fija, no hay un hash estable).
  members_key TEXT NULL,
  -- Título opcional. Para chats de curso lo seedeamos con el nombre del
  -- curso para que se vea bien en la lista. Para ad-hoc el frontend
  -- puede mostrar la lista de nombres derivada de los miembros.
  title TEXT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- XOR: o es chat de curso O es ad-hoc. No ambos, no ninguno.
  CONSTRAINT group_chats_xor_type CHECK (
    (course_id IS NOT NULL AND members_key IS NULL) OR
    (course_id IS NULL AND members_key IS NOT NULL)
  )
);

-- Un chat por curso (índice parcial — solo aplica cuando course_id NOT
-- NULL). Un chat por set único de miembros para ad-hoc (idem).
CREATE UNIQUE INDEX IF NOT EXISTS group_chats_course_unique
  ON public.group_chats(course_id)
  WHERE course_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS group_chats_members_key_unique
  ON public.group_chats(members_key)
  WHERE members_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS group_chats_created_by_idx
  ON public.group_chats(created_by);

-- Miembros de chats ad-hoc. Para chats de curso no se insertan filas
-- acá — la membresía es dinámica via course_enrollments / course_teachers.
-- Excepción: SI quieres persistir cleared_at / last_read_at para un
-- usuario de un chat de curso, insertamos lazy (ver clear_group_chat).
CREATE TABLE IF NOT EXISTS public.group_chat_members (
  group_id UUID NOT NULL REFERENCES public.group_chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- "Borrar para mí". Mismo modelo que conversations.cleared_at: los
  -- mensajes posteriores siguen siendo visibles, los anteriores no.
  cleared_at TIMESTAMPTZ NULL,
  -- Marca de lectura: el frontend lo bumpea al abrir el chat.
  last_read_at TIMESTAMPTZ NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS group_chat_members_user_idx
  ON public.group_chat_members(user_id);

-- 2) messages: agregar group_id ─────────────────────────────────────────
-- Mutuamente excluyente con conversation_id. UN row de messages es 1-a-1
-- O de grupo, nunca ambos.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'group_id'
  ) THEN
    ALTER TABLE public.messages ADD COLUMN group_id UUID NULL
      REFERENCES public.group_chats(id) ON DELETE CASCADE;
  END IF;
END $$;

-- conversation_id deja de ser NOT NULL (ahora puede ser de grupo).
ALTER TABLE public.messages ALTER COLUMN conversation_id DROP NOT NULL;

-- XOR: exactamente uno entre conversation_id y group_id debe estar set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'messages_exactly_one_target'
  ) THEN
    ALTER TABLE public.messages ADD CONSTRAINT messages_exactly_one_target CHECK (
      (conversation_id IS NOT NULL AND group_id IS NULL) OR
      (conversation_id IS NULL AND group_id IS NOT NULL)
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS messages_group_created_idx
  ON public.messages(group_id, created_at DESC)
  WHERE group_id IS NOT NULL;

-- 3) Helper: is_group_chat_member ────────────────────────────────────────
-- Resuelve ambos tipos:
--   - Chat de curso → enrolled (estudiante) o teacher del curso, o Admin.
--   - Ad-hoc → fila en group_chat_members.
-- SECURITY DEFINER para que las policies puedan llamarla sin tocar
-- tablas con RLS distinta.
CREATE OR REPLACE FUNCTION public.is_group_chat_member(_group UUID, _user UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course UUID;
BEGIN
  IF _group IS NULL OR _user IS NULL THEN
    RETURN FALSE;
  END IF;
  SELECT course_id INTO v_course FROM public.group_chats WHERE id = _group;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_course IS NOT NULL THEN
    -- Membresía dinámica via curso. Admin tiene acceso global aunque no
    -- esté matriculado (consistente con can_message).
    RETURN public.has_role(_user, 'Admin'::public.app_role)
      OR EXISTS (SELECT 1 FROM public.course_teachers WHERE course_id = v_course AND user_id = _user)
      OR EXISTS (SELECT 1 FROM public.course_enrollments WHERE course_id = v_course AND user_id = _user);
  ELSE
    RETURN EXISTS (
      SELECT 1 FROM public.group_chat_members
      WHERE group_id = _group AND user_id = _user
    );
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_group_chat_member(UUID, UUID) TO authenticated;

-- 4) Helper: derivar effective members de un grupo ───────────────────────
-- Lista los user_ids miembros actuales. Para chat de curso: union de
-- teachers + enrollments. Para ad-hoc: filas de group_chat_members.
-- Útil para resolver destinatarios de notif/email.
CREATE OR REPLACE FUNCTION public.group_chat_member_ids(_group UUID)
RETURNS TABLE(user_id UUID)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_course UUID;
BEGIN
  SELECT course_id INTO v_course FROM public.group_chats WHERE id = _group;
  IF v_course IS NOT NULL THEN
    RETURN QUERY
      SELECT DISTINCT u FROM (
        SELECT user_id AS u FROM public.course_teachers WHERE course_id = v_course
        UNION
        SELECT user_id AS u FROM public.course_enrollments WHERE course_id = v_course
      ) s;
  ELSE
    RETURN QUERY SELECT user_id FROM public.group_chat_members WHERE group_id = _group;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.group_chat_member_ids(UUID) TO authenticated;

-- 5) Helper: members_key canónico (sha256 de UUIDs ordenados) ────────────
-- Determinístico: cualquier permutación del array produce el mismo hash.
-- Toma SIEMPRE ordenado-y-dedup-eado.
CREATE OR REPLACE FUNCTION public.compute_members_key(_member_ids UUID[])
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions
AS $$
  SELECT encode(
    extensions.digest(
      array_to_string(
        ARRAY(SELECT DISTINCT unnest(_member_ids) ORDER BY 1),
        ','
      ),
      'sha256'
    ),
    'hex'
  );
$$;

GRANT EXECUTE ON FUNCTION public.compute_members_key(UUID[]) TO authenticated;

-- 6) RPC: find_or_create_adhoc_group ────────────────────────────────────
-- Toma N user_ids (incluyendo o no al caller — la función lo agrega
-- automáticamente). Computa members_key. Si existe el chat, lo devuelve.
-- Sino, lo crea + popula group_chat_members.
--
-- Reglas de autorización:
--   - El caller debe poder mensajear a CADA uno de los miembros propuestos
--     (can_message). Sino → 403.
--   - El caller queda como `created_by` y miembro automático.
CREATE OR REPLACE FUNCTION public.find_or_create_adhoc_group(_member_ids UUID[])
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Build set: caller + provided ids (dedup, ordenados).
  SELECT ARRAY(SELECT DISTINCT unnest(_member_ids || ARRAY[v_me]) ORDER BY 1)
    INTO v_all;

  -- Validar permisos: el caller debe poder mensajear a CADA uno.
  FOREACH v_uid IN ARRAY v_all LOOP
    IF v_uid <> v_me AND NOT public.can_message(v_me, v_uid) THEN
      RAISE EXCEPTION 'No tienes permiso para mensajear a uno de los usuarios'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- Para evitar abuso: rechazar grupos de 1 (caller solo). Para 2 (caller
  -- + 1 otro) preferimos usar conversations 1-a-1 — pero NO bloqueamos
  -- aquí; el frontend decide la ruta (1 invitado → open_conversation,
  -- 2+ → este RPC).
  IF cardinality(v_all) < 2 THEN
    RAISE EXCEPTION 'Un grupo necesita al menos 2 miembros' USING ERRCODE = '22023';
  END IF;

  v_key := public.compute_members_key(v_all);

  -- Try find existing
  SELECT id INTO v_id FROM public.group_chats WHERE members_key = v_key;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Create new
  INSERT INTO public.group_chats (members_key, created_by, created_at)
  VALUES (v_key, v_me, now())
  RETURNING id INTO v_id;

  -- Populate members
  INSERT INTO public.group_chat_members (group_id, user_id)
  SELECT v_id, unnest(v_all);

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_or_create_adhoc_group(UUID[]) TO authenticated;

-- 7) RPC: find_or_create_course_group ────────────────────────────────────
-- Toma course_id. Si existe el chat del curso, lo devuelve. Sino lo crea.
-- Autorización: solo Admin o docente del curso pueden crear (los alumnos
-- solo se unen como miembros derivados, no inician el chat).
CREATE OR REPLACE FUNCTION public.find_or_create_course_group(_course_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  -- Find existing
  SELECT id INTO v_id FROM public.group_chats WHERE course_id = _course_id;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Create
  SELECT name INTO v_course_name FROM public.courses WHERE id = _course_id;
  INSERT INTO public.group_chats (course_id, created_by, created_at, title)
  VALUES (_course_id, v_me, now(), COALESCE(v_course_name, 'Curso'))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.find_or_create_course_group(UUID) TO authenticated;

-- 8) RPC: clear_group_chat ────────────────────────────────────────────────
-- "Borrar para mí". Mismo modelo que clear_conversation. Para chats ad-hoc
-- actualiza el row existente; para chats de curso inserta lazy si el
-- usuario aún no tiene fila (los chats de curso no tienen filas
-- pre-creadas en group_chat_members).
CREATE OR REPLACE FUNCTION public.clear_group_chat(_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
  v_course UUID;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  IF NOT public.is_group_chat_member(_group_id, v_me) THEN
    RAISE EXCEPTION 'No eres miembro del chat' USING ERRCODE = '42501';
  END IF;

  SELECT course_id INTO v_course FROM public.group_chats WHERE id = _group_id;

  -- Si es chat de curso y no tengo row en members, insertamos lazy.
  IF v_course IS NOT NULL THEN
    INSERT INTO public.group_chat_members (group_id, user_id, cleared_at)
    VALUES (_group_id, v_me, v_now)
    ON CONFLICT (group_id, user_id) DO UPDATE SET cleared_at = v_now;
  ELSE
    UPDATE public.group_chat_members
    SET cleared_at = v_now
    WHERE group_id = _group_id AND user_id = v_me;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.clear_group_chat(UUID) TO authenticated;

-- 9) RPC: mark_group_chat_read ──────────────────────────────────────────
-- Bumpea last_read_at del caller. Mismo patrón lazy para chats de curso.
CREATE OR REPLACE FUNCTION public.mark_group_chat_read(_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
  v_course UUID;
BEGIN
  IF v_me IS NULL THEN RETURN; END IF;
  IF NOT public.is_group_chat_member(_group_id, v_me) THEN RETURN; END IF;
  SELECT course_id INTO v_course FROM public.group_chats WHERE id = _group_id;
  IF v_course IS NOT NULL THEN
    INSERT INTO public.group_chat_members (group_id, user_id, last_read_at)
    VALUES (_group_id, v_me, v_now)
    ON CONFLICT (group_id, user_id) DO UPDATE SET last_read_at = v_now;
  ELSE
    UPDATE public.group_chat_members
    SET last_read_at = v_now
    WHERE group_id = _group_id AND user_id = v_me;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_group_chat_read(UUID) TO authenticated;

-- 10) Trigger de notificación extendido ──────────────────────────────────
-- El trigger anterior solo manejaba conversation_id. Ahora maneja ambos:
--   - 1-a-1 (conversation_id NOT NULL): notifica al "otro" usuario.
--   - Grupo (group_id NOT NULL): notifica a todos los miembros menos el
--     sender. UN row de notification por destinatario.
-- Mismo GUC app.skip_message_notif para que la difusión sql/edge pueda
-- saltarse cuando ya hizo su propia fan-out.
CREATE OR REPLACE FUNCTION public.tg_notify_new_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conv RECORD;
  v_recipient UUID;
  v_sender_name TEXT;
  v_body_preview TEXT;
  v_skip TEXT;
  v_group_title TEXT;
BEGIN
  v_skip := current_setting('app.skip_message_notif', true);
  IF v_skip = 'true' THEN
    RETURN NEW;
  END IF;

  v_body_preview := substring(split_part(NEW.body, E'\n', 1) FROM 1 FOR 140);
  SELECT COALESCE(full_name, institutional_email, 'Usuario')
    INTO v_sender_name
  FROM public.profiles
  WHERE id = NEW.sender_id;
  v_sender_name := COALESCE(v_sender_name, 'Usuario');

  IF NEW.conversation_id IS NOT NULL THEN
    -- 1-a-1: notif al "otro".
    SELECT user_a, user_b INTO v_conv
    FROM public.conversations
    WHERE id = NEW.conversation_id;
    IF v_conv IS NULL THEN RETURN NEW; END IF;
    v_recipient := CASE
      WHEN v_conv.user_a = NEW.sender_id THEN v_conv.user_b
      ELSE v_conv.user_a
    END;
    INSERT INTO public.notifications (
      user_id, title, body, kind, link, related_user_id, source_role
    ) VALUES (
      v_recipient,
      'Nuevo mensaje de ' || v_sender_name,
      v_body_preview,
      'info',
      '/app/messages',
      NEW.sender_id,
      NULL
    );
  ELSIF NEW.group_id IS NOT NULL THEN
    -- Grupo: notif a cada miembro != sender. group_chat_member_ids
    -- resuelve tanto chats de curso (dinámico) como ad-hoc (filas
    -- explícitas).
    SELECT title INTO v_group_title FROM public.group_chats WHERE id = NEW.group_id;
    INSERT INTO public.notifications (
      user_id, title, body, kind, link, related_user_id, source_role
    )
    SELECT
      m.user_id,
      CASE
        WHEN v_group_title IS NOT NULL THEN v_sender_name || ' · ' || v_group_title
        ELSE 'Nuevo mensaje de ' || v_sender_name
      END,
      v_body_preview,
      'info',
      '/app/messages?group=' || NEW.group_id::text,
      NEW.sender_id,
      NULL
    FROM public.group_chat_member_ids(NEW.group_id) m
    WHERE m.user_id <> NEW.sender_id;
  END IF;

  RETURN NEW;
END;
$$;

-- 11) RLS group_chats ────────────────────────────────────────────────────
ALTER TABLE public.group_chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "group_chats select" ON public.group_chats;
CREATE POLICY "group_chats select"
ON public.group_chats FOR SELECT TO authenticated
USING (public.is_group_chat_member(id, auth.uid()));

-- INSERT lo hacen las RPCs SECURITY DEFINER. Como red de seguridad:
-- solo el creator puede inicializar; valida_membership lo enforza la RPC.
DROP POLICY IF EXISTS "group_chats insert" ON public.group_chats;
CREATE POLICY "group_chats insert"
ON public.group_chats FOR INSERT TO authenticated
WITH CHECK (created_by = auth.uid());

-- No UPDATE / DELETE público — solo via funciones SECURITY DEFINER.
-- (Si quisieras "renombrar grupo" o "eliminar chat" agregamos RPCs.)

-- 12) RLS group_chat_members ─────────────────────────────────────────────
ALTER TABLE public.group_chat_members ENABLE ROW LEVEL SECURITY;

-- Cada usuario ve sus propias filas + cualquier miembro de un chat al
-- que pertenece puede ver al resto de miembros (útil para frontend
-- listar avatars en el header).
DROP POLICY IF EXISTS "group_chat_members select" ON public.group_chat_members;
CREATE POLICY "group_chat_members select"
ON public.group_chat_members FOR SELECT TO authenticated
USING (public.is_group_chat_member(group_id, auth.uid()));

-- Self-update SOLO cleared_at / last_read_at del propio user. Validamos
-- via WITH CHECK que sigue siendo su propio user_id (no escala).
-- En la práctica usamos las RPCs clear_group_chat / mark_group_chat_read.
DROP POLICY IF EXISTS "group_chat_members update self" ON public.group_chat_members;
CREATE POLICY "group_chat_members update self"
ON public.group_chat_members FOR UPDATE TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- INSERT lo hacen las RPCs SECURITY DEFINER. No exponemos INSERT directo.

-- 13) RLS messages: extender para group_id ───────────────────────────────
-- Las policies existentes ("messages select" / "messages insert") solo
-- contemplaban conversation_id. Las recreamos para incluir el branch de
-- group_id.
DROP POLICY IF EXISTS "messages select" ON public.messages;
CREATE POLICY "messages select"
ON public.messages FOR SELECT TO authenticated
USING (
  -- 1-a-1: lógica original con cleared_at por usuario.
  (
    conversation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = messages.conversation_id
        AND (
          (c.user_a = auth.uid()
            AND (c.user_a_cleared_at IS NULL OR messages.created_at > c.user_a_cleared_at))
          OR (c.user_b = auth.uid()
            AND (c.user_b_cleared_at IS NULL OR messages.created_at > c.user_b_cleared_at))
        )
    )
  )
  OR
  -- Grupo: soy miembro Y (no he limpiado O mensaje > cleared_at).
  (
    group_id IS NOT NULL AND public.is_group_chat_member(group_id, auth.uid())
    AND NOT EXISTS (
      SELECT 1 FROM public.group_chat_members gcm
      WHERE gcm.group_id = messages.group_id
        AND gcm.user_id = auth.uid()
        AND gcm.cleared_at IS NOT NULL
        AND messages.created_at <= gcm.cleared_at
    )
  )
);

DROP POLICY IF EXISTS "messages insert" ON public.messages;
CREATE POLICY "messages insert"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND (
    -- 1-a-1: misma lógica de antes.
    (
      conversation_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.conversations c
        WHERE c.id = conversation_id
          AND (c.user_a = auth.uid() OR c.user_b = auth.uid())
          AND public.can_message(c.user_a, c.user_b)
      )
    )
    OR
    -- Grupo: soy miembro del grupo.
    (
      group_id IS NOT NULL AND public.is_group_chat_member(group_id, auth.uid())
    )
  )
);

-- DELETE (sender) sigue igual — no necesita ajuste.

-- 14) Realtime: group_chats y group_chat_members ─────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_chats'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.group_chats;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'group_chat_members'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.group_chat_members;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

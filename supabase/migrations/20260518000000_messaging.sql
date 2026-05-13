-- ──────────────────────────────────────────────────────────────────────
-- Módulo de mensajería interna 1-a-1
--
-- Reglas de visibilidad (escritas en `can_message`):
--   - Cualquier par (estudiante/docente/admin) que comparta al menos un
--     curso puede mensajearse.
--   - Cualquier usuario puede mensajear a un Admin (y viceversa).
--   - El admin puede mensajear a cualquier usuario (corolario del punto
--     anterior).
--
-- Borrado asimétrico:
--   - Cada conversación tiene `user_a_cleared_at` y `user_b_cleared_at`.
--   - "Borrar conversación" setea `cleared_at = now()` SOLO para el
--     usuario que lo pidió. El otro lado sigue viendo todo.
--   - Si llega un mensaje nuevo tras el borrado, la conversación
--     "resucita" para el usuario que la había limpiado: el filtro de
--     mensajes es `created_at > cleared_at`, así que solo los mensajes
--     posteriores al clear son visibles.
--
-- Canonicalización: `user_a < user_b` (orden lexicográfico de UUID) para
-- que el UNIQUE garantice una sola fila por par sin importar quién
-- inició. La RPC `open_conversation` se encarga del swap antes del
-- INSERT.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Tablas ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_b UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user_a_cleared_at TIMESTAMPTZ,
  user_b_cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversations_canonical_order CHECK (user_a < user_b),
  CONSTRAINT conversations_unique_pair UNIQUE (user_a, user_b)
);

CREATE INDEX IF NOT EXISTS conversations_user_a_idx ON public.conversations(user_a);
CREATE INDEX IF NOT EXISTS conversations_user_b_idx ON public.conversations(user_b);

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL CHECK (length(body) > 0 AND length(body) <= 4000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_conv_created_idx
  ON public.messages(conversation_id, created_at DESC);

-- 2) Función can_message ────────────────────────────────────────────────
-- True si los dos usuarios pueden mensajearse según las reglas del
-- módulo. SECURITY DEFINER porque consulta tablas con RLS distinta.
CREATE OR REPLACE FUNCTION public.can_message(_a UUID, _b UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _a IS NOT NULL
    AND _b IS NOT NULL
    AND _a <> _b
    AND (
      -- Cualquiera de los dos es Admin → permiso global.
      public.has_role(_a, 'Admin'::public.app_role)
      OR public.has_role(_b, 'Admin'::public.app_role)
      -- O comparten al menos un curso (independiente del rol: docente,
      -- estudiante o cualquier combinación).
      OR EXISTS (
        SELECT 1
        FROM (
          SELECT course_id FROM public.course_teachers WHERE user_id = _a
          UNION
          SELECT course_id FROM public.course_enrollments WHERE user_id = _a
        ) a
        INNER JOIN (
          SELECT course_id FROM public.course_teachers WHERE user_id = _b
          UNION
          SELECT course_id FROM public.course_enrollments WHERE user_id = _b
        ) b USING (course_id)
      )
    );
$$;

-- 3) RPC open_conversation ──────────────────────────────────────────────
-- Devuelve el id de la conversación entre auth.uid() y `_other`. Si no
-- existe, la crea. Valida `can_message` antes. Idempotente: llamar dos
-- veces devuelve el mismo id.
CREATE OR REPLACE FUNCTION public.open_conversation(_other UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- Canonicaliza (a < b)
  IF v_me < _other THEN
    v_a := v_me;  v_b := _other;
  ELSE
    v_a := _other; v_b := v_me;
  END IF;
  -- Busca existente
  SELECT id INTO v_id FROM public.conversations
  WHERE user_a = v_a AND user_b = v_b;
  IF v_id IS NOT NULL THEN
    -- Si yo había limpiado la conversación, NO desmarcamos el cleared_at
    -- aquí — el clear sigue válido y solo se "rompe" cuando llega un
    -- mensaje nuevo posterior. Mantiene la semántica de "borrado para mí".
    RETURN v_id;
  END IF;
  INSERT INTO public.conversations (user_a, user_b)
  VALUES (v_a, v_b)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 4) RPC list_messageable_users ─────────────────────────────────────────
-- Lista los usuarios con los que auth.uid() puede iniciar conversación.
-- Devuelve { id, full_name, email, role_label }. Si soy Admin, lista a
-- todos los usuarios con perfil. Si no, lista compañeros de curso +
-- todos los Admin.
CREATE OR REPLACE FUNCTION public.list_messageable_users()
RETURNS TABLE (
  user_id UUID,
  full_name TEXT,
  email TEXT,
  role_label TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (SELECT auth.uid() AS uid),
  am_admin AS (
    SELECT public.has_role((SELECT uid FROM me), 'Admin'::public.app_role) AS is_admin
  ),
  my_courses AS (
    SELECT course_id FROM public.course_teachers WHERE user_id = (SELECT uid FROM me)
    UNION
    SELECT course_id FROM public.course_enrollments WHERE user_id = (SELECT uid FROM me)
  ),
  candidates AS (
    -- Si soy admin, todos los perfiles
    SELECT p.id AS uid
    FROM public.profiles p
    WHERE (SELECT is_admin FROM am_admin) = TRUE
      AND p.id <> (SELECT uid FROM me)
    UNION
    -- Compañeros de curso (cualquier rol)
    SELECT u.user_id AS uid
    FROM (
      SELECT user_id FROM public.course_teachers
      WHERE course_id IN (SELECT course_id FROM my_courses)
      UNION
      SELECT user_id FROM public.course_enrollments
      WHERE course_id IN (SELECT course_id FROM my_courses)
    ) u
    WHERE u.user_id <> (SELECT uid FROM me)
    UNION
    -- Todos los admins (cualquier usuario puede mensajearles)
    SELECT ur.user_id AS uid
    FROM public.user_roles ur
    WHERE ur.role = 'Admin'::public.app_role
      AND ur.user_id <> (SELECT uid FROM me)
  )
  SELECT DISTINCT
    c.uid,
    p.full_name,
    p.institutional_email AS email,
    CASE
      WHEN public.has_role(c.uid, 'Admin'::public.app_role) THEN 'Admin'
      WHEN public.has_role(c.uid, 'Docente'::public.app_role) THEN 'Docente'
      WHEN public.has_role(c.uid, 'Estudiante'::public.app_role) THEN 'Estudiante'
      ELSE 'Usuario'
    END AS role_label
  FROM candidates c
  LEFT JOIN public.profiles p ON p.id = c.uid;
$$;

-- 5) RPC clear_conversation ─────────────────────────────────────────────
-- "Borrar para mí". Setea cleared_at del lado correspondiente. NO borra
-- la fila; el otro usuario sigue viéndola intacta.
CREATE OR REPLACE FUNCTION public.clear_conversation(_conv_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_me UUID := auth.uid();
  v_now TIMESTAMPTZ := now();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '28000';
  END IF;
  UPDATE public.conversations
  SET
    user_a_cleared_at = CASE WHEN user_a = v_me THEN v_now ELSE user_a_cleared_at END,
    user_b_cleared_at = CASE WHEN user_b = v_me THEN v_now ELSE user_b_cleared_at END
  WHERE id = _conv_id
    AND (user_a = v_me OR user_b = v_me);
END;
$$;

-- 6) RLS conversations ─────────────────────────────────────────────────
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "conversations select" ON public.conversations;
CREATE POLICY "conversations select"
ON public.conversations FOR SELECT TO authenticated
USING (user_a = auth.uid() OR user_b = auth.uid());

-- INSERT directo está bloqueado — la app debe usar `open_conversation`
-- (que también valida can_message). Si alguien intenta INSERT directo
-- igualmente exigimos que sea miembro Y que can_message lo apruebe.
DROP POLICY IF EXISTS "conversations insert" ON public.conversations;
CREATE POLICY "conversations insert"
ON public.conversations FOR INSERT TO authenticated
WITH CHECK (
  (user_a = auth.uid() OR user_b = auth.uid())
  AND public.can_message(user_a, user_b)
);

-- UPDATE solo permitido para que el usuario actualice SU cleared_at.
-- En la práctica usamos la RPC `clear_conversation` (SECURITY DEFINER);
-- la policy queda como red de seguridad.
DROP POLICY IF EXISTS "conversations update own clear" ON public.conversations;
CREATE POLICY "conversations update own clear"
ON public.conversations FOR UPDATE TO authenticated
USING (user_a = auth.uid() OR user_b = auth.uid())
WITH CHECK (user_a = auth.uid() OR user_b = auth.uid());

-- 7) RLS messages ──────────────────────────────────────────────────────
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- SELECT: soy parte de la conv. Y el mensaje es POSTERIOR a mi
-- cleared_at (o no he limpiado). Eso implementa el "borrado para mí".
DROP POLICY IF EXISTS "messages select" ON public.messages;
CREATE POLICY "messages select"
ON public.messages FOR SELECT TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = messages.conversation_id
      AND (
        (c.user_a = auth.uid()
          AND (c.user_a_cleared_at IS NULL OR messages.created_at > c.user_a_cleared_at))
        OR (c.user_b = auth.uid()
          AND (c.user_b_cleared_at IS NULL OR messages.created_at > c.user_b_cleared_at))
      )
  )
);

-- INSERT: soy parte de la conv, soy el sender, y can_message sigue
-- siendo true (cubre el caso "se cayó la matrícula tras crear la conv —
-- ya no se puede enviar"). Cuando un usuario envía, automáticamente
-- "resucita" la conv para el otro porque el nuevo created_at > cleared_at.
DROP POLICY IF EXISTS "messages insert" ON public.messages;
CREATE POLICY "messages insert"
ON public.messages FOR INSERT TO authenticated
WITH CHECK (
  sender_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.conversations c
    WHERE c.id = conversation_id
      AND (c.user_a = auth.uid() OR c.user_b = auth.uid())
      AND public.can_message(c.user_a, c.user_b)
  )
);

-- DELETE: el sender puede borrar SU propio mensaje (audit-friendly).
DROP POLICY IF EXISTS "messages delete own" ON public.messages;
CREATE POLICY "messages delete own"
ON public.messages FOR DELETE TO authenticated
USING (sender_id = auth.uid());

-- 8) Realtime ──────────────────────────────────────────────────────────
-- Permite que el cliente se suscriba a INSERTs en messages para pintar
-- nuevos mensajes sin polling. conversations también para badge "tienes
-- mensajes nuevos" cuando un tercero te abre una conversación.
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;

NOTIFY pgrst, 'reload schema';

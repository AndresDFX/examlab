-- ──────────────────────────────────────────────────────────────────────
-- Foro Q&A por curso.
--
-- Modelo Stack Overflow simplificado:
--   - Hilo (pregunta raíz) con título + cuerpo + tags + estados (pinned/locked)
--   - Respuestas FLAT (no nested) — un solo nivel de profundidad. Si una
--     respuesta necesita aclaración, se vota o se cita inline en otra
--     respuesta. Decisión deliberada para evitar la complejidad de Reddit.
--   - Upvotes per usuario (un usuario solo puede upvotear una vez por target)
--   - Una respuesta marcada como OFICIAL por hilo (solo docente del curso)
--   - Trigger de denormalización: reply_count + last_activity_at en hilo
--     se recalculan por trigger (evita JOIN en cada query de listado)
--
-- RLS: matriculados + docentes del curso + admin. Modelo igual al de
-- attendance/grades — el estudiante debe estar enrolled para participar.
-- ──────────────────────────────────────────────────────────────────────

-- ── Tabla: forum_threads ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.forum_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  tags TEXT[] NOT NULL DEFAULT '{}',
  is_pinned BOOLEAN NOT NULL DEFAULT FALSE,
  is_locked BOOLEAN NOT NULL DEFAULT FALSE,
  -- ID de la respuesta marcada como oficial (FK suelta para evitar ciclo)
  official_reply_id UUID,
  -- Denormalizado: lo mantienen triggers cuando hay replies/upvotes
  reply_count INT NOT NULL DEFAULT 0,
  upvotes INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forum_threads_course      ON public.forum_threads(course_id);
CREATE INDEX IF NOT EXISTS idx_forum_threads_author      ON public.forum_threads(author_id);
CREATE INDEX IF NOT EXISTS idx_forum_threads_activity    ON public.forum_threads(last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_forum_threads_pinned      ON public.forum_threads(is_pinned, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_forum_threads_tags        ON public.forum_threads USING GIN (tags);

DROP TRIGGER IF EXISTS trg_forum_threads_updated_at ON public.forum_threads;
CREATE TRIGGER trg_forum_threads_updated_at
  BEFORE UPDATE ON public.forum_threads
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── Tabla: forum_replies ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.forum_replies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES public.forum_threads(id) ON DELETE CASCADE,
  author_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  upvotes INT NOT NULL DEFAULT 0,
  is_official BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_forum_replies_thread  ON public.forum_replies(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_forum_replies_author  ON public.forum_replies(author_id);

DROP TRIGGER IF EXISTS trg_forum_replies_updated_at ON public.forum_replies;
CREATE TRIGGER trg_forum_replies_updated_at
  BEFORE UPDATE ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Un solo "oficial" por hilo (índice único parcial)
CREATE UNIQUE INDEX IF NOT EXISTS idx_forum_replies_one_official_per_thread
  ON public.forum_replies(thread_id)
  WHERE is_official = TRUE;

-- ── Tabla: forum_upvotes ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.forum_upvotes (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('thread','reply')),
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_forum_upvotes_target ON public.forum_upvotes(target_type, target_id);

-- ── Triggers de denormalización ──────────────────────────────────────

-- Al crear/borrar reply: ajusta reply_count + last_activity_at en thread.
-- Al editar reply (body change): no toca reply_count pero sí last_activity_at
-- para que aparezca como hilo con actividad reciente.

CREATE OR REPLACE FUNCTION public._forum_replies_after_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.forum_threads
    SET reply_count = reply_count + 1,
        last_activity_at = NEW.created_at
    WHERE id = NEW.thread_id;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_forum_replies_after_insert ON public.forum_replies;
CREATE TRIGGER trg_forum_replies_after_insert
  AFTER INSERT ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public._forum_replies_after_insert();

CREATE OR REPLACE FUNCTION public._forum_replies_after_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.forum_threads
    SET reply_count = GREATEST(0, reply_count - 1)
    WHERE id = OLD.thread_id;
  -- Si la respuesta borrada era la oficial, también limpiamos el FK del hilo
  UPDATE public.forum_threads
    SET official_reply_id = NULL
    WHERE official_reply_id = OLD.id;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_forum_replies_after_delete ON public.forum_replies;
CREATE TRIGGER trg_forum_replies_after_delete
  AFTER DELETE ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public._forum_replies_after_delete();

-- Upvote insert/delete → recalcula contador denormalizado
CREATE OR REPLACE FUNCTION public._forum_upvotes_after_insert()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.target_type = 'thread' THEN
    UPDATE public.forum_threads SET upvotes = upvotes + 1 WHERE id = NEW.target_id;
  ELSE
    UPDATE public.forum_replies SET upvotes = upvotes + 1 WHERE id = NEW.target_id;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_forum_upvotes_after_insert ON public.forum_upvotes;
CREATE TRIGGER trg_forum_upvotes_after_insert
  AFTER INSERT ON public.forum_upvotes
  FOR EACH ROW EXECUTE FUNCTION public._forum_upvotes_after_insert();

CREATE OR REPLACE FUNCTION public._forum_upvotes_after_delete()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF OLD.target_type = 'thread' THEN
    UPDATE public.forum_threads SET upvotes = GREATEST(0, upvotes - 1) WHERE id = OLD.target_id;
  ELSE
    UPDATE public.forum_replies SET upvotes = GREATEST(0, upvotes - 1) WHERE id = OLD.target_id;
  END IF;
  RETURN OLD;
END
$$;

DROP TRIGGER IF EXISTS trg_forum_upvotes_after_delete ON public.forum_upvotes;
CREATE TRIGGER trg_forum_upvotes_after_delete
  AFTER DELETE ON public.forum_upvotes
  FOR EACH ROW EXECUTE FUNCTION public._forum_upvotes_after_delete();

-- ── RLS ──────────────────────────────────────────────────────────────

ALTER TABLE public.forum_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_replies  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.forum_upvotes  ENABLE ROW LEVEL SECURITY;

-- Helper inline: ¿el usuario puede acceder al foro del curso?
-- Admin + docentes del curso + estudiantes matriculados.

-- threads SELECT
DROP POLICY IF EXISTS "forum_threads_select" ON public.forum_threads;
CREATE POLICY "forum_threads_select"
  ON public.forum_threads FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
    )
  );

-- threads INSERT: cualquiera con acceso al curso puede crear hilos
DROP POLICY IF EXISTS "forum_threads_insert" ON public.forum_threads;
CREATE POLICY "forum_threads_insert"
  ON public.forum_threads FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers
        WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.course_enrollments
        WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
      )
    )
  );

-- threads UPDATE: autor (su contenido), docente/admin (pin, lock, oficial)
DROP POLICY IF EXISTS "forum_threads_update" ON public.forum_threads;
CREATE POLICY "forum_threads_update"
  ON public.forum_threads FOR UPDATE TO authenticated
  USING (
    author_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
    )
  );

-- threads DELETE: autor o docente/admin
DROP POLICY IF EXISTS "forum_threads_delete" ON public.forum_threads;
CREATE POLICY "forum_threads_delete"
  ON public.forum_threads FOR DELETE TO authenticated
  USING (
    author_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
    )
  );

-- replies SELECT: si puedes ver el hilo, puedes ver respuestas
DROP POLICY IF EXISTS "forum_replies_select" ON public.forum_replies;
CREATE POLICY "forum_replies_select"
  ON public.forum_replies FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = forum_replies.thread_id
        AND (
          public.has_role(auth.uid(), 'Admin')
          OR EXISTS (
            SELECT 1 FROM public.course_teachers
            WHERE course_id = t.course_id AND user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.course_enrollments
            WHERE course_id = t.course_id AND user_id = auth.uid()
          )
        )
    )
  );

-- replies INSERT: usuarios con acceso al curso del hilo, EXCEPTO si está locked
DROP POLICY IF EXISTS "forum_replies_insert" ON public.forum_replies;
CREATE POLICY "forum_replies_insert"
  ON public.forum_replies FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.forum_threads t
      WHERE t.id = forum_replies.thread_id
        AND t.is_locked = FALSE
        AND (
          public.has_role(auth.uid(), 'Admin')
          OR EXISTS (
            SELECT 1 FROM public.course_teachers
            WHERE course_id = t.course_id AND user_id = auth.uid()
          )
          OR EXISTS (
            SELECT 1 FROM public.course_enrollments
            WHERE course_id = t.course_id AND user_id = auth.uid()
          )
        )
    )
  );

-- replies UPDATE: autor (su contenido), docente/admin
DROP POLICY IF EXISTS "forum_replies_update" ON public.forum_replies;
CREATE POLICY "forum_replies_update"
  ON public.forum_replies FOR UPDATE TO authenticated
  USING (
    author_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.forum_threads t
      JOIN public.course_teachers ct ON ct.course_id = t.course_id
      WHERE t.id = forum_replies.thread_id AND ct.user_id = auth.uid()
    )
  );

-- replies DELETE: autor o docente/admin
DROP POLICY IF EXISTS "forum_replies_delete" ON public.forum_replies;
CREATE POLICY "forum_replies_delete"
  ON public.forum_replies FOR DELETE TO authenticated
  USING (
    author_id = auth.uid()
    OR public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.forum_threads t
      JOIN public.course_teachers ct ON ct.course_id = t.course_id
      WHERE t.id = forum_replies.thread_id AND ct.user_id = auth.uid()
    )
  );

-- upvotes: SELECT abierto a authenticated (el conteo no es secreto),
-- INSERT/DELETE solo del propio usuario y solo en cursos donde tiene acceso.
DROP POLICY IF EXISTS "forum_upvotes_select" ON public.forum_upvotes;
CREATE POLICY "forum_upvotes_select"
  ON public.forum_upvotes FOR SELECT TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS "forum_upvotes_insert" ON public.forum_upvotes;
CREATE POLICY "forum_upvotes_insert"
  ON public.forum_upvotes FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "forum_upvotes_delete" ON public.forum_upvotes;
CREATE POLICY "forum_upvotes_delete"
  ON public.forum_upvotes FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────────────
-- RPCs
-- ────────────────────────────────────────────────────────────────────

-- 1) Toggle upvote: si ya existe, lo borra; si no, lo crea.
--    El trigger denormaliza el contador en thread/reply.
CREATE OR REPLACE FUNCTION public.toggle_forum_upvote(
  _target_type TEXT,
  _target_id   UUID
) RETURNS TABLE(upvoted BOOLEAN, total INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _exists BOOLEAN;
  _total INT;
BEGIN
  IF _target_type NOT IN ('thread', 'reply') THEN
    RAISE EXCEPTION 'target_type debe ser "thread" o "reply"';
  END IF;
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.forum_upvotes
    WHERE user_id = auth.uid()
      AND target_type = _target_type
      AND target_id = _target_id
  ) INTO _exists;

  IF _exists THEN
    DELETE FROM public.forum_upvotes
      WHERE user_id = auth.uid()
        AND target_type = _target_type
        AND target_id = _target_id;
  ELSE
    INSERT INTO public.forum_upvotes (user_id, target_type, target_id)
      VALUES (auth.uid(), _target_type, _target_id);
  END IF;

  IF _target_type = 'thread' THEN
    SELECT upvotes INTO _total FROM public.forum_threads WHERE id = _target_id;
  ELSE
    SELECT upvotes INTO _total FROM public.forum_replies WHERE id = _target_id;
  END IF;

  RETURN QUERY SELECT (NOT _exists), COALESCE(_total, 0);
END
$$;

REVOKE ALL ON FUNCTION public.toggle_forum_upvote(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_forum_upvote(TEXT, UUID) TO authenticated;

-- 2) Marcar respuesta como oficial. Solo docente del curso o admin.
--    Si el hilo ya tiene una oficial, se le quita is_official a la
--    anterior y se asigna a la nueva (índice único parcial lo enforza
--    también, pero hacemos el swap de forma explícita).
CREATE OR REPLACE FUNCTION public.mark_forum_reply_official(
  _reply_id UUID,
  _official BOOLEAN DEFAULT TRUE
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _thread_id UUID;
  _course_id UUID;
BEGIN
  SELECT r.thread_id, t.course_id
    INTO _thread_id, _course_id
    FROM public.forum_replies r
    JOIN public.forum_threads t ON t.id = r.thread_id
    WHERE r.id = _reply_id;
  IF _thread_id IS NULL THEN
    RAISE EXCEPTION 'Respuesta no encontrada';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = _course_id AND user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'Solo el docente del curso o admin pueden marcar respuestas como oficiales';
  END IF;

  IF _official THEN
    -- Quitar oficial a cualquier otra del mismo hilo
    UPDATE public.forum_replies SET is_official = FALSE
      WHERE thread_id = _thread_id AND id <> _reply_id AND is_official = TRUE;
    UPDATE public.forum_replies SET is_official = TRUE WHERE id = _reply_id;
    UPDATE public.forum_threads SET official_reply_id = _reply_id WHERE id = _thread_id;
  ELSE
    UPDATE public.forum_replies SET is_official = FALSE WHERE id = _reply_id;
    UPDATE public.forum_threads SET official_reply_id = NULL
      WHERE id = _thread_id AND official_reply_id = _reply_id;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.mark_forum_reply_official(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_forum_reply_official(UUID, BOOLEAN) TO authenticated;

-- ── Notificación al autor del hilo cuando alguien responde ──────────

CREATE OR REPLACE FUNCTION public._notify_forum_thread_author_on_reply()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _thread RECORD;
  _author_name TEXT;
BEGIN
  SELECT t.id, t.title, t.author_id, t.course_id
    INTO _thread
    FROM public.forum_threads t WHERE t.id = NEW.thread_id;

  -- No notificar al autor cuando él mismo responde
  IF _thread.author_id IS NULL OR _thread.author_id = NEW.author_id THEN
    RETURN NEW;
  END IF;

  SELECT full_name INTO _author_name FROM public.profiles WHERE id = NEW.author_id;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    _thread.author_id,
    'Nueva respuesta en tu pregunta del foro',
    COALESCE(_author_name, 'Alguien') || ' respondió a "' || _thread.title || '".',
    'info',
    '/app/forum/' || _thread.course_id::text || '/' || _thread.id::text
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_notify_forum_thread_author_on_reply ON public.forum_replies;
CREATE TRIGGER trg_notify_forum_thread_author_on_reply
  AFTER INSERT ON public.forum_replies
  FOR EACH ROW EXECUTE FUNCTION public._notify_forum_thread_author_on_reply();

NOTIFY pgrst, 'reload schema';

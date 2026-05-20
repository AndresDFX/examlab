-- ──────────────────────────────────────────────────────────────────────
-- Foros como contenedor de hilos (refactor v2 del módulo foro).
--
-- Modelo anterior (migración 20260520100000):
--   - `forum_threads` colgaba directo de `courses` (curso es el único agrupador)
--   - cualquier estudiante matriculado podía crear hilo en cualquier momento
--   - no había ventanas de tiempo
--
-- Modelo nuevo:
--   - El docente crea un FORO (contenedor) por curso, opcionalmente
--     asociado a una `attendance_sessions` (ej. "Foro de la clase del
--     15 oct sobre estructuras de datos").
--   - El foro tiene `opens_at` / `closes_at` (cierre automático) y
--     `manually_closed_at` (cierre manual del docente). Los estudiantes
--     solo pueden postear cuando el foro está abierto.
--   - El docente puede leer / responder / editar sin restricciones de
--     ventana (puede cerrar el foro pero seguir interactuando si quiere).
--   - Los `forum_threads` ahora cuelgan de `forums` (NOT NULL fk),
--     manteniendo `course_id` para reportería rápida sin JOIN.
--
-- Backfill (sin pérdida de data):
--   - Para CADA curso que tenga al menos un `forum_threads` existente,
--     creamos un foro "General" (sin sesión asociada, sin fechas → siempre
--     abierto) y reasignamos todos los hilos del curso a ese foro.
--   - Cursos sin hilos no reciben foro "General" — el docente lo creará
--     cuando le sirva.
--
-- RLS:
--   - SELECT: igual que threads (admin + teachers + enrolled del curso).
--   - INSERT / UPDATE / DELETE foros: solo admin + teachers del curso.
--     Estudiantes NO crean foros — son contenedores curados.
--   - INSERT threads/replies: el predicado de RLS ahora exige que el
--     foro esté ABIERTO o que el usuario sea admin/teacher.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1) Crear tabla forums ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.forums (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  -- Opcional: asociar a una sesión de clase específica. Si se elimina la
  -- sesión, el foro queda huérfano de sesión pero sigue vivo (ON DELETE SET NULL).
  session_id UUID REFERENCES public.attendance_sessions(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 5000),
  -- NULL = abierto desde la creación; valor = abre en esa fecha
  opens_at TIMESTAMPTZ,
  -- NULL = sin cierre automático; valor = cierra automáticamente
  closes_at TIMESTAMPTZ,
  -- NULL = no cerrado manualmente; valor = momento del cierre manual del docente
  manually_closed_at TIMESTAMPTZ,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Coherencia mínima: si ambas fechas están, opens_at < closes_at
  CONSTRAINT forums_open_close_order_check CHECK (
    opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at
  )
);

CREATE INDEX IF NOT EXISTS idx_forums_course      ON public.forums(course_id);
CREATE INDEX IF NOT EXISTS idx_forums_session     ON public.forums(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_forums_created     ON public.forums(created_at DESC);

DROP TRIGGER IF EXISTS trg_forums_updated_at ON public.forums;
CREATE TRIGGER trg_forums_updated_at
  BEFORE UPDATE ON public.forums
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ── 2) Predicado helper: ¿el foro está abierto AHORA mismo? ─────────
-- Útil tanto para RLS como para el frontend (vía RPC).
CREATE OR REPLACE FUNCTION public.is_forum_open(_forum_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.forums f
    WHERE f.id = _forum_id
      AND f.manually_closed_at IS NULL
      AND (f.opens_at IS NULL OR f.opens_at <= now())
      AND (f.closes_at IS NULL OR f.closes_at > now())
  );
$$;

REVOKE ALL ON FUNCTION public.is_forum_open(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_forum_open(UUID) TO authenticated;

-- ── 3) Agregar forum_id a forum_threads (NULLABLE primero) ──────────

ALTER TABLE public.forum_threads
  ADD COLUMN IF NOT EXISTS forum_id UUID REFERENCES public.forums(id) ON DELETE CASCADE;

-- ── 4) Backfill: 1 foro "General" por curso con hilos existentes ────
-- INSERT ... SELECT DISTINCT garantiza UN foro por curso. El título
-- queda fijo a "General" para que el docente lo distinga del resto;
-- description explica el origen.
INSERT INTO public.forums (course_id, title, description, created_by)
SELECT DISTINCT
  ft.course_id,
  'General',
  'Foro creado automáticamente para conservar las discusiones previas a la introducción del modelo de foros con ventanas de apertura/cierre.',
  -- created_by: el primer autor de hilo del curso. Si todos son NULL
  -- (autores borrados), queda NULL — el foro sigue siendo válido.
  (SELECT author_id FROM public.forum_threads ft2
    WHERE ft2.course_id = ft.course_id AND ft2.author_id IS NOT NULL
    ORDER BY created_at ASC LIMIT 1)
FROM public.forum_threads ft
WHERE NOT EXISTS (
  SELECT 1 FROM public.forums f
  WHERE f.course_id = ft.course_id AND f.title = 'General'
);

-- Asignar forum_id a los hilos existentes apuntando al "General" de su curso
UPDATE public.forum_threads ft
   SET forum_id = (
     SELECT f.id FROM public.forums f
      WHERE f.course_id = ft.course_id AND f.title = 'General'
      LIMIT 1
   )
 WHERE ft.forum_id IS NULL;

-- ── 5) Set forum_id NOT NULL + índice ───────────────────────────────

ALTER TABLE public.forum_threads
  ALTER COLUMN forum_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_forum_threads_forum ON public.forum_threads(forum_id, last_activity_at DESC);

-- ── 6) RLS forums ───────────────────────────────────────────────────

ALTER TABLE public.forums ENABLE ROW LEVEL SECURITY;

-- SELECT: admin + teachers del curso + estudiantes matriculados
DROP POLICY IF EXISTS "forums_select" ON public.forums;
CREATE POLICY "forums_select"
  ON public.forums FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = forums.course_id AND user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments
      WHERE course_id = forums.course_id AND user_id = auth.uid()
    )
  );

-- INSERT: solo admin + teachers del curso (estudiantes NO crean foros)
DROP POLICY IF EXISTS "forums_insert_teacher" ON public.forums;
CREATE POLICY "forums_insert_teacher"
  ON public.forums FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND (
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers
        WHERE course_id = forums.course_id AND user_id = auth.uid()
      )
    )
  );

-- UPDATE: admin + teachers del curso (editar título, fechas, cerrar manual, etc.)
DROP POLICY IF EXISTS "forums_update_teacher" ON public.forums;
CREATE POLICY "forums_update_teacher"
  ON public.forums FOR UPDATE TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = forums.course_id AND user_id = auth.uid()
    )
  );

-- DELETE: admin + teachers del curso. ON DELETE CASCADE en forum_threads
-- borra los hilos asociados.
DROP POLICY IF EXISTS "forums_delete_teacher" ON public.forums;
CREATE POLICY "forums_delete_teacher"
  ON public.forums FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = forums.course_id AND user_id = auth.uid()
    )
  );

-- ── 7) Actualizar RLS de forum_threads para considerar ventana ───────
-- Mantenemos el SELECT igual (cualquiera con acceso al curso ve hilos
-- aunque el foro esté cerrado — historial sigue legible).
-- El INSERT pasa a exigir que el foro esté abierto, EXCEPTO si el
-- usuario es admin/teacher del curso (ellos pueden postear siempre).

DROP POLICY IF EXISTS "forum_threads_insert" ON public.forum_threads;
CREATE POLICY "forum_threads_insert"
  ON public.forum_threads FOR INSERT TO authenticated
  WITH CHECK (
    author_id = auth.uid()
    AND (
      -- Admin o teacher del curso: siempre puede postear
      public.has_role(auth.uid(), 'Admin')
      OR EXISTS (
        SELECT 1 FROM public.course_teachers
        WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
      )
      -- Estudiante matriculado: solo si el foro está abierto
      OR (
        EXISTS (
          SELECT 1 FROM public.course_enrollments
          WHERE course_id = forum_threads.course_id AND user_id = auth.uid()
        )
        AND public.is_forum_open(forum_threads.forum_id)
      )
    )
  );

-- Mismo trato para forum_replies: estudiantes solo responden si el foro
-- está abierto (y el hilo no está locked); admin/teacher siempre.
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
          OR (
            EXISTS (
              SELECT 1 FROM public.course_enrollments
              WHERE course_id = t.course_id AND user_id = auth.uid()
            )
            AND public.is_forum_open(t.forum_id)
          )
        )
    )
  );

-- ── 8) RPC para cerrar / reabrir foro manualmente ───────────────────
-- Encapsula el toggle de `manually_closed_at` para que la UI no tenga
-- que setear `now()` desde el cliente (y para audit + claridad).
CREATE OR REPLACE FUNCTION public.toggle_forum_closed(
  _forum_id UUID,
  _close    BOOLEAN
) RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _course_id UUID;
  _new_value TIMESTAMPTZ;
BEGIN
  SELECT course_id INTO _course_id FROM public.forums WHERE id = _forum_id;
  IF _course_id IS NULL THEN
    RAISE EXCEPTION 'Foro no encontrado';
  END IF;

  IF NOT (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers
      WHERE course_id = _course_id AND user_id = auth.uid()
    )
  ) THEN
    RAISE EXCEPTION 'Solo el docente del curso o admin pueden cerrar o reabrir un foro';
  END IF;

  _new_value := CASE WHEN _close THEN now() ELSE NULL END;
  UPDATE public.forums SET manually_closed_at = _new_value WHERE id = _forum_id;
  RETURN _new_value;
END
$$;

REVOKE ALL ON FUNCTION public.toggle_forum_closed(UUID, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.toggle_forum_closed(UUID, BOOLEAN) TO authenticated;

-- ── 9) Actualizar trigger de notificación al usar el nuevo URL ──────
-- Antes: `/app/forum/{course}/{thread}` (2 segmentos después de /forum/)
-- Ahora: `/app/forum/{course}/{forum}/{thread}` (3 segmentos)
CREATE OR REPLACE FUNCTION public._notify_forum_thread_author_on_reply()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _thread RECORD;
  _author_name TEXT;
BEGIN
  SELECT t.id, t.title, t.author_id, t.course_id, t.forum_id
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
    '/app/forum/' || _thread.course_id::text || '/' || _thread.forum_id::text || '/' || _thread.id::text
  );

  RETURN NEW;
END
$$;

-- ── 10) Reescribir notifications existentes al nuevo formato URL ────
-- Para no dejar links rotos a notificaciones viejas. El parser extrae
-- el thread_id del segmento 5 del path /app/forum/{course}/{thread} y
-- JOIN-ea con forum_threads (que ya tiene forum_id post-backfill) para
-- reconstruir el link nuevo. Solo afecta links que NO tienen ya el
-- formato de 3 segmentos (LIKE '/app/forum/X/Y/Z%').
UPDATE public.notifications n
   SET link = '/app/forum/' || ft.course_id::text || '/' || ft.forum_id::text || '/' || ft.id::text
  FROM public.forum_threads ft
 WHERE n.link IS NOT NULL
   AND n.link LIKE '/app/forum/%/%'
   AND n.link NOT LIKE '/app/forum/%/%/%'
   AND split_part(n.link, '/', 5) = ft.id::text;

NOTIFY pgrst, 'reload schema';

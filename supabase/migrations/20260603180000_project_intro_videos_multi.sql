-- ──────────────────────────────────────────────────────────────────────
-- Multi-video gate para entregas de proyecto.
--
-- Antes (migración 20260531200000) los proyectos tenían UN único
-- `code_intro_video_url` en `projects` y un `video_watched_at` único
-- en `project_submissions`. Esta migración escala a N videos:
--
--   - `project_intro_videos`: una fila por video. Orden estricto via
--     `position` (int). El cliente renderiza en orden y desbloquea el
--     siguiente cuando el anterior se ve completo.
--   - `project_submission_video_views`: una fila por (submission, video)
--     vista. El gate de entrega exige que el count de views ≥ count
--     de videos del proyecto.
--   - Backfill: cada proyecto con `code_intro_video_url` no-vacío
--     gana una fila inicial en `project_intro_videos` con position 0.
--     La columna vieja se mantiene SIN drop por compat — la UI nueva
--     ignora `code_intro_video_url` y usa solo la tabla nueva.
--
-- RPC `mark_project_video_watched` cambia su signature: ahora recibe
-- `(_submission_id uuid, _video_id uuid)` y persiste UNA view a la vez.
-- La versión vieja con solo `_submission_id` queda como DROP — break
-- intencional: el cliente nuevo siempre pasa video_id. Si quedan callers
-- viejos, fallan loud (mejor que silenciar el bug del gate).
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Tabla de videos del proyecto ─────────────────────────────────
CREATE TABLE IF NOT EXISTS public.project_intro_videos (
  id          UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT,
  -- Posición 0-based para ordenar en la UI. Estricto: el cliente
  -- bloquea el siguiente video hasta que el anterior se vea completo.
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un proyecto NO puede tener dos videos con la misma posición. Si el
-- docente reordena vía drag, el cliente persiste el set completo en
-- una transacción (delete + insert) para no luchar con el UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_intro_videos_pos
  ON public.project_intro_videos (project_id, position);

CREATE INDEX IF NOT EXISTS idx_project_intro_videos_project
  ON public.project_intro_videos (project_id);

COMMENT ON TABLE public.project_intro_videos IS
  'Videos introductorios obligatorios de un proyecto. El estudiante debe verlos TODOS (orden estricto) antes de poder entregar. Reemplaza `projects.code_intro_video_url` (singular, legacy).';

-- RLS: SELECT abierto a authenticated (los estudiantes asignados al
-- proyecto pueden ver la lista); INSERT/UPDATE/DELETE solo Docente del
-- curso del proyecto o Admin. Mismo modelo que `project_files`.
ALTER TABLE public.project_intro_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_intro_videos_select_auth" ON public.project_intro_videos;
CREATE POLICY "project_intro_videos_select_auth"
  ON public.project_intro_videos FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "project_intro_videos_write_teacher" ON public.project_intro_videos;
CREATE POLICY "project_intro_videos_write_teacher"
  ON public.project_intro_videos FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_teachers ct ON ct.course_id = p.course_id
      WHERE p.id = project_intro_videos.project_id AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.projects p
      JOIN public.course_teachers ct ON ct.course_id = p.course_id
      WHERE p.id = project_intro_videos.project_id AND ct.user_id = auth.uid()
    )
  );

-- ─── 2) Tabla de views por (submission, video) ───────────────────────
CREATE TABLE IF NOT EXISTS public.project_submission_video_views (
  submission_id UUID NOT NULL REFERENCES public.project_submissions(id) ON DELETE CASCADE,
  video_id      UUID NOT NULL REFERENCES public.project_intro_videos(id) ON DELETE CASCADE,
  watched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_project_submission_video_views_sub
  ON public.project_submission_video_views (submission_id);

COMMENT ON TABLE public.project_submission_video_views IS
  'Una fila por video del proyecto que el estudiante completó dentro de su submission. El gate de entrega exige views.count >= project_intro_videos.count.';

-- RLS: el estudiante (o miembro del grupo) lee y escribe SOLO las views
-- de su propia submission; Docente/Admin lee todas (auditoría) pero no
-- escribe — las inserciones las hace el RPC SECURITY DEFINER.
ALTER TABLE public.project_submission_video_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "project_submission_video_views_select_owner_or_staff"
  ON public.project_submission_video_views;
CREATE POLICY "project_submission_video_views_select_owner_or_staff"
  ON public.project_submission_video_views FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.project_submissions s
      WHERE s.id = project_submission_video_views.submission_id
        AND (
          s.user_id = auth.uid()
          OR (s.group_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.project_group_members
                WHERE group_id = s.group_id AND user_id = auth.uid()
             ))
          OR EXISTS (
            SELECT 1 FROM public.projects p
            JOIN public.course_teachers ct ON ct.course_id = p.course_id
            WHERE p.id = s.project_id AND ct.user_id = auth.uid()
          )
        )
    )
  );

-- ─── 3) Backfill desde `projects.code_intro_video_url` ───────────────
-- Cada proyecto con video legacy → fila inicial en la tabla nueva. Si
-- ya existe una fila para ese proyecto (re-aplicación de la migración),
-- el ON CONFLICT skip evita duplicados.
INSERT INTO public.project_intro_videos (project_id, url, title, position)
SELECT
  id,
  code_intro_video_url,
  'Video introductorio' AS title,
  0 AS position
FROM public.projects
WHERE code_intro_video_url IS NOT NULL
  AND code_intro_video_url <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.project_intro_videos v WHERE v.project_id = projects.id
  );

-- Backfill del tracking: si una submission tiene `video_watched_at` no-null
-- y existe una fila en `project_intro_videos` (la del backfill), insertar
-- la view correspondiente para no perder el progreso del estudiante.
INSERT INTO public.project_submission_video_views (submission_id, video_id, watched_at)
SELECT
  s.id,
  v.id,
  s.video_watched_at
FROM public.project_submissions s
JOIN public.project_intro_videos v ON v.project_id = s.project_id AND v.position = 0
WHERE s.video_watched_at IS NOT NULL
ON CONFLICT (submission_id, video_id) DO NOTHING;

-- ─── 4) RPC: marcar UN video como visto ──────────────────────────────
-- Reemplaza el RPC viejo `mark_project_video_watched(uuid)`. La nueva
-- signature pide explícitamente el video_id para evitar ambigüedad
-- con N videos. SECURITY DEFINER para que el estudiante NO necesite
-- INSERT directo sobre la tabla (RLS solo SELECT).
DROP FUNCTION IF EXISTS public.mark_project_video_watched(uuid);

CREATE OR REPLACE FUNCTION public.mark_project_video_watched(
  _submission_id UUID,
  _video_id      UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_owner UUID;
  v_group_id UUID;
  v_project_id UUID;
  v_video_project UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Validar que el caller es dueño de la submission (o miembro del grupo).
  SELECT user_id, group_id, project_id
    INTO v_owner, v_group_id, v_project_id
    FROM public.project_submissions
   WHERE id = _submission_id;
  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'Submission no encontrada';
  END IF;
  IF v_owner <> v_user
     AND NOT EXISTS (
       SELECT 1 FROM public.project_group_members
        WHERE group_id = v_group_id AND user_id = v_user
     )
  THEN
    RAISE EXCEPTION 'No tienes permiso para marcar esta submission';
  END IF;

  -- Validar que el video pertenece al mismo proyecto que la submission
  -- (defensa contra IDs mezclados desde el cliente).
  SELECT project_id INTO v_video_project
    FROM public.project_intro_videos
   WHERE id = _video_id;
  IF v_video_project IS NULL THEN
    RAISE EXCEPTION 'Video no encontrado';
  END IF;
  IF v_video_project <> v_project_id THEN
    RAISE EXCEPTION 'El video no pertenece al proyecto de esta submission';
  END IF;

  INSERT INTO public.project_submission_video_views (submission_id, video_id, watched_at)
  VALUES (_submission_id, _video_id, now())
  ON CONFLICT (submission_id, video_id) DO NOTHING;

  -- Compat: también actualizamos `video_watched_at` legacy cuando se
  -- alcanza el último video. El campo se usaba como "todos vistos" en
  -- código viejo; mientras no migremos todos los callers, lo mantenemos
  -- en sync con el conteo real.
  IF (
    SELECT count(*) FROM public.project_submission_video_views
     WHERE submission_id = _submission_id
  ) >= (
    SELECT count(*) FROM public.project_intro_videos
     WHERE project_id = v_project_id
  ) THEN
    UPDATE public.project_submissions
       SET video_watched_at = COALESCE(video_watched_at, now())
     WHERE id = _submission_id;
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.mark_project_video_watched(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_project_video_watched(UUID, UUID) TO authenticated;

-- ─── 5) Helper: ¿el estudiante vio TODOS los videos del proyecto? ─────
-- Útil para el gate del botón "Entregar" del cliente Y para validar en
-- el server cuando se acepta una submission (vía trigger BEFORE INSERT
-- o RPC dedicada — depende del flujo del cliente actual).
CREATE OR REPLACE FUNCTION public.project_videos_all_watched(_submission_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT (
    SELECT count(*) FROM public.project_intro_videos v
     WHERE v.project_id = (
       SELECT project_id FROM public.project_submissions WHERE id = _submission_id
     )
  ) <= (
    SELECT count(*) FROM public.project_submission_video_views
     WHERE submission_id = _submission_id
  );
$$;

REVOKE ALL ON FUNCTION public.project_videos_all_watched(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.project_videos_all_watched(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

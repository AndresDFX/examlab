-- ──────────────────────────────────────────────────────────────────────
-- Multi-video gate para entregas de taller.
--
-- Mismo modelo que la migración 20260603180000 (proyectos), pero para
-- talleres. El docente puede asociar N videos introductorios a un
-- taller; el estudiante DEBE verlos todos en orden estricto antes de
-- poder entregar.
--
-- A diferencia de proyectos (donde los videos solo aplican a entregas
-- con pregunta `codigo_zip`), en talleres aplican a CUALQUIER entrega
-- — los talleres no tienen un slot "código" distinguido; cada pregunta
-- es una entrega individual.
-- ──────────────────────────────────────────────────────────────────────

-- ─── 1) Tabla de videos del taller ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_intro_videos (
  id          UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  workshop_id UUID NOT NULL REFERENCES public.workshops(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT,
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workshop_intro_videos_pos
  ON public.workshop_intro_videos (workshop_id, position);

CREATE INDEX IF NOT EXISTS idx_workshop_intro_videos_workshop
  ON public.workshop_intro_videos (workshop_id);

COMMENT ON TABLE public.workshop_intro_videos IS
  'Videos introductorios obligatorios de un taller. El estudiante debe verlos TODOS (orden estricto) antes de poder entregar.';

-- RLS: SELECT abierto a authenticated; INSERT/UPDATE/DELETE solo
-- Docente del curso del taller o Admin. Mismo modelo que
-- `project_intro_videos`.
ALTER TABLE public.workshop_intro_videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "workshop_intro_videos_select_auth" ON public.workshop_intro_videos;
CREATE POLICY "workshop_intro_videos_select_auth"
  ON public.workshop_intro_videos FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "workshop_intro_videos_write_teacher" ON public.workshop_intro_videos;
CREATE POLICY "workshop_intro_videos_write_teacher"
  ON public.workshop_intro_videos FOR ALL TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.workshops w
      JOIN public.course_teachers ct ON ct.course_id = w.course_id
      WHERE w.id = workshop_intro_videos.workshop_id AND ct.user_id = auth.uid()
    )
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.workshops w
      JOIN public.course_teachers ct ON ct.course_id = w.course_id
      WHERE w.id = workshop_intro_videos.workshop_id AND ct.user_id = auth.uid()
    )
  );

-- ─── 2) Tabla de views por (submission, video) ───────────────────────
CREATE TABLE IF NOT EXISTS public.workshop_submission_video_views (
  submission_id UUID NOT NULL REFERENCES public.workshop_submissions(id) ON DELETE CASCADE,
  video_id      UUID NOT NULL REFERENCES public.workshop_intro_videos(id) ON DELETE CASCADE,
  watched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (submission_id, video_id)
);

CREATE INDEX IF NOT EXISTS idx_workshop_submission_video_views_sub
  ON public.workshop_submission_video_views (submission_id);

COMMENT ON TABLE public.workshop_submission_video_views IS
  'Una fila por video del taller que el estudiante completó dentro de su submission. El gate de entrega exige views.count >= workshop_intro_videos.count.';

ALTER TABLE public.workshop_submission_video_views ENABLE ROW LEVEL SECURITY;

-- El estudiante (o miembro del grupo) lee/escribe SOLO las views de su
-- propia submission; Docente/Admin lee todas para auditoría. Las
-- inserciones reales las hace el RPC SECURITY DEFINER.
DROP POLICY IF EXISTS "workshop_submission_video_views_select_owner_or_staff"
  ON public.workshop_submission_video_views;
CREATE POLICY "workshop_submission_video_views_select_owner_or_staff"
  ON public.workshop_submission_video_views FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.workshop_submissions s
      WHERE s.id = workshop_submission_video_views.submission_id
        AND (
          s.user_id = auth.uid()
          OR (s.group_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.workshop_group_members
                WHERE group_id = s.group_id AND user_id = auth.uid()
             ))
          OR EXISTS (
            SELECT 1 FROM public.workshops w
            JOIN public.course_teachers ct ON ct.course_id = w.course_id
            WHERE w.id = s.workshop_id AND ct.user_id = auth.uid()
          )
        )
    )
  );

-- ─── 3) RPC: marcar UN video como visto ──────────────────────────────
CREATE OR REPLACE FUNCTION public.mark_workshop_video_watched(
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
  v_workshop_id UUID;
  v_video_workshop UUID;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  -- Caller es dueño de la submission o miembro del grupo.
  SELECT user_id, group_id, workshop_id
    INTO v_owner, v_group_id, v_workshop_id
    FROM public.workshop_submissions
   WHERE id = _submission_id;
  IF v_workshop_id IS NULL THEN
    RAISE EXCEPTION 'Submission no encontrada';
  END IF;
  IF v_owner <> v_user
     AND NOT EXISTS (
       SELECT 1 FROM public.workshop_group_members
        WHERE group_id = v_group_id AND user_id = v_user
     )
  THEN
    RAISE EXCEPTION 'No tienes permiso para marcar esta submission';
  END IF;

  -- El video pertenece al mismo taller que la submission.
  SELECT workshop_id INTO v_video_workshop
    FROM public.workshop_intro_videos
   WHERE id = _video_id;
  IF v_video_workshop IS NULL THEN
    RAISE EXCEPTION 'Video no encontrado';
  END IF;
  IF v_video_workshop <> v_workshop_id THEN
    RAISE EXCEPTION 'El video no pertenece al taller de esta submission';
  END IF;

  INSERT INTO public.workshop_submission_video_views (submission_id, video_id, watched_at)
  VALUES (_submission_id, _video_id, now())
  ON CONFLICT (submission_id, video_id) DO NOTHING;
END
$$;

REVOKE ALL ON FUNCTION public.mark_workshop_video_watched(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_workshop_video_watched(UUID, UUID) TO authenticated;

-- ─── 4) Helper: ¿el estudiante vio TODOS los videos del taller? ──────
CREATE OR REPLACE FUNCTION public.workshop_videos_all_watched(_submission_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT (
    SELECT count(*) FROM public.workshop_intro_videos v
     WHERE v.workshop_id = (
       SELECT workshop_id FROM public.workshop_submissions WHERE id = _submission_id
     )
  ) <= (
    SELECT count(*) FROM public.workshop_submission_video_views
     WHERE submission_id = _submission_id
  );
$$;

REVOKE ALL ON FUNCTION public.workshop_videos_all_watched(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workshop_videos_all_watched(UUID) TO authenticated;

NOTIFY pgrst, 'reload schema';

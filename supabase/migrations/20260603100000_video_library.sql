-- ──────────────────────────────────────────────────────────────────────
-- Biblioteca de videos reutilizables.
--
-- Motivación: hasta ahora cada proyecto guardaba su propia URL en
-- `projects.code_intro_video_url`. Eso obliga al docente a copiar/pegar
-- la misma URL en N proyectos y dificulta auditar qué videos están en
-- uso. Esta migración introduce una biblioteca compartida:
--   - El docente sube/registra un video UNA vez (URL externa de YouTube/
--     Vimeo, o un MP4 directo en CDN/Storage).
--   - Cada proyecto / taller / módulo futuro referencia por video_id en
--     lugar de URL literal.
--   - El admin puede curar la biblioteca, deshabilitar videos sin
--     romper proyectos (el frontend muestra "video no disponible").
--
-- Diseño:
--   videos
--     id              uuid PK
--     title           text NOT NULL
--     description     text
--     url             text NOT NULL  -- externa (YouTube/Vimeo/MP4)
--     provider        text NOT NULL CHECK (youtube|vimeo|direct)
--     duration_sec    int (opcional — para mostrar "12:34" en UI)
--     uploaded_by     uuid REFERENCES auth.users
--     created_at      timestamptz DEFAULT now()
--     is_archived     boolean DEFAULT false
--
-- `projects.code_intro_video_id` se agrega como FK opcional; mantenemos
-- `code_intro_video_url` por compat con proyectos viejos (el frontend
-- prefiere `code_intro_video_id` si está poblada).
-- ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  description text,
  url text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('youtube', 'vimeo', 'direct')),
  duration_sec int,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by ON public.videos (uploaded_by);
CREATE INDEX IF NOT EXISTS idx_videos_active_title ON public.videos (title)
  WHERE is_archived = false;

COMMENT ON TABLE public.videos IS
  'Biblioteca compartida de videos. Cada video se registra una vez y se referencia por id en proyectos/talleres/módulos futuros que necesiten un "video gate" o referencia.';

-- updated_at trigger
CREATE OR REPLACE FUNCTION public._videos_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_videos_updated_at ON public.videos;
CREATE TRIGGER trg_videos_updated_at
  BEFORE UPDATE ON public.videos
  FOR EACH ROW EXECUTE FUNCTION public._videos_touch_updated_at();

-- RLS: lectura para cualquier autenticado (los alumnos necesitan ver
-- el video referenciado); escritura Docente/Admin.
ALTER TABLE public.videos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "videos_read_all" ON public.videos;
CREATE POLICY "videos_read_all"
  ON public.videos FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS "videos_write_staff" ON public.videos;
CREATE POLICY "videos_write_staff"
  ON public.videos FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

-- FK opcional en projects. La URL legacy queda en code_intro_video_url
-- — el frontend prefiere el id si está poblado.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS code_intro_video_id uuid REFERENCES public.videos(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.projects.code_intro_video_id IS
  'Video introductorio (biblioteca). Si está poblado, el frontend usa este registro y ignora code_intro_video_url (que queda por compat con proyectos previos).';

-- Tracking de visualización a nivel global de plataforma — para que el
-- mismo video pueda ser obligatorio en múltiples contextos (proyecto,
-- taller, módulo) sin duplicar columnas en cada tabla.
CREATE TABLE IF NOT EXISTS public.video_views (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  video_id uuid NOT NULL REFERENCES public.videos(id) ON DELETE CASCADE,
  watched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

ALTER TABLE public.video_views ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "video_views_read_self" ON public.video_views;
CREATE POLICY "video_views_read_self"
  ON public.video_views FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'));

DROP POLICY IF EXISTS "video_views_insert_self" ON public.video_views;
CREATE POLICY "video_views_insert_self"
  ON public.video_views FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

NOTIFY pgrst, 'reload schema';

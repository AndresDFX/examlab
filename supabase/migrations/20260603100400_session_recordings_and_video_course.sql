-- ──────────────────────────────────────────────────────────────────────
-- Grabaciones de sesión + asociación opcional de videos a curso.
--
-- Dos features acopladas:
--
--  1) `attendance_sessions` gana DOS campos para registrar la grabación
--     de la clase:
--       - `recording_url TEXT` → enlace libre (típicamente la URL de
--         grabación de Google Meet, Microsoft Teams, Zoom, Loom, etc.).
--         Estos servicios NO permiten embed via iframe por su política
--         de privacidad, así que la UI los muestra como un botón "Ver
--         grabación" que abre en nueva pestaña.
--       - `recording_video_id UUID` → FK opcional a un video de la
--         biblioteca (`videos.id`). Cuando el docente ya subió la
--         grabación al storage propio o pegó un YouTube/Vimeo, lo
--         referencia aquí y la UI lo embed automáticamente.
--     Los dos campos son independientes — uno, ambos o ninguno pueden
--     estar poblados. La UI prioriza `recording_video_id` (embed nativo)
--     y muestra `recording_url` como botón secundario.
--
--  2) `videos.course_id UUID` → permite que el docente tagee un video
--     a UN curso al subirlo. Sirve para filtrar la biblioteca por curso
--     en la UI (la lista crece rápido si se reusan videos entre
--     proyectos/talleres/sesiones). NULL = video global de plataforma
--     (visible en todos los selectores de cualquier curso).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS recording_url TEXT,
  ADD COLUMN IF NOT EXISTS recording_video_id UUID REFERENCES public.videos(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.attendance_sessions.recording_url IS
  'Enlace libre a la grabación de la clase (Meet, Teams, Zoom, Loom, etc.). Se muestra como botón "Ver grabación" porque estos servicios bloquean embed via iframe.';

COMMENT ON COLUMN public.attendance_sessions.recording_video_id IS
  'Referencia opcional a un video de la biblioteca (`videos.id`). Cuando está poblado, la UI lo embebe en el detalle de la sesión.';

CREATE INDEX IF NOT EXISTS idx_attendance_sessions_recording_video
  ON public.attendance_sessions (recording_video_id)
  WHERE recording_video_id IS NOT NULL;

ALTER TABLE public.videos
  ADD COLUMN IF NOT EXISTS course_id UUID REFERENCES public.courses(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.videos.course_id IS
  'Curso al que pertenece el video. NULL = video global (visible en todos los cursos). Se usa para filtrar la biblioteca por curso desde la UI.';

CREATE INDEX IF NOT EXISTS idx_videos_course_id
  ON public.videos (course_id)
  WHERE course_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

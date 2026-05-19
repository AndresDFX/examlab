-- ──────────────────────────────────────────────────────────────────────
-- Video explicativo OBLIGATORIO antes de la entrega de código.
--
-- Motivación: muchos alumnos suben código basura / placeholder porque no
-- leyeron el enunciado. El docente puede subir un video explicando qué
-- se evalúa y la plataforma fuerza que se vea ÍNTEGRO antes de habilitar
-- el botón "Entregar". No reemplaza la descripción escrita; la
-- complementa con un canal multimedia que evita la lectura superficial.
--
-- Diseño:
--  - Columna `code_intro_video_url` en `projects` — URL externa (YouTube,
--    Vimeo, MP4 directo en CDN). El frontend renderiza con un <video>
--    nativo cuando es MP4/WebM, o un <iframe> para YouTube/Vimeo.
--  - El control de "video visto" vive en el cliente (timestamps + state)
--    + se persiste en `project_submissions.video_watched_at` para que
--    el alumno no tenga que re-verlo si recarga la página después de
--    haberlo completado una vez.
--  - Bypass por defecto si la URL está vacía — proyectos sin video no
--    requieren gate (compatible con proyectos existentes).
--
-- Seguridad del gate:
--  El control "no avanzar sin ver el video" es client-side por
--  naturaleza — la verificación final está en el RPC/insert de la
--  submission, donde podemos requerir que `video_watched_at IS NOT NULL`
--  si el proyecto tiene `code_intro_video_url`. Eso bloquea bypass por
--  devtools desde el cliente, manteniendo la garantía en el server.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS code_intro_video_url text;

COMMENT ON COLUMN public.projects.code_intro_video_url IS
  'URL del video explicativo que el alumno debe ver íntegro antes de entregar código. Soporta YouTube/Vimeo (iframe) y MP4/WebM directo (<video> nativo). Si null/vacío, no se exige video.';

ALTER TABLE public.project_submissions
  ADD COLUMN IF NOT EXISTS video_watched_at timestamptz;

COMMENT ON COLUMN public.project_submissions.video_watched_at IS
  'Timestamp en el que el alumno terminó de ver el video introductorio del proyecto. Si el proyecto exige video y este campo es null, la plataforma rechaza la entrega.';

-- Función helper SQL: marca el video como visto para la submission del
-- caller. SECURITY DEFINER para que el alumno actualice solo su propia
-- submission sin necesitar RLS UPDATE sobre la tabla.
CREATE OR REPLACE FUNCTION public.mark_project_video_watched(_submission_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user uuid;
  v_owner uuid;
  v_group_id uuid;
BEGIN
  v_user := auth.uid();
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  -- Solo el dueño de la submission (o un miembro del grupo si aplica)
  -- puede marcarla como vista. Coherente con la RLS de project_submissions.
  SELECT user_id, group_id INTO v_owner, v_group_id
    FROM public.project_submissions
   WHERE id = _submission_id;
  IF v_owner IS NULL THEN
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
  UPDATE public.project_submissions
     SET video_watched_at = now()
   WHERE id = _submission_id
     AND video_watched_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_project_video_watched(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

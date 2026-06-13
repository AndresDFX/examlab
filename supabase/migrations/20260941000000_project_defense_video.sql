-- ──────────────────────────────────────────────────────────────────────
-- Video de sustentación en las entregas de proyecto.
--
-- El docente puede registrar el video de la sustentación de cada entrega:
-- pegar un enlace externo (Drive / YouTube / grabación de Meet) o subir un
-- archivo al bucket `project-files`. En ambos casos se guarda en esta
-- columna: una URL `http(s)://…` (enlace externo) o un PATH del bucket
-- `project-files` (archivo subido, que el front resuelve con signed URL).
--
-- No requiere RLS nueva: la edición la cubre la policy de UPDATE de staff
-- sobre project_submissions (la misma que ya usa saveDefense para
-- defense_factor/defense_notes); la subida usa el path `<uid>/...` del
-- propio docente, permitido por la policy de INSERT del bucket project-files.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    ALTER TABLE public.project_submissions
      ADD COLUMN IF NOT EXISTS defense_video_url TEXT;
  END IF;
END $$;

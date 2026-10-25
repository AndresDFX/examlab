-- ──────────────────────────────────────────────────────────────────────
-- Transcripciones de Teams: carga MANUAL (.vtt) + texto del DOCENTE.
--
-- Contexto: TI de la UNIAJC no aprobó la app de Graph, así que el camino
-- automático (acción fetch_transcript) está bloqueado. El docente igual
-- puede descargar el .vtt desde Teams web y subirlo a mano. Además, para
-- alimentar al Tutor IA solo con lo que dijo el DOCENTE (la tabla tiene
-- voces de estudiantes), guardamos aparte sus intervenciones.
--
-- Columnas nuevas (todas opcionales para no romper filas de Graph ya traídas):
--   source           'graph' | 'upload' — de dónde salió la transcripción.
--   file_name        nombre del .vtt subido (para mostrarlo en la UI).
--   speakers         hablantes detectados en el VTT (nombres para mostrar).
--   teacher_speakers subconjunto de `speakers` marcado como el docente.
--   teacher_text     solo las intervenciones del docente (lo que lee el Tutor).
--
-- La RLS NO cambia: staff SELECT + DELETE; el contenido lo escribe el edge
-- `calendar` con service_role (acciones upload_transcript / set_transcript_speakers).
-- Sin NOTIFY pgrst — el event trigger pgrst_ddl_watch recarga el esquema solo.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.session_transcripts') IS NULL THEN
    RAISE NOTICE 'public.session_transcripts no existe — nada que extender';
    RETURN;
  END IF;

  ALTER TABLE public.session_transcripts
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'graph',
    ADD COLUMN IF NOT EXISTS file_name TEXT,
    ADD COLUMN IF NOT EXISTS speakers TEXT[],
    ADD COLUMN IF NOT EXISTS teacher_speakers TEXT[],
    ADD COLUMN IF NOT EXISTS teacher_text TEXT;

  -- Las filas ya existentes (traídas por Graph) quedan source='graph'.
  COMMENT ON COLUMN public.session_transcripts.source IS
    'Origen: graph (fetch_transcript) o upload (.vtt subido a mano).';
  COMMENT ON COLUMN public.session_transcripts.teacher_speakers IS
    'Nombres de hablantes del VTT marcados como el docente. Corregible por el edge.';
  COMMENT ON COLUMN public.session_transcripts.teacher_text IS
    'Solo las intervenciones del docente. Es lo UNICO que el Tutor IA puede leer.';
END $$;

-- ──────────────────────────────────────────────────────────────────────
-- Repair: la migración 20260509220000_session_content_assignment.sql
-- se salta silenciosamente si `public.generated_contents` no existe en
-- el momento de aplicarla. En algunos despliegues Lovable la aplicó
-- antes que contents_module → quedó marcada como aplicada pero sin
-- crear las columnas, dejando errores `column ... does not exist`.
--
-- Esta migración es idempotente (todo es `IF NOT EXISTS` / `DROP`+`CREATE`)
-- y replica lo que la original debió haber hecho. Si `generated_contents`
-- TAMPOCO existe aquí (caso raro), volvemos a saltar y dejamos al
-- siguiente despliegue arreglarlo.
-- ──────────────────────────────────────────────────────────────────────

DO $migration$
DECLARE
  has_gc boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'generated_contents'
  ) INTO has_gc;

  IF NOT has_gc THEN
    RAISE NOTICE 'Skipping repair: public.generated_contents no existe todavía.';
    RETURN;
  END IF;

  EXECUTE $sql$
    ALTER TABLE public.attendance_sessions
      ADD COLUMN IF NOT EXISTS content_id UUID
        REFERENCES public.generated_contents(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS content_class_index INT
  $sql$;

  EXECUTE 'ALTER TABLE public.attendance_sessions
           DROP CONSTRAINT IF EXISTS attendance_sessions_content_index_check';
  EXECUTE 'ALTER TABLE public.attendance_sessions
           ADD CONSTRAINT attendance_sessions_content_index_check CHECK (
             content_id IS NOT NULL OR content_class_index IS NULL
           )';
  EXECUTE 'ALTER TABLE public.attendance_sessions
           DROP CONSTRAINT IF EXISTS attendance_sessions_content_index_positive';
  EXECUTE 'ALTER TABLE public.attendance_sessions
           ADD CONSTRAINT attendance_sessions_content_index_positive CHECK (
             content_class_index IS NULL OR content_class_index >= 1
           )';

  EXECUTE 'CREATE INDEX IF NOT EXISTS attendance_sessions_content_idx
           ON public.attendance_sessions(content_id)
           WHERE content_id IS NOT NULL';

  EXECUTE 'DROP POLICY IF EXISTS gc_student_read_via_session ON storage.objects';
  EXECUTE $sql$
    CREATE POLICY gc_student_read_via_session ON storage.objects
      FOR SELECT TO authenticated
      USING (
        bucket_id = 'generated-contents'
        AND EXISTS (
          SELECT 1
          FROM public.attendance_sessions s
          JOIN public.course_enrollments ce ON ce.course_id = s.course_id
          WHERE ce.user_id = auth.uid()
            AND s.content_id::text = (storage.foldername(name))[2]
        )
      )
  $sql$;

  EXECUTE 'DROP POLICY IF EXISTS generated_contents_student_via_session ON public.generated_contents';
  EXECUTE $sql$
    CREATE POLICY generated_contents_student_via_session ON public.generated_contents
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.attendance_sessions s
          JOIN public.course_enrollments ce ON ce.course_id = s.course_id
          WHERE s.content_id = generated_contents.id
            AND ce.user_id = auth.uid()
        )
      )
  $sql$;
END
$migration$;

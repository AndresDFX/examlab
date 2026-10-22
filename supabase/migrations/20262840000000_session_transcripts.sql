-- ──────────────────────────────────────────────────────────────────────
-- Transcripciones de Teams por sesión de clase.
--
-- El docente organiza una reunión de Teams para la sesión (la crea/sincroniza
-- el módulo Calendario → meeting_url = joinUrl). Tras la clase, con la
-- transcripción activada, el edge `calendar` (acción fetch_transcript) baja
-- las transcripciones de Microsoft Graph y las guarda acá.
--
-- Modelo: parent = attendance_sessions, child = session_transcripts (N por
-- sesión — Teams puede generar más de una transcripción por reunión).
--
-- Privacidad: contiene VOCES de estudiantes, así que SOLO el staff del curso
-- la ve (docente, Admin del tenant, SuperAdmin). Los estudiantes NO — por eso
-- NO hay rama de course_enrollments en el SELECT (a diferencia de
-- session_code_snippets).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'public.attendance_sessions no existe — abortando creación de session_transcripts';
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS public.session_transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES public.attendance_sessions(id) ON DELETE CASCADE,
    -- Hoy solo 'teams'. Columna explícita para que agregar otro origen (Meet,
    -- Zoom) no exija migrar la forma de la tabla.
    provider TEXT NOT NULL DEFAULT 'teams',
    -- Ids de Microsoft Graph: la reunión y la transcripción. external_transcript_id
    -- es UNIQUE para que re-traer sea idempotente (upsert onConflict).
    external_meeting_id TEXT,
    external_transcript_id TEXT NOT NULL,
    -- createdDateTime que reporta Graph para la transcripción (cuándo se generó).
    transcript_created_at TIMESTAMPTZ,
    -- VTT crudo (evidencia) + texto legible «Hablante: frase» (lo que se muestra).
    content_vtt TEXT,
    content_text TEXT,
    fetched_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- Idempotencia del fetch: una misma transcripción de Graph no se duplica.
  CREATE UNIQUE INDEX IF NOT EXISTS uq_session_transcripts_external
    ON public.session_transcripts(external_transcript_id);
  CREATE INDEX IF NOT EXISTS idx_session_transcripts_session
    ON public.session_transcripts(session_id);

  -- ── RLS ───────────────────────────────────────────────────────────
  -- Todo (SELECT/INSERT/UPDATE/DELETE): staff del curso de la sesión.
  -- `is_admin_of_course_tenant(course_id)` cubre Admin-del-tenant + SuperAdmin
  -- con scope de tenant (NO `has_role('Admin')` suelto, que sería leak
  -- cross-tenant). El docente entra por course_teachers.
  ALTER TABLE public.session_transcripts ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS session_transcripts_staff_all ON public.session_transcripts;
  CREATE POLICY session_transcripts_staff_all
    ON public.session_transcripts FOR ALL TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
        WHERE s.id = session_transcripts.session_id
          AND (
            public.is_admin_of_course_tenant(s.course_id)
            OR EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = s.course_id
                AND ct.user_id = auth.uid()
            )
          )
      )
    )
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.attendance_sessions s
        WHERE s.id = session_transcripts.session_id
          AND (
            public.is_admin_of_course_tenant(s.course_id)
            OR EXISTS (
              SELECT 1 FROM public.course_teachers ct
              WHERE ct.course_id = s.course_id
                AND ct.user_id = auth.uid()
            )
          )
      )
    );

  IF to_regprocedure('public.is_admin_of_course_tenant(uuid)') IS NULL THEN
    RAISE NOTICE 'is_admin_of_course_tenant no existe — la rama Admin/SuperAdmin del RLS quedará inactiva hasta aplicar 20260820000000';
  END IF;
END $$;

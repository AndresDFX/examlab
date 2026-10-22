-- ──────────────────────────────────────────────────────────────────────
-- Endurecer session_transcripts (revisión de consistencia de 20262840000000):
--
--  1) La policy `FOR ALL` dejaba al docente INSERTAR/ACTUALIZAR el contenido
--     por REST — un vector de self-tamper sobre la transcripción (editar lo
--     que «dijo» un estudiante). Solo el edge `calendar` debe escribir, y lo
--     hace con service_role (bypassa RLS). Dejamos para el staff únicamente
--     SELECT (leer) y DELETE (borrar la suya), sin INSERT/UPDATE.
--
--  2) El índice único GLOBAL sobre external_transcript_id MUEVE la
--     transcripción entre sesiones que comparten meeting_url (asistencia con
--     un código para varias sesiones): el upsert de la 2ª sesión reescribía la
--     fila de la 1ª. Único por (session_id, external_transcript_id): cada
--     sesión guarda su propia copia. El edge usa ese onConflict.
--
-- Migración NUEVA (no se edita 20262840000000, que ya pudo aplicarse).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.session_transcripts') IS NULL THEN
    RAISE NOTICE 'public.session_transcripts no existe — nada que endurecer';
    RETURN;
  END IF;

  -- ── Índice único: global → compuesto ──────────────────────────────
  DROP INDEX IF EXISTS public.uq_session_transcripts_external;
  CREATE UNIQUE INDEX IF NOT EXISTS uq_session_transcripts_session_external
    ON public.session_transcripts(session_id, external_transcript_id);

  -- ── Policies: solo lectura (+ borrado) para el staff del curso ─────
  DROP POLICY IF EXISTS session_transcripts_staff_all ON public.session_transcripts;
  DROP POLICY IF EXISTS session_transcripts_staff_select ON public.session_transcripts;
  DROP POLICY IF EXISTS session_transcripts_staff_delete ON public.session_transcripts;

  CREATE POLICY session_transcripts_staff_select
    ON public.session_transcripts FOR SELECT TO authenticated
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
    );

  -- DELETE: el staff puede borrar la transcripción (p. ej. re-traer desde
  -- cero o quitar una por privacidad). NO hay INSERT/UPDATE: escribe el edge.
  CREATE POLICY session_transcripts_staff_delete
    ON public.session_transcripts FOR DELETE TO authenticated
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
    );
END $$;

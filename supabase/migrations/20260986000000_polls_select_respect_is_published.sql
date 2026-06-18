-- ════════════════════════════════════════════════════════════════════
-- Fix: la RLS de `polls` filtra borradores para alumnos.
--
-- Regresión introducida en mig 20260932000000 (polls_admin_tenant_scoping):
-- al refactorizar el SELECT para usar `_poll_has_member` (helper que cubre
-- docente Y alumno de cualquier curso linkeado), se perdió la condición
-- `is_published = TRUE` que tenía la policy previa (mig 20260603040000).
-- Resultado: los alumnos ven los borradores de sus cursos.
--
-- Esta migración reescribe SOLO la policy SELECT de `polls`:
--   • Docente del curso linkeado → ve drafts y publicadas
--     (helper existente `_poll_linked_teacher`, teacher-only).
--   • Alumno matriculado en algún curso linkeado → solo si
--     `is_published = TRUE`. Inline EXISTS para mantenerlo explícito
--     (sin crear más helpers — el patrón previo ya inlineaba).
--   • Admin del tenant / SuperAdmin → ven todo
--     (helper existente `_poll_admin_in_tenant`).
--
-- NO toca:
--   • `_poll_has_member` — otras tablas (poll_options, poll_responses,
--     poll_questions, etc.) lo usan; cambiarlo arrastra blast radius.
--   • Las RPCs (vote_poll_option, submit_poll_question_response, etc.)
--     que ya validan `is_published` server-side y rechazan votos en
--     borradores con su propio RAISE.
--   • La policy WRITE de polls (docente del curso ancla / Admin) —
--     publicar / despublicar sigue funcionando igual.
--
-- Defensive: el bloque DO valida que la tabla exista (idempotente +
-- soporta entornos en los que la mig 20260720000000 no haya corrido).
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.polls') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS polls_select_course_members ON public.polls';
  EXECUTE $P$
    CREATE POLICY polls_select_course_members ON public.polls
      FOR SELECT TO authenticated
      USING (
        -- Docente del curso ancla o de cualquier curso linkeado:
        -- ve TODAS las encuestas (drafts incluidos) para gestión.
        public._poll_linked_teacher(polls.id, auth.uid())
        -- Alumno: matriculado en algún curso linkeado Y la encuesta
        -- está publicada. El gate is_published cierra el bug que esta
        -- migración arregla.
        OR (
          polls.is_published = TRUE
          AND EXISTS (
            SELECT 1 FROM public.poll_courses pc
             JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
             WHERE pc.poll_id = polls.id AND ce.user_id = auth.uid()
          )
        )
        -- Admin del tenant del poll o SuperAdmin: ven todo.
        OR public._poll_admin_in_tenant(polls.id, auth.uid())
      )
  $P$;
END $$;

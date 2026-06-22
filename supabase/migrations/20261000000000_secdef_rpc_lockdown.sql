-- ============================================================================
-- Lockdown de RPCs SECURITY DEFINER expuestas a anon/authenticated (round 8).
--
-- Auditoría de las 257 funciones SECURITY DEFINER de public: varias funciones
-- de la COLA de calificación IA + helpers internos estaban EXECUTE-ables por
-- `anon` Y `authenticated` (la anon key es PÚBLICA, va en el bundle). Vía
-- PostgREST `/rest/v1/rpc/<fn>` cualquiera podía invocarlas:
--   🔴 complete_ai_grading / claim_pending_ai_grading / claim_one_ai_grading:
--      marcar jobs como done/processing, manipular el estado de grading.
--   🔴 cancel_pending_ai_jobs_for_submission: CANCELAR la calificación de
--      CUALQUIER entrega (DoS cross-tenant) — sin ningún chequeo de dueño.
--   🟠 _recompute_project_submission_grade / _notify_poll_students: recompute de
--      nota / inyección de notificaciones a alumnos, cross-tenant.
--   🟠 list_recent_ai_executions / list_failed_ai_gradings / course_pending_
--      grading_count / count_ai_errors_last_hour / resolve_certificate_settings:
--      LECTURA cross-tenant de metadata (incl. anon).
--
-- Fix:
--   (1) Las invocadas SOLO por edges (service_role) o triggers → REVOKE de
--       anon+authenticated (service_role/postgres conservan acceso → no rompe
--       el worker ni los triggers).
--   (2) cancel_pending_ai_jobs_for_submission la llama el ALUMNO al reabrir su
--       entrega → se agrega guard de autorización (dueño O staff del curso O
--       sistema) y se revoca anon. Su helper genérico by_target → revoke users.
--   (3) Lecturas + release_stuck (las usa la UI Admin/Docente) → REVOKE anon
--       (cierra el vector NO autenticado; el residual authenticated-cross-tenant
--       de metadata queda anotado como follow-up de menor severidad).
-- ============================================================================

-- (1) Worker / triggers — solo service_role + postgres.
REVOKE EXECUTE ON FUNCTION public.complete_ai_grading(uuid, boolean, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_pending_ai_grading(integer) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_one_ai_grading(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._recompute_project_submission_grade(uuid) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public._notify_poll_students(uuid, text, text, text, text) FROM anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cancel_pending_ai_jobs_by_target(text, uuid, text) FROM anon, authenticated;

-- (2) cancel_pending_ai_jobs_for_submission: guard de autorización + revoke anon.
--     Lo invoca el alumno (RPC) al reabrir su entrega de EXAMEN. Antes NO validaba
--     dueño → cualquiera cancelaba la calificación de cualquier entrega.
CREATE OR REPLACE FUNCTION public.cancel_pending_ai_jobs_for_submission(_submission_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- auth.uid() NULL = contexto sistema/trigger → se permite. Usuario real:
  -- debe ser dueño de la entrega, docente del curso del examen, o admin del
  -- tenant del curso.
  IF auth.uid() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.submissions s
     WHERE s.id = _submission_id
       AND (
         s.user_id = auth.uid()
         OR EXISTS (SELECT 1 FROM public.exams e JOIN public.course_teachers ct ON ct.course_id = e.course_id
                     WHERE e.id = s.exam_id AND ct.user_id = auth.uid())
         OR EXISTS (SELECT 1 FROM public.exams e
                     WHERE e.id = s.exam_id AND public.is_admin_of_course_tenant(e.course_id))
       )
  ) THEN
    RAISE EXCEPTION 'No autorizado para cancelar la calificación de esta entrega' USING ERRCODE = '42501';
  END IF;
  RETURN public.cancel_pending_ai_jobs_by_target(
    'submissions', _submission_id,
    'Cancelado: alumno reabrió la entrega para editar antes de re-entregar'
  );
END $$;
REVOKE EXECUTE ON FUNCTION public.cancel_pending_ai_jobs_for_submission(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.cancel_pending_ai_jobs_for_submission(uuid) TO authenticated;

-- (3) Lecturas + release (las usa la UI Admin/Docente autenticada + cron) →
--     cerrar al menos el vector anon (no autenticado).
REVOKE EXECUTE ON FUNCTION public.release_stuck_processing_jobs(integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.list_recent_ai_executions(integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.list_failed_ai_gradings(integer, integer) FROM anon;
REVOKE EXECUTE ON FUNCTION public.course_pending_grading_count(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.count_ai_errors_last_hour(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.resolve_certificate_settings(uuid) FROM anon;

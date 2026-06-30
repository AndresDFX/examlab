-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase 4, loop-until-dry) — RLS de tablas HIJAS / lecturas
-- no-staff que servían contenido de un PADRE en papelera vía REST directo.
--
-- El filtro de UI (.is(deleted_at,null)) ocultaba estas filas en los flujos
-- normales, pero la RLS no las gateaba → un alumno podía leerlas por REST/PostgREST
-- directo con un id stale. Fugas (todas verificadas leyendo la policy vigente):
--   1. questions / 2. workshop_questions  → content + options (CLAVE de respuesta
--      de preguntas cerradas) + expected_rubric de un examen/taller en papelera.
--   3. whiteboards_select (rama alumno) / 4. whiteboard_pages_select (rama alumno)
--      → escena/dibujos de una pizarra compartida en papelera.
--   5. poll_options_select → opciones + responses_count de una encuesta en papelera.
--   6. polls_select_course_members (rama alumno) → header de encuesta en papelera.
--   7. session_code_snippets_select (rama alumno) → código de clase de una sesión
--      en papelera (code_shared no se resetea al borrar).
--   8. attendance_sessions_select_in_tenant → whiteboard_scene/meeting/recording de
--      una sesión en papelera, legible por cualquier miembro del tenant.
--
-- PRINCIPIO DEL FIX: gatear SOLO la ruta no-staff (alumno/miembro) con
-- `<padre>.deleted_at IS NULL`. El STAFF (owner / Docente / Admin / SuperAdmin del
-- tenant) conserva acceso a las filas en papelera — lo necesita la PAPELERA
-- (app.trash) para listarlas y restaurarlas. Cada tabla afectada ya tiene una
-- policy `*_staff_manage [ALL]` / `*_write_*` o ramas de staff inline que cubren
-- ese acceso; aquí solo se cierra la lectura del no-staff.
--
-- NO se mete deleted_at dentro de los helpers (exam_in_my_tenant, course_in_my_tenant,
-- _poll_has_member): los usan también rutas de escritura/gestión del staff que SÍ
-- deben ver trashed. El gate va en la policy, en la rama no-staff.
-- Policies recreadas verbatim (pg_get policies de prod) + el gate. Idempotente.
--
-- SUTILEZA RLS (importante): un check `NOT EXISTS(SELECT FROM polls WHERE
-- deleted_at IS NOT NULL)` dentro de una policy se evalúa BAJO la RLS de polls
-- del propio usuario. Al gatear polls_select para ocultar trashed al alumno (fix
-- #6 de acá), ese subquery deja de VER la poll en papelera → NOT EXISTS pasa a
-- TRUE → el guard FALLA ABIERTO. Las 3 policies de poll_* que usaban ese patrón
-- (poll_options nuevo, poll_questions + poll_question_responses ya existentes —
-- estos últimos solo "funcionaban" porque polls AÚN filtraba mal) se reescriben
-- con un helper SECURITY DEFINER `_poll_in_papelera` que lee deleted_at SIN RLS.
-- (Los checks POSITIVOS `EXISTS(... deleted_at IS NULL)` de whiteboards/sessions/
-- exams NO tienen este problema: el ocultamiento por RLS refuerza el deny.)
-- ══════════════════════════════════════════════════════════════════════

-- Helper RLS-inmune: ¿la encuesta está en la papelera? (bypassa RLS vía DEFINER)
CREATE OR REPLACE FUNCTION public._poll_in_papelera(_poll_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT EXISTS (SELECT 1 FROM public.polls WHERE id = _poll_id AND deleted_at IS NOT NULL);
$fn$;
REVOKE ALL ON FUNCTION public._poll_in_papelera(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public._poll_in_papelera(uuid) TO authenticated;

-- ── 1) questions (hija de exams; staff cubierto por questions_staff_manage [ALL]) ──
DROP POLICY IF EXISTS questions_select_in_tenant ON public.questions;
CREATE POLICY questions_select_in_tenant ON public.questions
  FOR SELECT TO authenticated
  USING (
    public.exam_in_my_tenant(exam_id)
    AND EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = questions.exam_id AND e.deleted_at IS NULL
    )
  );

-- ── 2) workshop_questions (staff cubierto por workshop_questions_staff_manage [ALL]) ──
DROP POLICY IF EXISTS workshop_questions_select_in_tenant ON public.workshop_questions;
CREATE POLICY workshop_questions_select_in_tenant ON public.workshop_questions
  FOR SELECT TO authenticated
  USING (
    public.workshop_in_my_tenant(workshop_id)
    AND EXISTS (
      SELECT 1 FROM public.workshops w
      WHERE w.id = workshop_questions.workshop_id AND w.deleted_at IS NULL
    )
  );

-- ── 3) whiteboards (entidad papelera; gate SOLO la rama alumno is_shared_with_course) ──
DROP POLICY IF EXISTS whiteboards_select ON public.whiteboards;
CREATE POLICY whiteboards_select ON public.whiteboards
  FOR SELECT TO authenticated
  USING (
    (owner_id = auth.uid())
    OR public.is_super_admin()
    OR ((public.has_role(auth.uid(), 'Admin'::public.app_role) OR public.has_role(auth.uid(), 'Docente'::public.app_role)) AND (tenant_id = public.current_tenant_id()))
    OR ((course_id IS NOT NULL) AND (EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = whiteboards.course_id AND ct.user_id = auth.uid()
    )))
    OR ((is_shared_with_course = true) AND (course_id IS NOT NULL) AND (deleted_at IS NULL) AND (EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = whiteboards.course_id AND ce.user_id = auth.uid()
    )))
  );

-- ── 4) whiteboard_pages (gate SOLO la sub-rama alumno is_shared_with_course) ──
DROP POLICY IF EXISTS whiteboard_pages_select ON public.whiteboard_pages;
CREATE POLICY whiteboard_pages_select ON public.whiteboard_pages
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.whiteboards w
    WHERE w.id = whiteboard_pages.whiteboard_id
      AND (
        (w.owner_id = auth.uid())
        OR public.is_super_admin()
        OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND (w.tenant_id = public.current_tenant_id()))
        OR ((w.is_shared_with_course = true) AND (w.course_id IS NOT NULL) AND (w.deleted_at IS NULL) AND (EXISTS (
          SELECT 1 FROM public.course_enrollments ce
          WHERE ce.course_id = w.course_id AND ce.user_id = auth.uid()
        )))
      )
  ));

-- ── 5) poll_options (gate vía helper RLS-inmune; staff lee trashed por poll_options_write_teacher [ALL]) ──
DROP POLICY IF EXISTS poll_options_select ON public.poll_options;
CREATE POLICY poll_options_select ON public.poll_options
  FOR SELECT TO authenticated
  USING (
    (public._poll_has_member(poll_id, auth.uid()) OR public._poll_admin_in_tenant(poll_id, auth.uid()))
    AND NOT public._poll_in_papelera(poll_id)
  );

-- ── 5b) poll_questions + poll_question_responses: MISMO patrón frágil ya existente.
-- Solo "funcionaban" porque polls_select aún mostraba trashed al alumno; al
-- gatear polls (fix #6) hay que migrarlas al helper o pasan a fallar abiertas. ──
DROP POLICY IF EXISTS poll_questions_select ON public.poll_questions;
CREATE POLICY poll_questions_select ON public.poll_questions
  FOR SELECT TO authenticated
  USING (
    (public._poll_has_member(poll_id, auth.uid()) OR public._poll_admin_in_tenant(poll_id, auth.uid()))
    AND NOT public._poll_in_papelera(poll_id)
  );

DROP POLICY IF EXISTS pqr_select ON public.poll_question_responses;
CREATE POLICY pqr_select ON public.poll_question_responses
  FOR SELECT TO authenticated
  USING (
    (
      (user_id = auth.uid())
      OR public._poll_linked_teacher(poll_id, auth.uid())
      OR public._poll_admin_in_tenant(poll_id, auth.uid())
    )
    AND NOT public._poll_in_papelera(poll_id)
  );

-- ── 6) polls (entidad papelera; gate SOLO la rama alumno is_published+matrícula) ──
DROP POLICY IF EXISTS polls_select_course_members ON public.polls;
CREATE POLICY polls_select_course_members ON public.polls
  FOR SELECT TO authenticated
  USING (
    public._poll_linked_teacher(id, auth.uid())
    OR (
      (is_published = true)
      AND (deleted_at IS NULL)
      AND (EXISTS (
        SELECT 1 FROM public.poll_courses pc
        JOIN public.course_enrollments ce ON ce.course_id = pc.course_id
        WHERE pc.poll_id = polls.id AND ce.user_id = auth.uid()
      ))
    )
    OR public._poll_admin_in_tenant(id, auth.uid())
  );

-- ── 7) session_code_snippets (gate SOLO la sub-rama alumno code_shared) ──
DROP POLICY IF EXISTS session_code_snippets_select ON public.session_code_snippets;
CREATE POLICY session_code_snippets_select ON public.session_code_snippets
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.attendance_sessions s
    WHERE s.id = session_code_snippets.session_id
      AND (
        public.has_role(auth.uid(), 'Admin'::public.app_role)
        OR public.is_super_admin()
        OR (EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = s.course_id AND ct.user_id = auth.uid()
        ))
        OR ((COALESCE(s.code_shared, false) = true) AND (s.deleted_at IS NULL) AND (EXISTS (
          SELECT 1 FROM public.course_enrollments ce
          WHERE ce.course_id = s.course_id AND ce.user_id = auth.uid()
        )))
      )
  ));

-- ── 8) attendance_sessions (entidad papelera; staff sigue viendo trashed para la Papelera) ──
DROP POLICY IF EXISTS attendance_sessions_select_in_tenant ON public.attendance_sessions;
CREATE POLICY attendance_sessions_select_in_tenant ON public.attendance_sessions
  FOR SELECT TO authenticated
  USING (
    public.course_in_my_tenant(course_id)
    AND (
      deleted_at IS NULL
      OR public.has_role(auth.uid(), 'Docente'::public.app_role)
      OR public.has_role(auth.uid(), 'Admin'::public.app_role)
      OR public.is_super_admin()
    )
  );

NOTIFY pgrst, 'reload schema';

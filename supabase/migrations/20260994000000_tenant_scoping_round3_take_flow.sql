-- ============================================================================
-- Tenant scoping round 3 — cierre de leaks cross-tenant en tablas hijas
-- detectados por la auditoría de Exámenes + Talleres (2026-06).
--
-- Anti-patrón que cierra (ver CLAUDE.md "has_role() en una policy SIN scope de
-- tenant = leak cross-tenant"): toda rama `OR has_role('Docente'/'Admin')` sin
-- combinar con el tenant del curso deja que un staff de CUALQUIER institución
-- lea/edite la fila por REST directo. Cada rama de rol se ata ahora al tenant.
--
-- Tablas tratadas:
--   1. workshop_submission_answers — leak de respuestas (PII) cross-tenant +
--      BUG de pérdida de datos: faltaba la rama de miembro de grupo, así que un
--      compañero del grupo NO podía editar la entrega compartida.
--   2. workshop_assignments       — asignaciones de taller, rama has_role global.
--   3. exam_timer_controls        — control de tiempo por examen, write global.
--   4. code_executions            — ejecuciones de código (polimórfica), global.
--   5. ai_grading_queue (SELECT)  — rama Admin global → admin del tenant del curso.
--
-- Todas las ramas de staff se reescriben atando al tenant del curso vía los
-- helpers existentes (`is_admin_of_course_tenant`, que ya incluye SA, y los
-- joins a `course_teachers`). Defensivo con to_regclass por si la tabla no
-- existe en el entorno (modelo Lovable: Publish puede marcar migs como
-- aplicadas sin que el CREATE TABLE haya corrido).
-- ============================================================================

-- ───────────────────────────────────────────────────────────────────────────
-- 1. workshop_submission_answers
--    Predicado de acceso (mirror de workshop_submissions, mig 20260820):
--      dueño de la entrega
--      OR miembro del grupo de la entrega          (← FIX pérdida de datos)
--      OR docente del curso del taller              (course_teachers, tenant-scoped)
--      OR admin del tenant del curso                (is_admin_of_course_tenant → incl. SA)
--    DELETE queda solo-staff (igual que el original), pero scopeado.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.workshop_submission_answers') IS NULL THEN
    RAISE NOTICE 'workshop_submission_answers no existe; skip';
    RETURN;
  END IF;

  -- Drop de TODAS las policies actuales (nombres originales + variantes SA)
  EXECUTE 'DROP POLICY IF EXISTS "Users see own workshop answers" ON public.workshop_submission_answers';
  EXECUTE 'DROP POLICY IF EXISTS "Users insert own workshop answers" ON public.workshop_submission_answers';
  EXECUTE 'DROP POLICY IF EXISTS "Users update own workshop answers" ON public.workshop_submission_answers';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins delete workshop answers" ON public.workshop_submission_answers';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_submission_answers_select" ON public.workshop_submission_answers';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_submission_answers_insert" ON public.workshop_submission_answers';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_submission_answers_update" ON public.workshop_submission_answers';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_submission_answers_delete" ON public.workshop_submission_answers';

  EXECUTE $POLICY$
    CREATE POLICY "workshop_submission_answers_select"
      ON public.workshop_submission_answers FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.workshop_submissions ws
          WHERE ws.id = workshop_submission_answers.submission_id
            AND (
              ws.user_id = auth.uid()
              OR (ws.group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.workshop_group_members m
                WHERE m.group_id = ws.group_id AND m.user_id = auth.uid()
              ))
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                JOIN public.course_teachers ct ON ct.course_id = w.course_id
                WHERE w.id = ws.workshop_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                WHERE w.id = ws.workshop_id
                  AND public.is_admin_of_course_tenant(w.course_id)
              )
            )
        )
      )
  $POLICY$;

  EXECUTE $POLICY$
    CREATE POLICY "workshop_submission_answers_insert"
      ON public.workshop_submission_answers FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.workshop_submissions ws
          WHERE ws.id = workshop_submission_answers.submission_id
            AND (
              ws.user_id = auth.uid()
              OR (ws.group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.workshop_group_members m
                WHERE m.group_id = ws.group_id AND m.user_id = auth.uid()
              ))
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                JOIN public.course_teachers ct ON ct.course_id = w.course_id
                WHERE w.id = ws.workshop_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                WHERE w.id = ws.workshop_id
                  AND public.is_admin_of_course_tenant(w.course_id)
              )
            )
        )
      )
  $POLICY$;

  EXECUTE $POLICY$
    CREATE POLICY "workshop_submission_answers_update"
      ON public.workshop_submission_answers FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.workshop_submissions ws
          WHERE ws.id = workshop_submission_answers.submission_id
            AND (
              ws.user_id = auth.uid()
              OR (ws.group_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.workshop_group_members m
                WHERE m.group_id = ws.group_id AND m.user_id = auth.uid()
              ))
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                JOIN public.course_teachers ct ON ct.course_id = w.course_id
                WHERE w.id = ws.workshop_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                WHERE w.id = ws.workshop_id
                  AND public.is_admin_of_course_tenant(w.course_id)
              )
            )
        )
      )
  $POLICY$;

  EXECUTE $POLICY$
    CREATE POLICY "workshop_submission_answers_delete"
      ON public.workshop_submission_answers FOR DELETE TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.workshop_submissions ws
          WHERE ws.id = workshop_submission_answers.submission_id
            AND (
              EXISTS (
                SELECT 1 FROM public.workshops w
                JOIN public.course_teachers ct ON ct.course_id = w.course_id
                WHERE w.id = ws.workshop_id AND ct.user_id = auth.uid()
              )
              OR EXISTS (
                SELECT 1 FROM public.workshops w
                WHERE w.id = ws.workshop_id
                  AND public.is_admin_of_course_tenant(w.course_id)
              )
            )
        )
      )
  $POLICY$;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 2. workshop_assignments
--    SELECT: dueño OR (taller en mi tenant AND staff)
--    WRITE : taller en mi tenant AND staff
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.workshop_assignments') IS NULL THEN
    RAISE NOTICE 'workshop_assignments no existe; skip';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "Users see own workshop assignments" ON public.workshop_assignments';
  EXECUTE 'DROP POLICY IF EXISTS "Docentes/Admins manage workshop assignments" ON public.workshop_assignments';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_assignments_select" ON public.workshop_assignments';
  EXECUTE 'DROP POLICY IF EXISTS "workshop_assignments_write" ON public.workshop_assignments';

  EXECUTE $POLICY$
    CREATE POLICY "workshop_assignments_select"
      ON public.workshop_assignments FOR SELECT TO authenticated
      USING (
        auth.uid() = user_id
        OR (
          public.workshop_in_my_tenant(workshop_id)
          AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
        )
      )
  $POLICY$;

  EXECUTE $POLICY$
    CREATE POLICY "workshop_assignments_write"
      ON public.workshop_assignments FOR ALL TO authenticated
      USING (
        public.workshop_in_my_tenant(workshop_id)
        AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
      )
      WITH CHECK (
        public.workshop_in_my_tenant(workshop_id)
        AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
      )
  $POLICY$;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 3. exam_timer_controls
--    SELECT (estudiante ve los suyos / globales) ya estaba OK; solo el WRITE
--    estaba con has_role global. Lo atamos al tenant del examen.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.exam_timer_controls') IS NULL THEN
    RAISE NOTICE 'exam_timer_controls no existe; skip';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "Teachers/Admins manage timer controls" ON public.exam_timer_controls';
  EXECUTE 'DROP POLICY IF EXISTS "exam_timer_controls_write" ON public.exam_timer_controls';

  EXECUTE $POLICY$
    CREATE POLICY "exam_timer_controls_write"
      ON public.exam_timer_controls FOR ALL TO authenticated
      USING (
        public.exam_in_my_tenant(exam_id)
        AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
      )
      WITH CHECK (
        public.exam_in_my_tenant(exam_id)
        AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
      )
  $POLICY$;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 4. code_executions (POLIMÓRFICA — submission_id NULLABLE para snippets/contenido)
--    SELECT: dueño OR (submission_id NOT NULL AND staff del curso del examen de
--            esa submission). Para submission_id NULL (snippet/contenido) solo el
--            dueño (no hay vista cross-user de staff en ese caso).
--    WRITE : dueño (INSERT propio) — el staff no escribe ejecuciones ajenas.
--            Mantenemos INSERT propio + cerramos el FOR ALL has_role global.
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.code_executions') IS NULL THEN
    RAISE NOTICE 'code_executions no existe; skip';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "Users see own code executions" ON public.code_executions';
  EXECUTE 'DROP POLICY IF EXISTS "Teachers/Admins manage code executions" ON public.code_executions';
  EXECUTE 'DROP POLICY IF EXISTS "Users insert own code executions" ON public.code_executions';
  EXECUTE 'DROP POLICY IF EXISTS "code_executions_select" ON public.code_executions';
  EXECUTE 'DROP POLICY IF EXISTS "code_executions_insert" ON public.code_executions';

  EXECUTE $POLICY$
    CREATE POLICY "code_executions_select"
      ON public.code_executions FOR SELECT TO authenticated
      USING (
        auth.uid() = user_id
        OR (
          submission_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.submissions s
            JOIN public.exams e ON e.id = s.exam_id
            WHERE s.id = code_executions.submission_id
              AND (
                EXISTS (
                  SELECT 1 FROM public.course_teachers ct
                  WHERE ct.course_id = e.course_id AND ct.user_id = auth.uid()
                )
                OR public.is_admin_of_course_tenant(e.course_id)
              )
          )
        )
      )
  $POLICY$;

  EXECUTE $POLICY$
    CREATE POLICY "code_executions_insert"
      ON public.code_executions FOR INSERT TO authenticated
      WITH CHECK (auth.uid() = user_id)
  $POLICY$;
END $$;

-- ───────────────────────────────────────────────────────────────────────────
-- 5. ai_grading_queue — SELECT: la rama Admin global → admin del tenant del curso
--    (las otras ramas creador / docente del curso ya estaban scopeadas).
-- ───────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.ai_grading_queue') IS NULL THEN
    RAISE NOTICE 'ai_grading_queue no existe; skip';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "ai_grading_queue_select" ON public.ai_grading_queue';

  EXECUTE $POLICY$
    CREATE POLICY "ai_grading_queue_select"
      ON public.ai_grading_queue FOR SELECT TO authenticated
      USING (
        created_by = auth.uid()
        OR (course_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = ai_grading_queue.course_id AND ct.user_id = auth.uid()
        ))
        OR (course_id IS NOT NULL AND public.is_admin_of_course_tenant(ai_grading_queue.course_id))
        OR public.is_super_admin()
      )
  $POLICY$;
END $$;

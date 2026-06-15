-- ══════════════════════════════════════════════════════════════════════
-- Auditoría funcional #39 — correcciones de seguridad y correctitud.
--
-- Agrupa los fixes SQL confirmados por la auditoría (los de código van por
-- separado en el commit). Cada bloque envuelve sus objetos en guards
-- to_regclass por si la tabla no existe en el entorno del usuario (Lovable).
--
--   #1/#25  REVOKE de course_pending_grading_count (fuga cross-tenant de un
--           conteo: SECURITY DEFINER + GRANT authenticated SIN authz interna).
--   #16     get_course_cohort_weights NO excluía items en DRAFT → el tablero
--           del estudiante mostraba actividades/% aún no publicadas.
--   #21/#27 El "Curso de pruebas" demo se sembró sin status → heredó
--           'borrador' (default de 20260964) y queda oculto bajo el filtro
--           por defecto 'en_curso' del grid. Lo pasamos a 'en_curso'.
--   #3      content_course_assignments: políticas WRITE/SELECT con has_role
--           SIN scope de tenant (anti-patrón) → un Admin de otro tenant podía
--           asociar material a un curso ajeno. Scopear con course_in_my_tenant.
--   #4      workshop_courses: la política tenant-scoped de 20260528 nunca se
--           aplicó (la tabla se creó 94 migraciones después, en 20260704), así
--           que quedó viva la WRITE bare-has_role → leak cross-tenant de
--           binding taller↔curso (+ weight/cut). Re-aplicar el scope.
-- ══════════════════════════════════════════════════════════════════════

-- ── #1/#25: quitar exposición pública del conteo de pendientes ──
-- Los llamadores internos (set_course_status, auto_finalize_courses) son
-- SECURITY DEFINER y corren como el owner, así que conservan EXECUTE aunque
-- 'authenticated' lo pierda. Ningún cliente lo invoca directamente.
DO $mig$
BEGIN
  IF to_regprocedure('public.course_pending_grading_count(uuid)') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.course_pending_grading_count(uuid) FROM authenticated;
    REVOKE EXECUTE ON FUNCTION public.course_pending_grading_count(uuid) FROM PUBLIC;
  END IF;
END
$mig$;

-- ── #16: excluir DRAFT del desglose por cohorte del tablero estudiantil ──
DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL
     OR to_regclass('public.profiles') IS NULL
     OR to_regclass('public.exams') IS NULL
     OR to_regclass('public.workshops') IS NULL
     OR to_regclass('public.workshop_courses') IS NULL
     OR to_regclass('public.projects') IS NULL
     OR to_regclass('public.project_courses') IS NULL
     OR to_regclass('public.exam_assignments') IS NULL
     OR to_regclass('public.workshop_assignments') IS NULL
     OR to_regclass('public.project_assignments') IS NULL
     OR to_regclass('public.grade_cuts') IS NULL THEN
    RAISE NOTICE 'skip get_course_cohort_weights: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.get_course_cohort_weights(_course_id uuid)
  RETURNS TABLE (
    cohorte text,
    kind text,
    item_id uuid,
    title text,
    weight numeric,
    cut_name text,
    cut_position integer
  )
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
  STABLE
  AS $fn$
    WITH authz AS (
      SELECT 1
       WHERE EXISTS (SELECT 1 FROM public.course_enrollments ce
                      WHERE ce.course_id = _course_id AND ce.user_id = auth.uid())
          OR EXISTS (SELECT 1 FROM public.course_teachers ct
                      WHERE ct.course_id = _course_id AND ct.user_id = auth.uid())
          OR public.is_super_admin()
          OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(_course_id))
    ),
    cohorts AS (
      SELECT DISTINCT btrim(p.cohorte) AS cohorte
        FROM public.course_enrollments ce
        JOIN public.profiles p ON p.id = ce.user_id
       WHERE ce.course_id = _course_id
         AND p.cohorte IS NOT NULL AND btrim(p.cohorte) <> ''
    ),
    items AS (
      -- DRAFT excluido: las filas de *_assignments existen apenas se crea la
      -- actividad (incluso en borrador), así que sin este filtro un examen/
      -- taller/proyecto sin publicar aparecía en el tablero del estudiante.
      SELECT 'exam'::text AS kind, e.id AS item_id, e.title,
             COALESCE(e.weight, 0)::numeric AS weight, e.cut_id
        FROM public.exams e
       WHERE e.course_id = _course_id AND e.deleted_at IS NULL AND e.parent_exam_id IS NULL
         AND COALESCE(e.status, 'published') <> 'draft'
      UNION ALL
      SELECT 'workshop'::text, w.id, w.title,
             COALESCE(wc.weight, w.weight, 0)::numeric, wc.cut_id
        FROM public.workshop_courses wc
        JOIN public.workshops w ON w.id = wc.workshop_id
       WHERE wc.course_id = _course_id AND w.deleted_at IS NULL
         AND COALESCE(w.status, 'published') <> 'draft'
      UNION ALL
      SELECT 'project'::text, pr.id, pr.title,
             COALESCE(pc.weight, pr.weight, 0)::numeric, pc.cut_id
        FROM public.project_courses pc
        JOIN public.projects pr ON pr.id = pc.project_id
       WHERE pc.course_id = _course_id AND pr.deleted_at IS NULL
         AND COALESCE(pr.status, 'published') <> 'draft'
    )
    SELECT co.cohorte, i.kind, i.item_id, i.title, i.weight,
           gc.name AS cut_name, gc.position AS cut_position
      FROM authz
      CROSS JOIN cohorts co
      CROSS JOIN items i
      LEFT JOIN public.grade_cuts gc ON gc.id = i.cut_id
     WHERE EXISTS (
       SELECT 1
         FROM public.course_enrollments ce
         JOIN public.profiles p ON p.id = ce.user_id
        WHERE ce.course_id = _course_id
          AND btrim(p.cohorte) = co.cohorte
          AND (
            (i.kind = 'exam'     AND EXISTS (SELECT 1 FROM public.exam_assignments ea     WHERE ea.exam_id = i.item_id     AND ea.user_id = ce.user_id))
            OR (i.kind = 'workshop' AND EXISTS (SELECT 1 FROM public.workshop_assignments wa WHERE wa.workshop_id = i.item_id AND wa.user_id = ce.user_id))
            OR (i.kind = 'project'  AND EXISTS (SELECT 1 FROM public.project_assignments pa  WHERE pa.project_id = i.item_id  AND pa.user_id = ce.user_id))
          )
     )
     ORDER BY co.cohorte, gc.position NULLS LAST, i.title
  $fn$;

  GRANT EXECUTE ON FUNCTION public.get_course_cohort_weights(uuid) TO authenticated;
END
$mig$;

-- ── #21/#27: hacer visible el "Curso de pruebas" demo (status 'en_curso') ──
DO $mig$
DECLARE
  v_tenant uuid := '729b3114-bf5d-4433-ac0e-d1e3aedb1358'; -- ExamLab Demo
BEGIN
  IF to_regclass('public.courses') IS NULL THEN
    RAISE NOTICE 'skip demo course status fix: courses ausente';
    RETURN;
  END IF;
  -- Solo si la columna status existe (la agregó 20260964).
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'status'
  ) THEN
    UPDATE public.courses
       SET status = 'en_curso'
     WHERE tenant_id = v_tenant
       AND name = 'Curso de pruebas'
       AND deleted_at IS NULL
       AND COALESCE(status, 'borrador') = 'borrador';
  END IF;
END
$mig$;

-- ── #3: content_course_assignments — scopear políticas al tenant del curso ──
DO $mig$
BEGIN
  IF to_regclass('public.content_course_assignments') IS NULL THEN
    RAISE NOTICE 'skip cca tenant scoping: tabla ausente';
    RETURN;
  END IF;

  -- SELECT: docente del curso, Admin (de su tenant), SuperAdmin o estudiante
  -- enrollado — todos acotados al tenant del curso vía course_in_my_tenant
  -- (que ya cubre is_super_admin globalmente).
  DROP POLICY IF EXISTS "cca_select" ON public.content_course_assignments;
  CREATE POLICY "cca_select" ON public.content_course_assignments
    FOR SELECT
    USING (
      public.course_in_my_tenant(content_course_assignments.course_id)
      AND (
        public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = content_course_assignments.course_id
             AND ct.user_id = auth.uid()
        )
        OR EXISTS (
          SELECT 1 FROM public.course_enrollments ce
           WHERE ce.course_id = content_course_assignments.course_id
             AND ce.user_id = auth.uid()
        )
      )
    );

  DROP POLICY IF EXISTS "cca_insert" ON public.content_course_assignments;
  CREATE POLICY "cca_insert" ON public.content_course_assignments
    FOR INSERT
    WITH CHECK (
      (created_by IS NULL OR created_by = auth.uid())
      AND public.course_in_my_tenant(content_course_assignments.course_id)
      AND (
        public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = content_course_assignments.course_id
             AND ct.user_id = auth.uid()
        )
      )
    );

  DROP POLICY IF EXISTS "cca_update" ON public.content_course_assignments;
  CREATE POLICY "cca_update" ON public.content_course_assignments
    FOR UPDATE
    USING (
      public.course_in_my_tenant(content_course_assignments.course_id)
      AND (
        public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = content_course_assignments.course_id
             AND ct.user_id = auth.uid()
        )
      )
    );

  DROP POLICY IF EXISTS "cca_delete" ON public.content_course_assignments;
  CREATE POLICY "cca_delete" ON public.content_course_assignments
    FOR DELETE
    USING (
      public.course_in_my_tenant(content_course_assignments.course_id)
      AND (
        public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
        OR EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = content_course_assignments.course_id
             AND ct.user_id = auth.uid()
        )
      )
    );
END
$mig$;

-- ── #4: workshop_courses — re-aplicar el scope de tenant (20260528 no-op) ──
DO $mig$
BEGIN
  IF to_regclass('public.workshop_courses') IS NULL THEN
    RAISE NOTICE 'skip workshop_courses tenant scoping: tabla ausente';
    RETURN;
  END IF;

  -- Quitar las políticas sueltas de 20260704.
  DROP POLICY IF EXISTS "workshop_courses_view_all_authenticated" ON public.workshop_courses;
  DROP POLICY IF EXISTS "workshop_courses_manage_teachers_admins" ON public.workshop_courses;

  -- SELECT: cualquier usuario del MISMO tenant del curso (estudiante enrollado,
  -- docente, Admin) o SuperAdmin. course_in_my_tenant cubre el SA.
  DROP POLICY IF EXISTS "workshop_courses_select_in_tenant" ON public.workshop_courses;
  CREATE POLICY "workshop_courses_select_in_tenant"
    ON public.workshop_courses FOR SELECT TO authenticated
    USING (public.course_in_my_tenant(course_id));

  -- WRITE: Docente/Admin del tenant del curso (o SA).
  DROP POLICY IF EXISTS "workshop_courses_staff_manage" ON public.workshop_courses;
  CREATE POLICY "workshop_courses_staff_manage"
    ON public.workshop_courses FOR ALL TO authenticated
    USING (
      public.course_in_my_tenant(course_id)
      AND (
        public.has_role(auth.uid(), 'Docente')
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
    )
    WITH CHECK (
      public.course_in_my_tenant(course_id)
      AND (
        public.has_role(auth.uid(), 'Docente')
        OR public.has_role(auth.uid(), 'Admin')
        OR public.is_super_admin()
      )
    );
END
$mig$;

NOTIFY pgrst, 'reload schema';

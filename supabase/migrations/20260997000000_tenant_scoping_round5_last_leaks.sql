-- ============================================================================
-- Tenant scoping round 5 — últimos leaks cross-tenant del barrido de pg_policies.
--
-- 1) grade_cut_items.cut_items_admin_all [ALL]: rama Admin GLOBAL (has_role
--    'Admin' sin scope) → un Admin de cualquier tenant podía leer/editar los
--    items de corte de otro tenant. Las otras dos policies (docente del curso,
--    estudiante matriculado) YA estaban scopeadas vía grade_cuts→course. Se
--    ata la rama Admin a is_admin_of_course_tenant(grade_cuts.course_id) (que
--    incluye SuperAdmin).
--
-- 2) project_submission_files: SELECT y UPDATE ya estaban protegidos (su
--    has_role vive DENTRO de un EXISTS sobre project_submissions, que la RLS
--    filtra por tenant — verificado empíricamente: un Docente de otro tenant
--    ve 0/52). Pero:
--      - INSERT: el `OR has_role(...)` estaba al TOP LEVEL (fuera del EXISTS)
--        → un staff de otro tenant podía INSERTAR un file para una entrega
--        ajena. Se mueve el has_role DENTRO del EXISTS sobre project_submissions
--        (queda gated por su RLS, igual que SELECT/UPDATE).
--      - DELETE: predicado bare `has_role('Docente') OR has_role('Admin')` sin
--        join a project_submissions → un staff de otro tenant podía BORRAR files
--        ajenos. Se envuelve en el mismo EXISTS RLS-gated.
--
-- Defensivo con to_regclass. Cierra los últimos candidatos del scan de las 322
-- pg_policies (round 4 los dejó anotados). ai_override_codes queda fuera: es
-- global (sin tenant_id/course_id) — decisión de producto, no leak de datos.
-- ============================================================================

-- ── 1) grade_cut_items — rama Admin scopeada al tenant del curso del corte ──
DO $$ BEGIN
  IF to_regclass('public.grade_cut_items') IS NULL THEN RAISE NOTICE 'skip grade_cut_items'; RETURN; END IF;
  EXECUTE 'DROP POLICY IF EXISTS "cut_items_admin_all" ON public.grade_cut_items';
  EXECUTE $P$
    CREATE POLICY "cut_items_admin_all" ON public.grade_cut_items FOR ALL TO authenticated
    USING (
      EXISTS (SELECT 1 FROM public.grade_cuts gc
               WHERE gc.id = grade_cut_items.cut_id
                 AND public.is_admin_of_course_tenant(gc.course_id))
    )
    WITH CHECK (
      EXISTS (SELECT 1 FROM public.grade_cuts gc
               WHERE gc.id = grade_cut_items.cut_id
                 AND public.is_admin_of_course_tenant(gc.course_id))
    )
  $P$;
END $$;

-- ── 2) project_submission_files — INSERT + DELETE atados a la RLS de la entrega ──
DO $$ BEGIN
  IF to_regclass('public.project_submission_files') IS NULL THEN RAISE NOTICE 'skip project_submission_files'; RETURN; END IF;

  -- INSERT: dueño de la entrega O staff — pero el has_role va DENTRO del EXISTS
  -- sobre project_submissions (gated por su RLS tenant-scoped), no al top level.
  EXECUTE 'DROP POLICY IF EXISTS "project_sub_files_owner_or_staff_insert" ON public.project_submission_files';
  EXECUTE $P$
    CREATE POLICY "project_sub_files_owner_or_staff_insert" ON public.project_submission_files FOR INSERT TO authenticated
    WITH CHECK (
      EXISTS (
        SELECT 1 FROM public.project_submissions ps
         WHERE ps.id = project_submission_files.submission_id
           AND (
             ps.user_id = auth.uid()
             OR public.has_role(auth.uid(), 'Docente')
             OR public.has_role(auth.uid(), 'Admin')
           )
      )
    )
  $P$;

  -- DELETE: solo staff, pero gated por la RLS de la entrega (el EXISTS sobre
  -- project_submissions solo ve filas del tenant del caller).
  EXECUTE 'DROP POLICY IF EXISTS "project_sub_files_staff_delete" ON public.project_submission_files';
  EXECUTE $P$
    CREATE POLICY "project_sub_files_staff_delete" ON public.project_submission_files FOR DELETE TO authenticated
    USING (
      EXISTS (
        SELECT 1 FROM public.project_submissions ps
         WHERE ps.id = project_submission_files.submission_id
           AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
      )
    )
  $P$;
END $$;

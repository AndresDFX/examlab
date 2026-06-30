-- ══════════════════════════════════════════════════════════════════════
-- Auditoría papelera (pase 6) — project_files: el hermano que faltó.
--
-- project_files (hija de projects) guarda title + description (instrucciones) +
-- expected_rubric (CRITERIOS DE CALIFICACIÓN). Su policy SELECT
-- `project_files_select_in_tenant` = `project_in_my_tenant(project_id)` SIN gate
-- de deleted_at → un alumno del tenant lee por REST las instrucciones + la
-- rúbrica de un proyecto EN LA PAPELERA. Es el PARALELO EXACTO de questions
-- (hija de exams) y workshop_questions (hija de workshops), que el pase 4
-- (20261020) SÍ gateó — project_files quedó omitido.
--
-- Fix idéntico: gatear la rama no-staff con el padre activo; el staff sigue
-- cubierto por project_files_staff_manage [ALL] (ve trashed para la Papelera).
-- ALTER POLICY (preserva cmd/roles/permissive). Check POSITIVO `deleted_at IS
-- NULL` (RLS-safe: si la RLS de projects ocultara el trashed, refuerza el deny).
-- ══════════════════════════════════════════════════════════════════════

ALTER POLICY project_files_select_in_tenant ON public.project_files
  USING (
    public.project_in_my_tenant(project_id)
    AND EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = project_files.project_id AND p.deleted_at IS NULL
    )
  );

NOTIFY pgrst, 'reload schema';

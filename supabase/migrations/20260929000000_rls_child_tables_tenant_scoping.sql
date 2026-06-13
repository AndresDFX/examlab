-- ──────────────────────────────────────────────────────────────────────
-- Fix RLS: tablas HIJAS que quedaron con SELECT `USING (true)` (leak
-- cross-tenant) tras el endurecimiento de tenant (mig 20260528000000/010000).
--
-- Esas migraciones cerraron las tablas "madre" (courses/exams/workshops/
-- projects/attendance_sessions) pero NO todas sus hijas; y otras hijas se
-- crearon DESPUÉS con `USING (true)`. Resultado: cualquier usuario
-- autenticado de CUALQUIER institución podía leer por REST directo:
--   - `questions.options` (¡la respuesta correcta!) + `expected_rubric` de
--     TODOS los exámenes de la plataforma (CRÍTICO),
--   - `project_files` (entregables + rúbricas) de todos los proyectos,
--   - composición de grupos (`*_groups` / `*_group_members`, PII + signup_code),
--   - relación taller↔curso (`workshop_courses`) y URLs de intro videos.
--
-- Patrón de fix (idéntico al de exams/workshops/projects en 20260528000000):
-- el SELECT se scopea al tenant del CURSO del que cuelga la fila, vía helpers
-- SECURITY DEFINER que derivan el course_id por la FK del padre y reusan
-- `course_in_my_tenant` (que ya cubre `is_super_admin()`). El WRITE que estaba
-- en "solo rol" (Docente/Admin sin tenant) pasa a "curso de mi tenant + rol".
--
-- LÍMITE conocido (NO lo resuelve este fix): scopear `questions` al tenant NO
-- oculta la respuesta correcta a un alumno del MISMO curso — RLS filtra FILAS,
-- no columnas. Despojar `options.correct_index` para el alumno requiere una
-- RPC/vista server-side (cambio aparte). Este fix cierra el leak CROSS-TENANT.
--
-- Sin `to_regclass` guard porque todas son tablas CORE presentes en todo
-- entorno (questions/project_files desde la 1ª migración; grupos desde 2026-05;
-- intro_videos/workshop_courses desde 2026-06/07) — mismo criterio que las
-- migraciones de tenant-fix que recrean estas policies.
-- ──────────────────────────────────────────────────────────────────────

-- ── Helpers: "¿esta fila hija cuelga de un curso de mi tenant?" ──
-- SECURITY DEFINER → la lectura de la tabla padre no recursa contra su RLS.
-- STABLE → el planner cachea el resultado dentro del statement.
CREATE OR REPLACE FUNCTION public.exam_in_my_tenant(_exam_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.course_in_my_tenant((SELECT course_id FROM public.exams WHERE id = _exam_id));
$$;
GRANT EXECUTE ON FUNCTION public.exam_in_my_tenant(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.project_in_my_tenant(_project_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.course_in_my_tenant((SELECT course_id FROM public.projects WHERE id = _project_id));
$$;
GRANT EXECUTE ON FUNCTION public.project_in_my_tenant(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.workshop_in_my_tenant(_workshop_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.course_in_my_tenant((SELECT course_id FROM public.workshops WHERE id = _workshop_id));
$$;
GRANT EXECUTE ON FUNCTION public.workshop_in_my_tenant(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.workshop_group_in_my_tenant(_group_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.workshop_in_my_tenant((SELECT workshop_id FROM public.workshop_groups WHERE id = _group_id));
$$;
GRANT EXECUTE ON FUNCTION public.workshop_group_in_my_tenant(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.project_group_in_my_tenant(_group_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.project_in_my_tenant((SELECT project_id FROM public.project_groups WHERE id = _group_id));
$$;
GRANT EXECUTE ON FUNCTION public.project_group_in_my_tenant(UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) questions (hija de exams) — CRÍTICA: exponía respuestas correctas.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated view questions" ON public.questions;
DROP POLICY IF EXISTS "Docentes/Admins manage questions" ON public.questions;
-- Idempotencia: dropear también los nombres NUEVOS por si un apply previo
-- (parcial o no registrado) ya los dejó creados → el CREATE chocaría.
DROP POLICY IF EXISTS "questions_select_in_tenant" ON public.questions;
DROP POLICY IF EXISTS "questions_staff_manage" ON public.questions;

CREATE POLICY "questions_select_in_tenant"
  ON public.questions FOR SELECT TO authenticated
  USING (public.exam_in_my_tenant(exam_id));

CREATE POLICY "questions_staff_manage"
  ON public.questions FOR ALL TO authenticated
  USING (
    public.exam_in_my_tenant(exam_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.exam_in_my_tenant(exam_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 2) project_files (hija de projects)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "project_files_view_all_authenticated" ON public.project_files;
DROP POLICY IF EXISTS "project_files_manage_teachers_admins" ON public.project_files;
DROP POLICY IF EXISTS "project_files_select_in_tenant" ON public.project_files;
DROP POLICY IF EXISTS "project_files_staff_manage" ON public.project_files;

CREATE POLICY "project_files_select_in_tenant"
  ON public.project_files FOR SELECT TO authenticated
  USING (public.project_in_my_tenant(project_id));

CREATE POLICY "project_files_staff_manage"
  ON public.project_files FOR ALL TO authenticated
  USING (
    public.project_in_my_tenant(project_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.project_in_my_tenant(project_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 3) workshop_groups (hija de workshops)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "workshop_groups_read" ON public.workshop_groups;
DROP POLICY IF EXISTS "workshop_groups_teacher_admin_write" ON public.workshop_groups;
DROP POLICY IF EXISTS "workshop_groups_select_in_tenant" ON public.workshop_groups;
DROP POLICY IF EXISTS "workshop_groups_staff_manage" ON public.workshop_groups;

CREATE POLICY "workshop_groups_select_in_tenant"
  ON public.workshop_groups FOR SELECT TO authenticated
  USING (public.workshop_in_my_tenant(workshop_id));

CREATE POLICY "workshop_groups_staff_manage"
  ON public.workshop_groups FOR ALL TO authenticated
  USING (
    public.workshop_in_my_tenant(workshop_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.workshop_in_my_tenant(workshop_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4) workshop_group_members (hija de workshop_groups)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "workshop_group_members_read" ON public.workshop_group_members;
DROP POLICY IF EXISTS "workshop_group_members_teacher_admin_write" ON public.workshop_group_members;
DROP POLICY IF EXISTS "workshop_group_members_select_in_tenant" ON public.workshop_group_members;
DROP POLICY IF EXISTS "workshop_group_members_staff_manage" ON public.workshop_group_members;

CREATE POLICY "workshop_group_members_select_in_tenant"
  ON public.workshop_group_members FOR SELECT TO authenticated
  USING (public.workshop_group_in_my_tenant(group_id));

CREATE POLICY "workshop_group_members_staff_manage"
  ON public.workshop_group_members FOR ALL TO authenticated
  USING (
    public.workshop_group_in_my_tenant(group_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.workshop_group_in_my_tenant(group_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 5) project_groups (hija de projects)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "project_groups_read" ON public.project_groups;
DROP POLICY IF EXISTS "project_groups_teacher_admin_write" ON public.project_groups;
DROP POLICY IF EXISTS "project_groups_select_in_tenant" ON public.project_groups;
DROP POLICY IF EXISTS "project_groups_staff_manage" ON public.project_groups;

CREATE POLICY "project_groups_select_in_tenant"
  ON public.project_groups FOR SELECT TO authenticated
  USING (public.project_in_my_tenant(project_id));

CREATE POLICY "project_groups_staff_manage"
  ON public.project_groups FOR ALL TO authenticated
  USING (
    public.project_in_my_tenant(project_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.project_in_my_tenant(project_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 6) project_group_members (hija de project_groups)
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "project_group_members_read" ON public.project_group_members;
DROP POLICY IF EXISTS "project_group_members_teacher_admin_write" ON public.project_group_members;
DROP POLICY IF EXISTS "project_group_members_select_in_tenant" ON public.project_group_members;
DROP POLICY IF EXISTS "project_group_members_staff_manage" ON public.project_group_members;

CREATE POLICY "project_group_members_select_in_tenant"
  ON public.project_group_members FOR SELECT TO authenticated
  USING (public.project_group_in_my_tenant(group_id));

CREATE POLICY "project_group_members_staff_manage"
  ON public.project_group_members FOR ALL TO authenticated
  USING (
    public.project_group_in_my_tenant(group_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.project_group_in_my_tenant(group_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 7) workshop_courses (join taller↔curso) — YA scopeado por 20260528000000
--    (sección 9 de esa migración: workshop_courses_select_in_tenant +
--    workshop_courses_staff_manage). Recrearlo acá era REDUNDANTE y, peor,
--    chocaba: `CREATE POLICY workshop_courses_select_in_tenant ... already
--    exists` (la creó 20260528 antes que esta migración), abortando todo el
--    archivo. Además la versión de aquí omitía `OR is_super_admin()` en el
--    WRITE → habría regresionado el acceso del SuperAdmin. Se elimina el
--    bloque: 20260528 es el dueño canónico de las policies de workshop_courses
--    (incluye SA). No tocar acá.
-- ═══════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════
-- 8) workshop_intro_videos — solo SELECT (el WRITE ya estaba bien scopeado
--    a course_teachers del taller; no se toca).
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "workshop_intro_videos_select_auth" ON public.workshop_intro_videos;
DROP POLICY IF EXISTS "workshop_intro_videos_select_in_tenant" ON public.workshop_intro_videos;
CREATE POLICY "workshop_intro_videos_select_in_tenant"
  ON public.workshop_intro_videos FOR SELECT TO authenticated
  USING (public.workshop_in_my_tenant(workshop_id));

-- ═══════════════════════════════════════════════════════════════════════
-- 9) project_intro_videos — solo SELECT (WRITE ya scopeado).
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "project_intro_videos_select_auth" ON public.project_intro_videos;
DROP POLICY IF EXISTS "project_intro_videos_select_in_tenant" ON public.project_intro_videos;
CREATE POLICY "project_intro_videos_select_in_tenant"
  ON public.project_intro_videos FOR SELECT TO authenticated
  USING (public.project_in_my_tenant(project_id));

-- ═══════════════════════════════════════════════════════════════════════
-- 10) exam_assignments (hija de exams) — su policy quedó en la 1ª migración
--     (las 20260528* no la tocaron): SELECT con rama `Docente/Admin` SIN
--     tenant (cualquier staff veía qué alumno está asignado a qué examen
--     cross-tenant) y WRITE solo por rol. Se preserva la rama del DUEÑO
--     (`auth.uid() = user_id`, el alumno ve su propia asignación) y la rama
--     de staff se scopea al tenant del examen (igual que submissions).
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users see own assignments" ON public.exam_assignments;
DROP POLICY IF EXISTS "Docentes/Admins manage assignments" ON public.exam_assignments;
DROP POLICY IF EXISTS "exam_assignments_select_in_tenant" ON public.exam_assignments;
DROP POLICY IF EXISTS "exam_assignments_staff_manage" ON public.exam_assignments;

CREATE POLICY "exam_assignments_select_in_tenant"
  ON public.exam_assignments FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR (
      public.exam_in_my_tenant(exam_id)
      AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
    )
  );

CREATE POLICY "exam_assignments_staff_manage"
  ON public.exam_assignments FOR ALL TO authenticated
  USING (
    public.exam_in_my_tenant(exam_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  )
  WITH CHECK (
    public.exam_in_my_tenant(exam_id)
    AND (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin'))
  );

NOTIFY pgrst, 'reload schema';

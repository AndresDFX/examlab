-- ──────────────────────────────────────────────────────────────────────
-- Fix RLS: más leaks cross-tenant por cláusulas `has_role()` SIN scope de
-- tenant (y un SELECT `USING (true)`). Continúa el trabajo de 20260929000000.
--
-- Reportado: "creé una pizarra y se está viendo en UNIAJ". Causa raíz: varias
-- policies dan acceso por ROL (has_role('Admin'/'Docente')) sin verificar que
-- la fila pertenezca al tenant del usuario. Como `has_role` es un rol GLOBAL,
-- cualquier Admin/Docente veía datos de TODAS las instituciones.
--
-- Verificado empíricamente contra prod (un Docente del tenant vacío
-- "examlab-demo" veía filas ajenas, y un Admin veía whiteboards de todos):
--   - whiteboards / whiteboard_pages  (rama Admin tenant-blind)
--   - attendance_records              (has_role sin tenant; 111 filas ajenas)
--   - similarity_pairs                (has_role sin tenant; 135 filas ajenas)
--   - workshop_questions              (SELECT USING(true) + write solo-rol; 41)
--
-- Patrón de fix (idéntico a 20260929 y a las migraciones de tenant): el SELECT
-- se scopea al tenant del recurso (tenant_id propio, o el del curso del que
-- cuelga vía helper SECURITY DEFINER); el WRITE pasa a "tenant + rol". Se
-- preservan: dueño, is_super_admin() (bypass cross-tenant), y la lectura del
-- alumno (matrícula / asistencia propia).
--
-- Sin `to_regclass` guard: todas son tablas presentes en todo entorno
-- (mismo criterio que 20260929 y las migraciones de tenant-fix).
--
-- NO se tocan aquí (clasificadas en la auditoría, requieren decisión de
-- producto y NO son leaks de datos cross-tenant):
--   - code_execution_settings: SELECT abierto a authenticated es intencional
--     (el alumno necesita el runner activo en el examen); config global sin
--     tenant_id. Restringir rompería la toma de examen.
--   - email_settings: singleton global; el UPDATE por cualquier Admin es un
--     tema de privilegio (no de datos). Cambiarlo a SA-only podría romper la
--     gestión de correos por Admin — definir si debe ser per-tenant primero.
--   - report_templates / platform_settings: ya correctas (globales by-design /
--     scopeadas en 20260528010000).
-- ──────────────────────────────────────────────────────────────────────

-- ── Helpers nuevos "¿esta fila cuelga de un recurso de mi tenant?" ──
-- SECURITY DEFINER → leer la tabla padre no recursa contra su RLS.
-- STABLE → el planner cachea el resultado dentro del statement.

-- attendance_records.session_id → attendance_sessions.course_id → tenant.
CREATE OR REPLACE FUNCTION public.attendance_session_in_my_tenant(_session_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.course_in_my_tenant((SELECT course_id FROM public.attendance_sessions WHERE id = _session_id));
$$;
GRANT EXECUTE ON FUNCTION public.attendance_session_in_my_tenant(UUID) TO authenticated;

-- similarity_pairs.ref_id es el id del EXAMEN/TALLER/PROYECTO (no de la entrega),
-- según `kind`. Reusa los helpers *_in_my_tenant ya existentes (20260929).
CREATE OR REPLACE FUNCTION public.similarity_ref_in_my_tenant(_kind TEXT, _ref_id UUID)
RETURNS BOOLEAN LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE _kind
    WHEN 'exam'     THEN public.exam_in_my_tenant(_ref_id)
    WHEN 'workshop' THEN public.workshop_in_my_tenant(_ref_id)
    WHEN 'project'  THEN public.project_in_my_tenant(_ref_id)
    ELSE FALSE
  END;
$$;
GRANT EXECUTE ON FUNCTION public.similarity_ref_in_my_tenant(TEXT, UUID) TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 1) whiteboards — la rama Admin no validaba tenant (TIENE tenant_id propio).
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS whiteboards_select ON public.whiteboards;
CREATE POLICY whiteboards_select
  ON public.whiteboards FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND tenant_id = public.current_tenant_id())
    OR (
      is_shared_with_course = true
      AND course_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM public.course_enrollments ce
         WHERE ce.course_id = whiteboards.course_id AND ce.user_id = auth.uid()
      )
    )
  );

DROP POLICY IF EXISTS whiteboards_owner_write ON public.whiteboards;
CREATE POLICY whiteboards_owner_write
  ON public.whiteboards FOR ALL TO authenticated
  USING (
    owner_id = auth.uid()
    OR public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND tenant_id = public.current_tenant_id())
  )
  WITH CHECK (
    owner_id = auth.uid()
    OR public.is_super_admin()
    OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND tenant_id = public.current_tenant_id())
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 2) whiteboard_pages — delega a whiteboards; misma rama Admin tenant-blind.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS whiteboard_pages_select ON public.whiteboard_pages;
CREATE POLICY whiteboard_pages_select
  ON public.whiteboard_pages FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.is_super_admin()
          OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND w.tenant_id = public.current_tenant_id())
          OR (
            w.is_shared_with_course = true
            AND w.course_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM public.course_enrollments ce
              WHERE ce.course_id = w.course_id AND ce.user_id = auth.uid()
            )
          )
        )
    )
  );

DROP POLICY IF EXISTS whiteboard_pages_owner_write ON public.whiteboard_pages;
CREATE POLICY whiteboard_pages_owner_write
  ON public.whiteboard_pages FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.is_super_admin()
          OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND w.tenant_id = public.current_tenant_id())
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.whiteboards w
      WHERE w.id = whiteboard_pages.whiteboard_id
        AND (
          w.owner_id = auth.uid()
          OR public.is_super_admin()
          OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND w.tenant_id = public.current_tenant_id())
        )
    )
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 3) attendance_records — has_role sin tenant. El alumno ve SU asistencia;
--    el staff ve la del curso de SU tenant.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Users see own attendance" ON public.attendance_records;
DROP POLICY IF EXISTS "Docentes/Admins manage attendance" ON public.attendance_records;
DROP POLICY IF EXISTS attendance_records_select_in_tenant ON public.attendance_records;
DROP POLICY IF EXISTS attendance_records_staff_manage ON public.attendance_records;

CREATE POLICY attendance_records_select_in_tenant
  ON public.attendance_records FOR SELECT TO authenticated
  USING (
    auth.uid() = user_id
    OR (
      public.attendance_session_in_my_tenant(session_id)
      AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
    )
  );

CREATE POLICY attendance_records_staff_manage
  ON public.attendance_records FOR ALL TO authenticated
  USING (
    public.attendance_session_in_my_tenant(session_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  )
  WITH CHECK (
    public.attendance_session_in_my_tenant(session_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 4) similarity_pairs — polimórfica (kind, ref_id=id del examen/taller/proyecto).
--    Scope al tenant del recurso referenciado.
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Docentes/Admins read similarity_pairs" ON public.similarity_pairs;
DROP POLICY IF EXISTS "Docentes/Admins insert similarity_pairs" ON public.similarity_pairs;
DROP POLICY IF EXISTS "Docentes/Admins delete similarity_pairs" ON public.similarity_pairs;
DROP POLICY IF EXISTS "similarity_pairs_review_update" ON public.similarity_pairs;
DROP POLICY IF EXISTS similarity_pairs_select_in_tenant ON public.similarity_pairs;
DROP POLICY IF EXISTS similarity_pairs_insert_staff ON public.similarity_pairs;
DROP POLICY IF EXISTS similarity_pairs_delete_staff ON public.similarity_pairs;
DROP POLICY IF EXISTS similarity_pairs_update_staff ON public.similarity_pairs;

CREATE POLICY similarity_pairs_select_in_tenant
  ON public.similarity_pairs FOR SELECT TO authenticated
  USING (
    public.similarity_ref_in_my_tenant(kind, ref_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  );

CREATE POLICY similarity_pairs_insert_staff
  ON public.similarity_pairs FOR INSERT TO authenticated
  WITH CHECK (
    public.similarity_ref_in_my_tenant(kind, ref_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  );

CREATE POLICY similarity_pairs_update_staff
  ON public.similarity_pairs FOR UPDATE TO authenticated
  USING (
    public.similarity_ref_in_my_tenant(kind, ref_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  )
  WITH CHECK (
    public.similarity_ref_in_my_tenant(kind, ref_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  );

CREATE POLICY similarity_pairs_delete_staff
  ON public.similarity_pairs FOR DELETE TO authenticated
  USING (
    public.similarity_ref_in_my_tenant(kind, ref_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  );

-- ═══════════════════════════════════════════════════════════════════════
-- 5) workshop_questions — SELECT USING(true) + write solo-rol. Scope al
--    tenant del taller (igual que 20260929 hizo con `questions` de examen).
-- ═══════════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "Authenticated view workshop questions" ON public.workshop_questions;
DROP POLICY IF EXISTS "Docentes/Admins manage workshop questions" ON public.workshop_questions;
DROP POLICY IF EXISTS workshop_questions_select_in_tenant ON public.workshop_questions;
DROP POLICY IF EXISTS workshop_questions_staff_manage ON public.workshop_questions;

CREATE POLICY workshop_questions_select_in_tenant
  ON public.workshop_questions FOR SELECT TO authenticated
  USING (public.workshop_in_my_tenant(workshop_id));

CREATE POLICY workshop_questions_staff_manage
  ON public.workshop_questions FOR ALL TO authenticated
  USING (
    public.workshop_in_my_tenant(workshop_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  )
  WITH CHECK (
    public.workshop_in_my_tenant(workshop_id)
    AND (public.has_role(auth.uid(), 'Docente'::public.app_role) OR public.has_role(auth.uid(), 'Admin'::public.app_role))
  );

NOTIFY pgrst, 'reload schema';

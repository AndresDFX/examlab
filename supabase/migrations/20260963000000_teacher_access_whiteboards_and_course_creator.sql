-- ══════════════════════════════════════════════════════════════════════
-- Acceso del DOCENTE a sus cursos / pizarras.
--
-- A) PIZARRAS — rama "docente del curso" (defense-in-depth sobre 20260960):
--    20260960 ya permite editar a cualquier Docente/Admin del MISMO tenant
--    (tenant_id = current_tenant_id()). Pero si la pizarra quedó con
--    `tenant_id` NULL/desfasado (ej. creada por un SuperAdmin sin tenant, o
--    histórico) y está asociada a un curso, el docente de ESE curso no podía
--    ni verla ni editarla. Agregamos una rama explícita: si el usuario es
--    docente del curso asociado a la pizarra (course_teachers), puede ver y
--    editar — exactamente lo que pidió el reporte ("editarla como docente del
--    curso"). NO se quita ninguna rama previa.
--
-- B) CURSOS — auto-asignar al CREADOR como docente:
--    El listado del docente se scopea a course_teachers (UI). Pero un Docente
--    que CREA un curso no podía auto-insertarse en course_teachers (la RLS lo
--    bloquea a propósito para cursos ajenos) → su propio curso nuevo
--    desaparecía de su lista. Trigger AFTER INSERT: si quien crea el curso
--    tiene rol Docente, se agrega como docente de ESE curso (SECURITY DEFINER
--    salta la RLS sólo para el curso recién creado). Un Admin/SuperAdmin SIN
--    rol Docente NO se auto-agrega (administra, no dicta).
-- ══════════════════════════════════════════════════════════════════════

-- ── A) Pizarras: rama "docente del curso" ──────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.whiteboards') IS NULL
     OR to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip whiteboards course-teacher branch: tabla(s) ausente(s)';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS whiteboards_select ON public.whiteboards;
  CREATE POLICY whiteboards_select
    ON public.whiteboards FOR SELECT TO authenticated
    USING (
      owner_id = auth.uid()
      OR public.is_super_admin()
      OR (
        (public.has_role(auth.uid(), 'Admin'::public.app_role)
          OR public.has_role(auth.uid(), 'Docente'::public.app_role))
        AND tenant_id = public.current_tenant_id()
      )
      -- Docente del curso asociado (cubre tenant_id NULL/desfasado).
      OR (
        course_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = whiteboards.course_id
             AND ct.user_id = auth.uid()
        )
      )
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
      OR (
        (public.has_role(auth.uid(), 'Admin'::public.app_role)
          OR public.has_role(auth.uid(), 'Docente'::public.app_role))
        AND tenant_id = public.current_tenant_id()
      )
      OR (
        course_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = whiteboards.course_id
             AND ct.user_id = auth.uid()
        )
      )
    )
    WITH CHECK (
      owner_id = auth.uid()
      OR public.is_super_admin()
      OR (
        (public.has_role(auth.uid(), 'Admin'::public.app_role)
          OR public.has_role(auth.uid(), 'Docente'::public.app_role))
        AND tenant_id = public.current_tenant_id()
      )
      OR (
        course_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = whiteboards.course_id
             AND ct.user_id = auth.uid()
        )
      )
    );
END
$mig$;

-- whiteboard_pages: mismo criterio (vía la pizarra padre).
DO $mig$
BEGIN
  IF to_regclass('public.whiteboard_pages') IS NULL
     OR to_regclass('public.whiteboards') IS NULL
     OR to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip whiteboard_pages course-teacher branch: tabla(s) ausente(s)';
    RETURN;
  END IF;

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
            OR (
              (public.has_role(auth.uid(), 'Admin'::public.app_role)
                OR public.has_role(auth.uid(), 'Docente'::public.app_role))
              AND w.tenant_id = public.current_tenant_id()
            )
            OR (
              w.course_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.course_teachers ct
                 WHERE ct.course_id = w.course_id AND ct.user_id = auth.uid()
              )
            )
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
            OR (
              (public.has_role(auth.uid(), 'Admin'::public.app_role)
                OR public.has_role(auth.uid(), 'Docente'::public.app_role))
              AND w.tenant_id = public.current_tenant_id()
            )
            OR (
              w.course_id IS NOT NULL
              AND EXISTS (
                SELECT 1 FROM public.course_teachers ct
                 WHERE ct.course_id = w.course_id AND ct.user_id = auth.uid()
              )
            )
          )
      )
    );
END
$mig$;

-- ── B) Cursos: auto-asignar al creador Docente como docente del curso ───
DO $mig$
BEGIN
  IF to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_teachers') IS NULL THEN
    RAISE NOTICE 'skip course-creator-teacher trigger: tabla(s) ausente(s)';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public._tg_course_add_creator_teacher()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $fn$
  BEGIN
    -- Sólo si quien crea tiene rol Docente. SECURITY DEFINER salta la RLS
    -- que impide al Docente auto-insertarse en course_teachers de cursos
    -- ARBITRARIOS — acá es el curso que él mismo acaba de crear.
    IF auth.uid() IS NOT NULL
       AND public.has_role(auth.uid(), 'Docente'::public.app_role) THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.course_teachers
         WHERE course_id = NEW.id AND user_id = auth.uid()
      ) THEN
        INSERT INTO public.course_teachers (course_id, user_id)
        VALUES (NEW.id, auth.uid());
      END IF;
    END IF;
    RETURN NEW;
  END
  $fn$;

  DROP TRIGGER IF EXISTS tg_course_add_creator_teacher ON public.courses;
  CREATE TRIGGER tg_course_add_creator_teacher
    AFTER INSERT ON public.courses
    FOR EACH ROW EXECUTE FUNCTION public._tg_course_add_creator_teacher();
END
$mig$;

NOTIFY pgrst, 'reload schema';

-- ──────────────────────────────────────────────────────────────────────
-- Anotaciones del docente SOBRE las diapositivas de un contenido
-- (presentación generada con IA `kind='pptx-source'` o imágenes subidas
-- que hacen de diapositivas).
--
-- Por qué una tabla nueva y no `generated_contents.files[]`:
--   ese JSONB se REESCRIBE COMPLETO en varios flujos (editor de pptx,
--   subida de archivos al contenido, board-content-upload). Meter las
--   anotaciones ahí las expone a que un write concurrente de otro flujo
--   las borre sin que nadie se entere. Acá viven en su propia fila, con
--   su propia RLS, y el guardado es UN upsert atómico de toda la sesión
--   de anotación (semántica de editor: "guardar al final").
--
-- FORMA DEL JSONB `slides`:
--   { "<file_path>#<slide_index>": <escena Excalidraw>, ... }
--   - `file_path` = el path del archivo dentro de `generated_contents.files[]`.
--   - `slide_index` = índice 0-based de la diapositiva DENTRO de ese archivo
--     (para imágenes siempre 0; para pptx-source, el orden del parser).
--   - La escena es `{ elements, appState?, files? }` (mismo subset que
--     `whiteboards.scene_json`), en un espacio de coordenadas CANÓNICO de
--     960x540 unidades, así una anotación hecha en un proyector se ve
--     igual en un celular.
--   - Las diapositivas SIN anotar simplemente NO tienen clave → el JSONB
--     queda chico y "borrar anotaciones" = borrar la clave.
--
-- RLS: la tabla es HIJA de `generated_contents` (que a su vez cuelga de un
-- curso). Nada de `USING (true)` ni de `has_role()` sin tenant — ambas ramas
-- pasan por helpers SECURITY DEFINER que derivan el curso y exigen tenant.
--
-- Toda la migración va dentro de un DO guardado por `to_regclass`: Lovable
-- a veces marca migraciones como aplicadas sin que el CREATE TABLE del padre
-- haya corrido, y un error acá abortaría TODO el deploy.
-- ──────────────────────────────────────────────────────────────────────

DO $mig$
BEGIN
  IF to_regclass('public.generated_contents') IS NULL
     OR to_regclass('public.content_course_assignments') IS NULL
     OR to_regclass('public.attendance_sessions') IS NULL
     OR to_regclass('public.course_teachers') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'content_slide_annotations: falta una tabla padre — se omite la migración';
    RETURN;
  END IF;

  -- ── 1. Tabla ────────────────────────────────────────────────────────
  EXECUTE $ddl$
    CREATE TABLE IF NOT EXISTS public.content_slide_annotations (
      content_id UUID PRIMARY KEY
        REFERENCES public.generated_contents(id) ON DELETE CASCADE,
      slides JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
    )
  $ddl$;

  EXECUTE $ddl$
    COMMENT ON TABLE public.content_slide_annotations IS
      'Anotaciones (capa de dibujo) por diapositiva de un contenido. slides = { "<file_path>#<slide_index>": escena Excalidraw } en espacio canónico 960x540.'
  $ddl$;

  -- ── 2. Guard de integridad + autoría (anti self-tamper) ─────────────
  -- `updated_by` NO se confía al cliente: lo fija el trigger con auth.uid().
  -- El tope de 5 MB replica el de `update_session_whiteboard_scene` — sin él
  -- una escena con imágenes pegadas puede inflar la fila sin control.
  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.tg_content_slide_annotations_guard()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = public
    AS $fn$
    BEGIN
      IF jsonb_typeof(NEW.slides) <> 'object' THEN
        RAISE EXCEPTION 'Las anotaciones deben ser un objeto { clave: escena }';
      END IF;
      IF pg_column_size(NEW.slides) > 5 * 1024 * 1024 THEN
        RAISE EXCEPTION 'Las anotaciones de este contenido superan el máximo de 5 MB';
      END IF;
      NEW.updated_at := now();
      NEW.updated_by := auth.uid();
      RETURN NEW;
    END;
    $fn$
  $ddl$;

  EXECUTE 'DROP TRIGGER IF EXISTS content_slide_annotations_guard ON public.content_slide_annotations';
  EXECUTE $ddl$
    CREATE TRIGGER content_slide_annotations_guard
      BEFORE INSERT OR UPDATE ON public.content_slide_annotations
      FOR EACH ROW EXECUTE FUNCTION public.tg_content_slide_annotations_guard()
  $ddl$;

  -- ── 3. Helper de ESCRITURA (docente dueño / co-docente / Admin) ──────
  -- Ramas:
  --   a) SuperAdmin.
  --   b) Dueño del contenido (teacher_id) o Admin, SIEMPRE con scope de
  --      tenant: si el contenido está anclado a un curso, el curso debe ser
  --      de mi tenant; si no tiene curso (material general), el dueño debe
  --      ser yo o alguien de mi tenant. Un Admin de OTRA institución no pasa.
  --   c) Docente del curso al que el contenido está asignado (co-docencia),
  --      también con scope de tenant.
  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.content_annotations_can_write(_content_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $fn$
      SELECT EXISTS (
        SELECT 1
        FROM public.generated_contents gc
        WHERE gc.id = _content_id
          AND gc.deleted_at IS NULL
          AND (
            public.is_super_admin()
            OR (
              (gc.teacher_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'::public.app_role))
              AND CASE
                    WHEN gc.course_id IS NOT NULL THEN public.course_in_my_tenant(gc.course_id)
                    ELSE gc.teacher_id = auth.uid()
                         OR EXISTS (
                           SELECT 1 FROM public.profiles p
                           WHERE p.id = gc.teacher_id
                             AND p.tenant_id = public.current_tenant_id()
                         )
                  END
            )
            OR EXISTS (
              SELECT 1
              FROM public.content_course_assignments cca
              JOIN public.course_teachers ct ON ct.course_id = cca.course_id
              WHERE cca.content_id = gc.id
                AND ct.user_id = auth.uid()
                AND public.course_in_my_tenant(cca.course_id)
            )
          )
      );
    $fn$
  $ddl$;

  -- ── 4. Helper de LECTURA (escritura + alumno con el contenido visible) ─
  -- Replica el predicado de las dos policies de SELECT del estudiante sobre
  -- `generated_contents` (vía content_course_assignments y vía sesión) más el
  -- gate de liberación. El alumno NUNCA escribe: ver el punto 5.
  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.content_annotations_can_read(_content_id uuid)
    RETURNS boolean
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = public
    AS $fn$
      SELECT public.content_annotations_can_write(_content_id)
        OR EXISTS (
          SELECT 1
          FROM public.generated_contents gc
          WHERE gc.id = _content_id
            AND gc.deleted_at IS NULL
            AND public.content_released_for_student(gc.id)
            AND (
              (
                gc.status = 'done'::public.content_status
                AND gc.is_published = true
                AND EXISTS (
                  SELECT 1
                  FROM public.content_course_assignments cca
                  JOIN public.course_enrollments ce ON ce.course_id = cca.course_id
                  WHERE cca.content_id = gc.id
                    AND ce.user_id = auth.uid()
                )
              )
              OR EXISTS (
                SELECT 1
                FROM public.attendance_sessions s
                JOIN public.course_enrollments ce ON ce.course_id = s.course_id
                WHERE s.content_id = gc.id
                  AND ce.user_id = auth.uid()
                  AND s.deleted_at IS NULL
              )
            )
        );
    $fn$
  $ddl$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.content_annotations_can_write(uuid) FROM anon';
  EXECUTE 'REVOKE ALL ON FUNCTION public.content_annotations_can_read(uuid) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.content_annotations_can_write(uuid) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.content_annotations_can_read(uuid) TO authenticated';

  -- ── 5. RLS ──────────────────────────────────────────────────────────
  EXECUTE 'ALTER TABLE public.content_slide_annotations ENABLE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS content_slide_annotations_select ON public.content_slide_annotations';
  EXECUTE $ddl$
    CREATE POLICY content_slide_annotations_select ON public.content_slide_annotations
      FOR SELECT TO authenticated
      USING (public.content_annotations_can_read(content_id))
  $ddl$;

  EXECUTE 'DROP POLICY IF EXISTS content_slide_annotations_write ON public.content_slide_annotations';
  EXECUTE $ddl$
    CREATE POLICY content_slide_annotations_write ON public.content_slide_annotations
      FOR ALL TO authenticated
      USING (public.content_annotations_can_write(content_id))
      WITH CHECK (public.content_annotations_can_write(content_id))
  $ddl$;

  EXECUTE 'REVOKE ALL ON TABLE public.content_slide_annotations FROM anon';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.content_slide_annotations TO authenticated';
END $mig$;

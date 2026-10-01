-- ══════════════════════════════════════════════════════════════════════
-- Un curso en BORRADOR tiene todo su material en borrador.
--
-- Hasta acá el estado del curso y el de su material eran independientes: los
-- 7 cursos 2026-2 de UNIAJ estuvieron en borrador con talleres, exámenes y
-- encuestas publicados y los estudiantes entregando. La regla nueva, espejo de
-- la cascada al FINALIZAR (mig 20260991000000):
--
--   1. CASCADA: cuando un curso pasa a `borrador`, su material publicado pasa a
--      borrador —exámenes, talleres, proyectos, encuestas, pizarras
--      compartidas con el curso y contenidos— y terminan los retos en vivo de
--      sus encuestas. Lo compartido (M:N) con OTRO curso que no está en
--      borrador NO se toca: sus estudiantes lo siguen usando.
--      Igual que al finalizar, NO se deshace: volver a activar el curso no
--      republica nada (no se guarda el estado previo de cada pieza; publicar es
--      una decisión del docente y dispara avisos). El diálogo lo advierte.
--
--   2. BLOQUEO: no se PUBLICA material cuyos cursos están todos en borrador.
--      Exámenes, talleres, proyectos y encuestas nacen en borrador, así que
--      publicarlos es siempre explícito: se rechaza con un mensaje. Pizarras y
--      contenidos, en cambio, se CREAN publicados (subir material al tablero lo
--      publica): ahí crearlos, compartirlos o moverlos a un curso en borrador
--      los deja en borrador en vez de fallar —si no, preparar un curso se
--      rompería—, y solo se rechaza publicarlos después, que sí es explícito.
--      Se mira la TRANSICIÓN (o el cambio de curso), no el estado: editar algo
--      que ya estaba publicado no se bloquea.
--      Lo que el trigger ve es el ancla (`course_id`) más las filas de unión
--      que YA existen. Las pantallas que crean material multi-curso eligen como
--      ancla un curso activo cuando hay uno, para que el insert no se rechace
--      antes de que existan las filas de unión.
--      Lo que NO cubre, a propósito: cambiar las filas de unión de algo ya
--      publicado (workshop_courses, project_courses, poll_courses,
--      content_course_assignments). Agregar un curso en borrador no lo
--      despublica —sigue siendo de un curso activo—, y quitarle el único curso
--      activo lo deja publicado solo en cursos en borrador hasta la próxima
--      cascada. Un trigger en esas tablas tendría que despublicar o rechazar en
--      medio de un «borrar todas las filas e insertar las nuevas», que es como
--      guardan las pantallas: rompería la edición.
--
--   3. `impacto_cambio_estado_curso(curso, estado)`: qué va a pasar si se
--      cambia el estado —cuánto pasa a borrador, cuánto se cierra, cuánto sigue
--      en borrador, si sale la bienvenida— para que el diálogo lo diga con
--      números antes de confirmar. Cuenta con las MISMAS funciones que usa la
--      cascada, así el aviso y lo que pasa no pueden diferir.
--
-- «Material del curso» = lo que el estudiante ve porque está publicado. Una
-- pizarra PERSONAL (no compartida con el curso) no es material: es un espacio
-- de trabajo, y la de un estudiante no puede quedar oculta para él mismo.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Predicados ─────────────────────────────────────────────────────

-- ¿Todos los cursos vigentes del conjunto están en borrador? `p_como_borrador`
-- trata a ESE curso como si ya lo estuviera: sirve para simular el cambio antes
-- de hacerlo (el impacto) y es inocuo en la cascada, donde ya lo está. Un curso
-- en la papelera no cuenta; un conjunto sin ningún curso vigente da `false`
-- (material personal, sin curso, no se bloquea).
CREATE OR REPLACE FUNCTION public._solo_cursos_en_borrador(p_cursos uuid[], p_como_borrador uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
           SELECT 1 FROM public.courses c
            WHERE c.id = ANY(p_cursos) AND c.deleted_at IS NULL)
     AND NOT EXISTS (
           SELECT 1 FROM public.courses c
            WHERE c.id = ANY(p_cursos)
              AND c.deleted_at IS NULL
              AND c.status IS DISTINCT FROM 'borrador'
              AND c.id IS DISTINCT FROM p_como_borrador);
$$;

CREATE OR REPLACE FUNCTION public._nombre_curso_en_borrador(p_cursos uuid[])
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT c.name FROM public.courses c
   WHERE c.id = ANY(p_cursos) AND c.deleted_at IS NULL AND c.status = 'borrador'
   ORDER BY c.name LIMIT 1;
$$;

-- Los cursos de cada material: el ancla (`course_id`) y los de la tabla de unión.
CREATE OR REPLACE FUNCTION public._cursos_de_taller(p_id uuid, p_ancla uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT ARRAY(
    SELECT p_ancla WHERE p_ancla IS NOT NULL
    UNION SELECT wc.course_id FROM public.workshop_courses wc WHERE wc.workshop_id = p_id);
$$;

CREATE OR REPLACE FUNCTION public._cursos_de_proyecto(p_id uuid, p_ancla uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT ARRAY(
    SELECT p_ancla WHERE p_ancla IS NOT NULL
    UNION SELECT pc.course_id FROM public.project_courses pc WHERE pc.project_id = p_id);
$$;

CREATE OR REPLACE FUNCTION public._cursos_de_encuesta(p_id uuid, p_ancla uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT ARRAY(
    SELECT p_ancla WHERE p_ancla IS NOT NULL
    UNION SELECT pc.course_id FROM public.poll_courses pc WHERE pc.poll_id = p_id);
$$;

CREATE OR REPLACE FUNCTION public._cursos_de_contenido(p_id uuid, p_ancla uuid)
RETURNS uuid[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT ARRAY(
    SELECT p_ancla WHERE p_ancla IS NOT NULL
    UNION SELECT cca.course_id FROM public.content_course_assignments cca WHERE cca.content_id = p_id);
$$;

-- ── 2) Qué pasa a borrador cuando el curso pasa a borrador ────────────
-- Una función por material que devuelve los ids: la usan la cascada (para
-- actualizar) y el impacto (para contar), así los dos no pueden diferir.

CREATE OR REPLACE FUNCTION public._examenes_a_borrador(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT e.id FROM public.exams e
   WHERE e.course_id = p_course_id AND e.status = 'published' AND e.deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public._talleres_a_borrador(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT w.id FROM public.workshops w
   WHERE w.deleted_at IS NULL
     AND w.status = 'published'
     AND (w.course_id = p_course_id
          OR EXISTS (SELECT 1 FROM public.workshop_courses wc
                      WHERE wc.workshop_id = w.id AND wc.course_id = p_course_id))
     AND public._solo_cursos_en_borrador(public._cursos_de_taller(w.id, w.course_id), p_course_id);
$$;

CREATE OR REPLACE FUNCTION public._proyectos_a_borrador(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p.id FROM public.projects p
   WHERE p.deleted_at IS NULL
     AND p.status = 'published'
     AND (p.course_id = p_course_id
          OR EXISTS (SELECT 1 FROM public.project_courses pc
                      WHERE pc.project_id = p.id AND pc.course_id = p_course_id))
     AND public._solo_cursos_en_borrador(public._cursos_de_proyecto(p.id, p.course_id), p_course_id);
$$;

-- Todas las encuestas del curso que quedan sin ningún curso activo, publicadas
-- o no: un reto en vivo se hospeda con la encuesta en BORRADOR (el caso típico),
-- así que para terminar sus juegos no alcanza con mirar las publicadas.
CREATE OR REPLACE FUNCTION public._encuestas_solo_en_borrador(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p.id FROM public.polls p
   WHERE p.deleted_at IS NULL
     AND (p.course_id = p_course_id
          OR EXISTS (SELECT 1 FROM public.poll_courses pc
                      WHERE pc.poll_id = p.id AND pc.course_id = p_course_id))
     AND public._solo_cursos_en_borrador(public._cursos_de_encuesta(p.id, p.course_id), p_course_id);
$$;

CREATE OR REPLACE FUNCTION public._encuestas_a_borrador(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT p.id FROM public.polls p
   WHERE p.is_published
     AND p.id IN (SELECT public._encuestas_solo_en_borrador(p_course_id));
$$;

CREATE OR REPLACE FUNCTION public._retos_en_vivo_a_terminar(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF to_regclass('public.kahoot_games') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT g.id FROM public.kahoot_games g
     WHERE g.status <> 'ended'
       AND g.poll_id IN (SELECT public._encuestas_solo_en_borrador(p_course_id));
END
$$;

CREATE OR REPLACE FUNCTION public._pizarras_a_borrador(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT w.id FROM public.whiteboards w
   WHERE w.course_id = p_course_id
     AND w.deleted_at IS NULL
     AND COALESCE(w.is_shared_with_course, false)
     AND COALESCE(w.status, 'published') = 'published';
$$;

CREATE OR REPLACE FUNCTION public._contenidos_a_borrador(p_course_id uuid)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT g.id FROM public.generated_contents g
   WHERE g.deleted_at IS NULL
     AND g.is_published
     AND (g.course_id = p_course_id
          OR EXISTS (SELECT 1 FROM public.content_course_assignments cca
                      WHERE cca.content_id = g.id AND cca.course_id = p_course_id))
     AND public._solo_cursos_en_borrador(public._cursos_de_contenido(g.id, g.course_id), p_course_id);
$$;

-- ── 3) La cascada ─────────────────────────────────────────────────────
-- Best-effort por material, igual que la de finalizar: pasar el curso a
-- borrador tiene que funcionar aunque un paso falle, y un fallo en uno no debe
-- impedir los demás.
CREATE OR REPLACE FUNCTION public.tg_cascade_borrador_curso()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  BEGIN
    UPDATE public.exams SET status = 'draft', updated_at = now()
     WHERE id IN (SELECT public._examenes_a_borrador(NEW.id));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'borrador exámenes curso %: %', NEW.id, SQLERRM; END;
  BEGIN
    UPDATE public.workshops SET status = 'draft', updated_at = now()
     WHERE id IN (SELECT public._talleres_a_borrador(NEW.id));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'borrador talleres curso %: %', NEW.id, SQLERRM; END;
  BEGIN
    UPDATE public.projects SET status = 'draft', updated_at = now()
     WHERE id IN (SELECT public._proyectos_a_borrador(NEW.id));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'borrador proyectos curso %: %', NEW.id, SQLERRM; END;
  BEGIN
    -- Primero los juegos: se calculan sobre las encuestas del curso, y eso no
    -- depende de que estén publicadas.
    IF to_regclass('public.kahoot_games') IS NOT NULL THEN
      UPDATE public.kahoot_games SET status = 'ended'
       WHERE id IN (SELECT public._retos_en_vivo_a_terminar(NEW.id));
    END IF;
    UPDATE public.polls SET is_published = false, updated_at = now()
     WHERE id IN (SELECT public._encuestas_a_borrador(NEW.id));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'borrador encuestas curso %: %', NEW.id, SQLERRM; END;
  BEGIN
    UPDATE public.whiteboards SET status = 'draft'
     WHERE id IN (SELECT public._pizarras_a_borrador(NEW.id));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'borrador pizarras curso %: %', NEW.id, SQLERRM; END;
  BEGIN
    UPDATE public.generated_contents SET is_published = false
     WHERE id IN (SELECT public._contenidos_a_borrador(NEW.id));
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'borrador contenidos curso %: %', NEW.id, SQLERRM; END;
  RETURN NULL;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.courses') IS NULL THEN
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS trg_cascade_borrador_curso ON public.courses;
  CREATE TRIGGER trg_cascade_borrador_curso
    AFTER UPDATE OF status ON public.courses
    FOR EACH ROW
    WHEN (NEW.status = 'borrador' AND OLD.status IS DISTINCT FROM 'borrador')
    EXECUTE FUNCTION public.tg_cascade_borrador_curso();
END
$$;

-- ── 4) No se publica material de un curso en borrador ─────────────────
-- Un trigger por tabla (cada una guarda la publicación a su manera).

CREATE OR REPLACE FUNCTION public.tg_bloquear_publicar_examen()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.status = 'published'
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM 'published'
          OR OLD.course_id IS DISTINCT FROM NEW.course_id)
     AND public._solo_cursos_en_borrador(ARRAY[NEW.course_id]) THEN
    RAISE EXCEPTION 'El curso «%» está en borrador: su material no se puede publicar. Actívalo primero.',
      public._nombre_curso_en_borrador(ARRAY[NEW.course_id]);
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.tg_bloquear_publicar_taller()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_cursos uuid[];
BEGIN
  IF NEW.status = 'published'
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM 'published'
          OR OLD.course_id IS DISTINCT FROM NEW.course_id) THEN
    v_cursos := public._cursos_de_taller(NEW.id, NEW.course_id);
    IF public._solo_cursos_en_borrador(v_cursos) THEN
      RAISE EXCEPTION 'El curso «%» está en borrador: su material no se puede publicar. Actívalo primero.',
        public._nombre_curso_en_borrador(v_cursos);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.tg_bloquear_publicar_proyecto()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_cursos uuid[];
BEGIN
  IF NEW.status = 'published'
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM 'published'
          OR OLD.course_id IS DISTINCT FROM NEW.course_id) THEN
    v_cursos := public._cursos_de_proyecto(NEW.id, NEW.course_id);
    IF public._solo_cursos_en_borrador(v_cursos) THEN
      RAISE EXCEPTION 'El curso «%» está en borrador: su material no se puede publicar. Actívalo primero.',
        public._nombre_curso_en_borrador(v_cursos);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public.tg_bloquear_publicar_encuesta()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_cursos uuid[];
BEGIN
  IF COALESCE(NEW.is_published, false)
     AND (TG_OP = 'INSERT'
          OR NOT COALESCE(OLD.is_published, false)
          OR OLD.course_id IS DISTINCT FROM NEW.course_id) THEN
    v_cursos := public._cursos_de_encuesta(NEW.id, NEW.course_id);
    IF public._solo_cursos_en_borrador(v_cursos) THEN
      RAISE EXCEPTION 'El curso «%» está en borrador: su material no se puede publicar. Actívalo primero.',
        public._nombre_curso_en_borrador(v_cursos);
    END IF;
  END IF;
  RETURN NEW;
END
$$;

-- Pizarra: es material cuando está publicada Y compartida con el curso. Si
-- quedaría visible en un curso en borrador: publicarla explícitamente (su
-- estado pasa a `published`) se rechaza; crearla, compartirla o moverla ahí la
-- deja en borrador.
CREATE OR REPLACE FUNCTION public.tg_bloquear_publicar_pizarra()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF NEW.course_id IS NULL
     OR NOT (COALESCE(NEW.status, 'published') = 'published' AND COALESCE(NEW.is_shared_with_course, false))
     OR NOT public._solo_cursos_en_borrador(ARRAY[NEW.course_id]) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.course_id IS NOT DISTINCT FROM NEW.course_id
       AND COALESCE(OLD.is_shared_with_course, false)
       AND COALESCE(OLD.status, 'published') = 'published' THEN
      RETURN NEW;  -- ya estaba visible ahí: editarla no la esconde
    END IF;
    IF COALESCE(OLD.status, 'published') IS DISTINCT FROM 'published' THEN
      RAISE EXCEPTION 'El curso «%» está en borrador: su material no se puede publicar. Actívalo primero.',
        public._nombre_curso_en_borrador(ARRAY[NEW.course_id]);
    END IF;
  END IF;
  NEW.status := 'draft';
  RETURN NEW;
END
$$;

-- Contenido: subir material al tablero lo crea publicado. En un curso en
-- borrador se guarda en borrador; publicarlo después se rechaza. Moverlo a un
-- curso en borrador (cambio de ancla) también lo deja en borrador.
CREATE OR REPLACE FUNCTION public.tg_bloquear_publicar_contenido()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_cursos uuid[];
BEGIN
  IF NOT COALESCE(NEW.is_published, false) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND COALESCE(OLD.is_published, false)
     AND OLD.course_id IS NOT DISTINCT FROM NEW.course_id THEN
    RETURN NEW;
  END IF;
  v_cursos := public._cursos_de_contenido(NEW.id, NEW.course_id);
  IF NOT public._solo_cursos_en_borrador(v_cursos) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NOT COALESCE(OLD.is_published, false) THEN
    RAISE EXCEPTION 'El curso «%» está en borrador: su material no se puede publicar. Actívalo primero.',
      public._nombre_curso_en_borrador(v_cursos);
  END IF;
  NEW.is_published := false;
  RETURN NEW;
END
$$;

DO $$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bloquear_publicar_examen ON public.exams;
    CREATE TRIGGER trg_bloquear_publicar_examen
      BEFORE INSERT OR UPDATE OF status, course_id ON public.exams
      FOR EACH ROW EXECUTE FUNCTION public.tg_bloquear_publicar_examen();
  END IF;
  IF to_regclass('public.workshops') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bloquear_publicar_taller ON public.workshops;
    CREATE TRIGGER trg_bloquear_publicar_taller
      BEFORE INSERT OR UPDATE OF status, course_id ON public.workshops
      FOR EACH ROW EXECUTE FUNCTION public.tg_bloquear_publicar_taller();
  END IF;
  IF to_regclass('public.projects') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bloquear_publicar_proyecto ON public.projects;
    CREATE TRIGGER trg_bloquear_publicar_proyecto
      BEFORE INSERT OR UPDATE OF status, course_id ON public.projects
      FOR EACH ROW EXECUTE FUNCTION public.tg_bloquear_publicar_proyecto();
  END IF;
  IF to_regclass('public.polls') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bloquear_publicar_encuesta ON public.polls;
    CREATE TRIGGER trg_bloquear_publicar_encuesta
      BEFORE INSERT OR UPDATE OF is_published, course_id ON public.polls
      FOR EACH ROW EXECUTE FUNCTION public.tg_bloquear_publicar_encuesta();
  END IF;
  IF to_regclass('public.whiteboards') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bloquear_publicar_pizarra ON public.whiteboards;
    CREATE TRIGGER trg_bloquear_publicar_pizarra
      BEFORE INSERT OR UPDATE OF status, is_shared_with_course, course_id ON public.whiteboards
      FOR EACH ROW EXECUTE FUNCTION public.tg_bloquear_publicar_pizarra();
  END IF;
  IF to_regclass('public.generated_contents') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_bloquear_publicar_contenido ON public.generated_contents;
    CREATE TRIGGER trg_bloquear_publicar_contenido
      BEFORE INSERT OR UPDATE OF is_published, course_id ON public.generated_contents
      FOR EACH ROW EXECUTE FUNCTION public.tg_bloquear_publicar_contenido();
  END IF;
END
$$;

-- ── 5) Qué va a pasar si se cambia el estado del curso ────────────────
-- Para que el diálogo de confirmación lo diga con números. Misma autorización
-- que `set_course_status`. Solo cuenta; no cambia nada.
CREATE OR REPLACE FUNCTION public.impacto_cambio_estado_curso(_course_id uuid, _status text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_actual text;
  v_res jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF _status NOT IN ('borrador', 'en_curso', 'finalizado') THEN
    RAISE EXCEPTION 'Estado de curso inválido: %', _status;
  END IF;
  IF NOT (
    public.is_super_admin()
    OR (public.has_role(v_uid, 'Admin') AND public.course_in_my_tenant(_course_id))
    OR EXISTS (SELECT 1 FROM public.course_teachers ct
                WHERE ct.course_id = _course_id AND ct.user_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'No autorizado para cambiar el estado de este curso';
  END IF;
  SELECT status INTO v_actual FROM public.courses WHERE id = _course_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Curso no encontrado';
  END IF;

  v_res := jsonb_build_object(
    'estado_actual', v_actual,
    'matriculados', (SELECT count(*) FROM public.course_enrollments ce WHERE ce.course_id = _course_id)
  );

  IF _status = 'borrador' THEN
    v_res := v_res || jsonb_build_object(
      'a_borrador', jsonb_build_object(
        'examenes',   (SELECT count(*) FROM public._examenes_a_borrador(_course_id)),
        'talleres',   (SELECT count(*) FROM public._talleres_a_borrador(_course_id)),
        'proyectos',  (SELECT count(*) FROM public._proyectos_a_borrador(_course_id)),
        'encuestas',  (SELECT count(*) FROM public._encuestas_a_borrador(_course_id)),
        'pizarras',   (SELECT count(*) FROM public._pizarras_a_borrador(_course_id)),
        'contenidos', (SELECT count(*) FROM public._contenidos_a_borrador(_course_id))
      ),
      -- De los que pasan a borrador, cuántos ya tienen entregas: sus notas dejan
      -- de contar (los borradores no entran al libro de notas) hasta republicar.
      'con_entregas', (
        (SELECT count(*) FROM public._examenes_a_borrador(_course_id) x(id)
          WHERE EXISTS (SELECT 1 FROM public.submissions s WHERE s.exam_id = x.id))
        + (SELECT count(*) FROM public._talleres_a_borrador(_course_id) x(id)
          WHERE EXISTS (SELECT 1 FROM public.workshop_submissions s WHERE s.workshop_id = x.id))
        + (SELECT count(*) FROM public._proyectos_a_borrador(_course_id) x(id)
          WHERE EXISTS (SELECT 1 FROM public.project_submissions s WHERE s.project_id = x.id))
      ),
      'retos_en_vivo', (SELECT count(*) FROM public._retos_en_vivo_a_terminar(_course_id)),
      -- Publicados de este curso que siguen publicados porque otro curso que no
      -- está en borrador también los usa.
      'compartidos_siguen', (
        (SELECT count(*) FROM public.workshops w
          WHERE w.deleted_at IS NULL AND w.status = 'published'
            AND (w.course_id = _course_id OR EXISTS (
                  SELECT 1 FROM public.workshop_courses wc WHERE wc.workshop_id = w.id AND wc.course_id = _course_id))
            AND NOT public._solo_cursos_en_borrador(public._cursos_de_taller(w.id, w.course_id), _course_id))
        + (SELECT count(*) FROM public.projects p
          WHERE p.deleted_at IS NULL AND p.status = 'published'
            AND (p.course_id = _course_id OR EXISTS (
                  SELECT 1 FROM public.project_courses pc WHERE pc.project_id = p.id AND pc.course_id = _course_id))
            AND NOT public._solo_cursos_en_borrador(public._cursos_de_proyecto(p.id, p.course_id), _course_id))
        + (SELECT count(*) FROM public.polls p
          WHERE p.deleted_at IS NULL AND p.is_published
            AND (p.course_id = _course_id OR EXISTS (
                  SELECT 1 FROM public.poll_courses pc WHERE pc.poll_id = p.id AND pc.course_id = _course_id))
            AND NOT public._solo_cursos_en_borrador(public._cursos_de_encuesta(p.id, p.course_id), _course_id))
        + (SELECT count(*) FROM public.generated_contents g
          WHERE g.deleted_at IS NULL AND g.is_published
            AND (g.course_id = _course_id OR EXISTS (
                  SELECT 1 FROM public.content_course_assignments cca WHERE cca.content_id = g.id AND cca.course_id = _course_id))
            AND NOT public._solo_cursos_en_borrador(public._cursos_de_contenido(g.id, g.course_id), _course_id))
      )
    );
  ELSIF _status = 'finalizado' THEN
    -- Mismos criterios que las close_*_for_course (migs 20260991000000 y
    -- 20261630000000): lo compartido con otro curso no finalizado sigue abierto.
    v_res := v_res || jsonb_build_object(
      'pendientes_calificar', public.course_pending_grading_count(_course_id),
      'a_cerrar', jsonb_build_object(
        'examenes', (SELECT count(*) FROM public.exams e
                      WHERE e.course_id = _course_id AND e.status <> 'closed' AND e.deleted_at IS NULL),
        'talleres', (SELECT count(*) FROM public.workshops w
                      WHERE w.deleted_at IS NULL AND w.status <> 'closed'
                        AND (w.course_id = _course_id OR EXISTS (
                              SELECT 1 FROM public.workshop_courses wc WHERE wc.workshop_id = w.id AND wc.course_id = _course_id))
                        AND NOT EXISTS (
                              SELECT 1 FROM public.courses c
                               WHERE c.id = ANY(public._cursos_de_taller(w.id, w.course_id))
                                 AND c.id <> _course_id AND c.deleted_at IS NULL AND c.status <> 'finalizado')),
        'proyectos', (SELECT count(*) FROM public.projects p
                      WHERE p.deleted_at IS NULL AND p.status <> 'closed'
                        AND (p.course_id = _course_id OR EXISTS (
                              SELECT 1 FROM public.project_courses pc WHERE pc.project_id = p.id AND pc.course_id = _course_id))
                        AND NOT EXISTS (
                              SELECT 1 FROM public.courses c
                               WHERE c.id = ANY(public._cursos_de_proyecto(p.id, p.course_id))
                                 AND c.id <> _course_id AND c.deleted_at IS NULL AND c.status <> 'finalizado')),
        'encuestas', (SELECT count(*) FROM public.polls p
                      WHERE p.deleted_at IS NULL AND NOT p.closed_manually
                        AND (p.course_id = _course_id OR EXISTS (
                              SELECT 1 FROM public.poll_courses pc WHERE pc.poll_id = p.id AND pc.course_id = _course_id))
                        AND NOT EXISTS (
                              SELECT 1 FROM public.courses c
                               WHERE c.id = ANY(public._cursos_de_encuesta(p.id, p.course_id))
                                 AND c.id <> _course_id AND c.deleted_at IS NULL AND c.status <> 'finalizado')),
        'pizarras', (SELECT count(*) FROM public.whiteboards w
                      WHERE w.course_id = _course_id AND w.deleted_at IS NULL
                        AND COALESCE(w.status, 'published') <> 'closed')
      )
    );
  ELSE
    -- En curso: desde borrador, lo que sigue en borrador (activar no publica
    -- nada) y si sale la bienvenida; desde finalizado, lo que sigue cerrado.
    v_res := v_res || jsonb_build_object(
      'bienvenida', COALESCE(
        (SELECT (es.enabled_kinds ->> 'course_welcome') IS DISTINCT FROM 'false'
           FROM public.email_settings es WHERE es.id = 1), true),
      'en_borrador', jsonb_build_object(
        'examenes',   (SELECT count(*) FROM public.exams e
                        WHERE e.course_id = _course_id AND e.status = 'draft' AND e.deleted_at IS NULL),
        'talleres',   (SELECT count(*) FROM public.workshops w
                        WHERE w.deleted_at IS NULL AND w.status = 'draft'
                          AND (w.course_id = _course_id OR EXISTS (
                                SELECT 1 FROM public.workshop_courses wc WHERE wc.workshop_id = w.id AND wc.course_id = _course_id))),
        'proyectos',  (SELECT count(*) FROM public.projects p
                        WHERE p.deleted_at IS NULL AND p.status = 'draft'
                          AND (p.course_id = _course_id OR EXISTS (
                                SELECT 1 FROM public.project_courses pc WHERE pc.project_id = p.id AND pc.course_id = _course_id))),
        'encuestas',  (SELECT count(*) FROM public.polls p
                        WHERE p.deleted_at IS NULL AND NOT p.is_published AND NOT p.closed_manually
                          AND (p.course_id = _course_id OR EXISTS (
                                SELECT 1 FROM public.poll_courses pc WHERE pc.poll_id = p.id AND pc.course_id = _course_id))),
        'pizarras',   (SELECT count(*) FROM public.whiteboards w
                        WHERE w.course_id = _course_id AND w.deleted_at IS NULL
                          AND COALESCE(w.is_shared_with_course, false) AND w.status = 'draft'),
        'contenidos', (SELECT count(*) FROM public.generated_contents g
                        WHERE g.deleted_at IS NULL AND NOT g.is_published AND g.status = 'done'
                          AND (g.course_id = _course_id OR EXISTS (
                                SELECT 1 FROM public.content_course_assignments cca WHERE cca.content_id = g.id AND cca.course_id = _course_id)))
      ),
      'cerrados', jsonb_build_object(
        'examenes',  (SELECT count(*) FROM public.exams e
                       WHERE e.course_id = _course_id AND e.status = 'closed' AND e.deleted_at IS NULL),
        'talleres',  (SELECT count(*) FROM public.workshops w
                       WHERE w.deleted_at IS NULL AND w.status = 'closed'
                         AND (w.course_id = _course_id OR EXISTS (
                               SELECT 1 FROM public.workshop_courses wc WHERE wc.workshop_id = w.id AND wc.course_id = _course_id))),
        'proyectos', (SELECT count(*) FROM public.projects p
                       WHERE p.deleted_at IS NULL AND p.status = 'closed'
                         AND (p.course_id = _course_id OR EXISTS (
                               SELECT 1 FROM public.project_courses pc WHERE pc.project_id = p.id AND pc.course_id = _course_id))),
        'encuestas', (SELECT count(*) FROM public.polls p
                       WHERE p.deleted_at IS NULL AND p.closed_manually
                         AND (p.course_id = _course_id OR EXISTS (
                               SELECT 1 FROM public.poll_courses pc WHERE pc.poll_id = p.id AND pc.course_id = _course_id))),
        'pizarras',  (SELECT count(*) FROM public.whiteboards w
                       WHERE w.course_id = _course_id AND w.deleted_at IS NULL AND w.status = 'closed')
      )
    );
  END IF;
  RETURN v_res;
END
$$;

-- Internas: solo las usan los triggers y la función de impacto. El REVOKE es
-- explícito para `anon` y `authenticated` porque el `FROM PUBLIC` solo no borra
-- el EXECUTE que Supabase otorga por ALTER DEFAULT PRIVILEGES. Las funciones de
-- trigger siguen el precedente del repo (PUBLIC y anon): no se pueden invocar
-- por RPC, así que quitárselas a `authenticated` no protege nada.
REVOKE ALL ON FUNCTION public._solo_cursos_en_borrador(uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._nombre_curso_en_borrador(uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cursos_de_taller(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cursos_de_proyecto(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cursos_de_encuesta(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._cursos_de_contenido(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._examenes_a_borrador(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._talleres_a_borrador(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._proyectos_a_borrador(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._encuestas_solo_en_borrador(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._encuestas_a_borrador(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._retos_en_vivo_a_terminar(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._pizarras_a_borrador(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._contenidos_a_borrador(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_cascade_borrador_curso() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_bloquear_publicar_examen() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_bloquear_publicar_taller() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_bloquear_publicar_proyecto() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_bloquear_publicar_encuesta() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_bloquear_publicar_pizarra() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.tg_bloquear_publicar_contenido() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.impacto_cambio_estado_curso(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.impacto_cambio_estado_curso(uuid, text) TO authenticated;

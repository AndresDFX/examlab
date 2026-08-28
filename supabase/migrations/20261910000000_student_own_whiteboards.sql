-- ══════════════════════════════════════════════════════════════════════════
-- El estudiante puede tener sus PROPIAS pizarras.
--
-- ── Qué faltaba, exactamente ──────────────────────────────────────────────
-- Nada en la base: `whiteboards_owner_write` (mig 20261061) ya es FOR ALL con
-- `owner_id = auth.uid()` en USING y en WITH CHECK, así que un estudiante YA
-- podía insertar, editar y borrar filas propias; y `whiteboards_select` ya las
-- devuelve por la misma rama. Lo que no existía era la interfaz. El comentario
-- de `/app/student/whiteboards` decía "INSERT/UPDATE/DELETE quedan bloqueados"
-- y era falso desde esa migración.
--
-- ── Por qué entonces hay una migración ────────────────────────────────────
-- Porque abrir la interfaz sin cerrar esto sería regalar un canal de
-- publicación. Con la RLS actual, el dueño de una fila puede escribir CUALQUIER
-- columna de esa fila, y dos de ellas no son suyas:
--
--   * `is_shared_with_course`: ponerla en true, con un `course_id` de un curso
--     donde el estudiante está matriculado, hace que la rama "compartida" de
--     `whiteboards_select` se la muestre a TODOS sus compañeros. O sea: el
--     alumno podría publicarle contenido arbitrario —dibujos, texto libre— a
--     todo el curso, sin que el docente lo autorice ni se entere.
--   * `attendance_session_id`: es el vínculo de la pizarra de una CLASE, que
--     abre el flujo de pizarra compartida en vivo de esa sesión.
--
-- Es la misma clase de agujero que ya se cerró en `project_submission_video_views`
-- y en `support_tickets`: RLS de dueño + columnas que el dueño no debería tocar.
-- Y como allá, el arreglo va por TRIGGER y no por RLS: la RLS de Postgres decide
-- sobre la fila entera, no por columna, así que no puede expresar "podés escribir
-- tu fila salvo estas dos columnas".
--
-- ── Qué NO se le prohíbe, y por qué ───────────────────────────────────────
-- Sí puede poner `course_id` de un curso donde ESTÉ MATRICULADO. No es un
-- descuido: es lo que hace útil la función. `whiteboards_select` tiene una rama
-- por `course_teachers`, así que atar la pizarra a un curso se la deja ver al
-- DOCENTE de ese curso — y no a los compañeros. Eso convierte la pizarra en la
-- forma de decir "profe, mire mi borrador del diagrama". La interfaz lo dice con
-- todas las letras al elegir el curso; una regla que el usuario no ve se siente
-- como una filtración aunque sea intencional.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._tg_whiteboard_student_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_uid UUID := auth.uid();
  v_es_staff BOOLEAN;
BEGIN
  -- Sin sesión de usuario no hay a quién restringir: es el service_role (edges,
  -- cron, esta misma migración). Si se guardara acá, la cascada de cierre de
  -- curso y cualquier backfill dejarían de funcionar.
  IF v_uid IS NULL THEN
    RETURN NEW;
  END IF;

  -- "Staff" es respecto de ESTA pizarra, no en general: el SuperAdmin, el Admin
  -- de la institución dueña, y el docente del curso al que se la quiere atar.
  -- Ojo: se evalúa contra NEW.course_id, así que un docente que intente
  -- compartir con un curso que NO dicta cae del lado del estudiante. Eso es
  -- deliberado y coincide con el alcance por curso del rol docente
  -- (src/modules/courses/course-scope.ts).
  v_es_staff :=
    public.is_super_admin()
    OR (public.has_role(v_uid, 'Admin'::public.app_role)
        AND NEW.tenant_id IS NOT DISTINCT FROM public.current_tenant_id())
    OR (NEW.course_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM public.course_teachers ct
           WHERE ct.course_id = NEW.course_id AND ct.user_id = v_uid));

  IF v_es_staff THEN
    RETURN NEW;
  END IF;

  -- ── De acá para abajo, el que escribe no es staff de esta pizarra ────────

  -- Nadie crea una pizarra a nombre de otro. La RLS ya lo cubre para el caso
  -- normal; acá queda explícito para que un cambio futuro de policy no lo
  -- reabra en silencio.
  IF NEW.owner_id IS DISTINCT FROM v_uid THEN
    RAISE EXCEPTION 'Solo podés crear o editar tus propias pizarras.';
  END IF;

  -- Compartir con el curso es del docente. Se compara contra OLD en UPDATE para
  -- no rebotar un guardado normal de una pizarra que YA estaba compartida (por
  -- ejemplo, si el docente compartió una y después le cambió el dueño).
  IF COALESCE(NEW.is_shared_with_course, FALSE)
     AND (TG_OP = 'INSERT' OR NOT COALESCE(OLD.is_shared_with_course, FALSE)) THEN
    RAISE EXCEPTION 'Compartir una pizarra con todo el curso lo hace el docente. La tuya es personal: si la asociás a un curso, la ve el docente de ese curso.';
  END IF;

  -- El vínculo con una sesión de clase también es del docente.
  IF NEW.attendance_session_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.attendance_session_id IS DISTINCT FROM NEW.attendance_session_id) THEN
    RAISE EXCEPTION 'Asociar una pizarra a una sesión de clase lo hace el docente.';
  END IF;

  -- Un curso ajeno no se puede elegir: sin esto, atarla a cualquier curso de la
  -- institución se la mostraría al docente de ese curso.
  IF NEW.course_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.course_id IS DISTINCT FROM NEW.course_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.course_enrollments ce
        WHERE ce.course_id = NEW.course_id AND ce.user_id = v_uid
     ) THEN
    RAISE EXCEPTION 'Solo podés asociar la pizarra a un curso en el que estés matriculado.';
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public._tg_whiteboard_student_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public._tg_whiteboard_student_guard() FROM anon;

DO $$
BEGIN
  IF to_regclass('public.whiteboards') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_whiteboard_student_guard ON public.whiteboards;
    CREATE TRIGGER trg_whiteboard_student_guard
      BEFORE INSERT OR UPDATE ON public.whiteboards
      FOR EACH ROW EXECUTE FUNCTION public._tg_whiteboard_student_guard();
  END IF;
END $$;

-- No se toca `module_visibility`: el módulo de pizarras ya está habilitado para
-- el Estudiante en la fila default y en los 6 tenants (verificado por REST antes
-- de escribir esto). Lo que el estudiante no tenía era qué hacer ahí, no permiso
-- para entrar.

NOTIFY pgrst, 'reload schema';

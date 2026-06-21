-- ════════════════════════════════════════════════════════════════════
-- Cascade de CIERRE al finalizar un curso.
--
-- Cuando un curso pasa a `status='finalizado'` (por el RPC set_course_status
-- O por el cron auto_finalize_courses — ambos hacen UPDATE courses.status),
-- todo lo asociado al curso pasa a su estado CERRADO. Así, sobre todo para
-- VISUALIZACIÓN, lo cerrado desaparece de los listados activos por defecto
-- (exámenes/talleres/proyectos/pizarras ya ocultan `closed` con
-- matchesActivityStatus; las encuestas via su filtro de estado).
--
-- DISEÑO (workflow course-close-cascade): UN trigger AFTER UPDATE OF status
-- sobre courses, guard `WHEN NEW='finalizado' AND OLD IS DISTINCT FROM
-- 'finalizado'` (solo la TRANSICIÓN dispara; no re-dispara en re-finalizar) →
-- llama a funciones helper `close_*_for_course`, una por entidad.
--
-- VOCABULARIOS: el CURSO es terminal en 'finalizado'; las hijas en 'closed'
-- (draft|published|closed) salvo polls que usan `closed_manually=TRUE`. El
-- caveat M:N siempre compara `courses.status <> 'finalizado'`.
--
-- M:N (workshops/projects/polls): un item ligado a >1 curso se cierra SOLO si
-- NINGÚN otro curso ligado (junction O course_id ancla/legacy) sigue activo
-- (`<> 'finalizado'` y no en papelera). Un curso en papelera NO cuenta como
-- activo.
--
-- NO auto-reabre: la transición finalizado→en_curso NO dispara nada (no
-- guardamos el estado previo de cada hijo; reabrir es granular y deliberado).
--
-- SEGURIDAD: las funciones son SECURITY DEFINER (bypassan RLS — necesario para
-- el cron sin auth.uid() y para tocar items M:N de cursos que el caller no
-- posee). Por eso se REVOCA EXECUTE de PUBLIC: son INTERNAS (solo el trigger
-- las invoca). Sin el REVOKE, cualquier authenticated podría cerrar contenido
-- de OTRO curso/tenant llamándolas directo.
--
-- Defensiva Lovable: cada `close_*` arranca con guard `to_regclass` y el
-- CREATE TRIGGER va envuelto en un DO con guard sobre `courses`.
-- ════════════════════════════════════════════════════════════════════

-- ── 1.1 exams — FK directa 1:1 (exams.course_id). Sin M:N. ──────────
CREATE OR REPLACE FUNCTION public.close_exams_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0;
BEGIN
  IF to_regclass('public.exams') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.exams
       SET status = 'closed', updated_at = now()
     WHERE course_id = _course_id
       AND status <> 'closed'
       AND deleted_at IS NULL
       AND COALESCE(is_external, false) = false  -- externos solo registran nota
    RETURNING id
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_exams_for_course(uuid) FROM PUBLIC;

-- ── 1.2 workshops — M:N (workshop_courses) + course_id legacy ───────
CREATE OR REPLACE FUNCTION public.close_workshops_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0;
BEGIN
  IF to_regclass('public.workshops') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.workshops w
       SET status = 'closed', updated_at = now()
     WHERE w.deleted_at IS NULL
       AND w.status <> 'closed'
       AND COALESCE(w.is_external, false) = false
       AND w.id IN (
         SELECT workshop_id FROM public.workshop_courses WHERE course_id = _course_id
         UNION
         SELECT id FROM public.workshops WHERE course_id = _course_id
       )
       -- caveat M:N: ningún OTRO curso (junction) sigue activo
       AND NOT EXISTS (
         SELECT 1 FROM public.workshop_courses wc
           JOIN public.courses c ON c.id = wc.course_id
          WHERE wc.workshop_id = w.id AND wc.course_id <> _course_id
            AND c.deleted_at IS NULL AND c.status <> 'finalizado')
       -- idem para el course_id legacy si difiere y sigue activo
       AND NOT EXISTS (
         SELECT 1 FROM public.courses c
          WHERE c.id = w.course_id AND c.id <> _course_id
            AND c.deleted_at IS NULL AND c.status <> 'finalizado')
    RETURNING w.id
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_workshops_for_course(uuid) FROM PUBLIC;

-- ── 1.3 projects — M:N (project_courses) + course_id ancla ──────────
CREATE OR REPLACE FUNCTION public.close_projects_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0; rec record;
BEGIN
  IF to_regclass('public.projects') IS NULL THEN RETURN 0; END IF;
  FOR rec IN
    SELECT DISTINCT p.id FROM public.projects p
      LEFT JOIN public.project_courses pc ON pc.project_id = p.id
     WHERE (pc.course_id = _course_id OR p.course_id = _course_id)
       AND p.deleted_at IS NULL
       AND COALESCE(p.is_external, false) = false
       AND p.status <> 'closed'
  LOOP
    -- caveat M:N (junction + ancla): si algún OTRO curso ligado sigue activo, saltar.
    IF EXISTS (
      SELECT 1 FROM public.project_courses pc2
        JOIN public.courses c ON c.id = pc2.course_id
       WHERE pc2.project_id = rec.id AND pc2.course_id <> _course_id
         AND c.deleted_at IS NULL AND c.status <> 'finalizado'
    ) OR EXISTS (
      SELECT 1 FROM public.projects p2
        JOIN public.courses c ON c.id = p2.course_id
       WHERE p2.id = rec.id AND p2.course_id <> _course_id
         AND c.deleted_at IS NULL AND c.status <> 'finalizado'
    ) THEN CONTINUE; END IF;
    UPDATE public.projects SET status = 'closed', updated_at = now()
     WHERE id = rec.id AND status <> 'closed';
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_projects_for_course(uuid) FROM PUBLIC;

-- ── 1.4 whiteboards — FK directa 1:1 (whiteboards.course_id) ────────
CREATE OR REPLACE FUNCTION public.close_whiteboards_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0;
BEGIN
  IF to_regclass('public.whiteboards') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.whiteboards
       SET status = 'closed'
     WHERE course_id = _course_id
       AND deleted_at IS NULL
       AND COALESCE(status, 'published') <> 'closed'
    RETURNING id
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_whiteboards_for_course(uuid) FROM PUBLIC;

-- ── 1.5 polls / Kahoot — M:N (poll_courses) + course_id ancla ──────
-- Cierre = closed_manually=TRUE (mecanismo deliberado del docente). Termina
-- también juegos Kahoot en vivo de esas encuestas.
-- NOTA: una poll con results_visible_to_students='after_close' REVELA los
-- conteos al alumno al cerrarse. En un curso FINALIZADO esto es esperable
-- (el curso terminó); se documenta como comportamiento deliberado.
CREATE OR REPLACE FUNCTION public.close_polls_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0;
BEGIN
  IF to_regclass('public.polls') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.polls p
       SET closed_manually = TRUE, updated_at = now()
     WHERE p.deleted_at IS NULL
       AND NOT p.closed_manually
       AND ( p.course_id = _course_id
             OR EXISTS (SELECT 1 FROM public.poll_courses pc
                         WHERE pc.poll_id = p.id AND pc.course_id = _course_id) )
       -- caveat M:N: ningún OTRO curso ligado (ancla o junction) sigue activo
       AND NOT EXISTS (
         SELECT 1 FROM (
           SELECT p.course_id AS course_id
           UNION
           SELECT pc2.course_id FROM public.poll_courses pc2 WHERE pc2.poll_id = p.id
         ) linked
         JOIN public.courses c ON c.id = linked.course_id
        WHERE linked.course_id <> _course_id
          AND c.deleted_at IS NULL AND c.status <> 'finalizado')
    RETURNING p.id
  ) SELECT count(*) INTO v_count FROM upd;

  -- Terminar juegos Kahoot en vivo cuyas encuestas quedaron cerradas.
  IF to_regclass('public.kahoot_games') IS NOT NULL THEN
    UPDATE public.kahoot_games g SET status = 'ended'
     WHERE g.status <> 'ended'
       AND EXISTS (SELECT 1 FROM public.polls p
                    WHERE p.id = g.poll_id AND p.closed_manually = TRUE
                      AND p.deleted_at IS NULL);
  END IF;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_polls_for_course(uuid) FROM PUBLIC;

-- ── 1.6 forums — FK directa 1:1. Cerrar = manually_closed_at=now() ──
-- Cerrar un foro BLOQUEA postear nuevas preguntas/respuestas (el predicado
-- is_forum_open lo respeta en las 3 capas) pero el historial se SIGUE LEYENDO.
-- Cierra la brecha "el alumno puede seguir posteando en un curso finalizado".
CREATE OR REPLACE FUNCTION public.close_forums_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0; v_now timestamptz := now();
BEGIN
  IF to_regclass('public.forums') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.forums f
       SET manually_closed_at = v_now, updated_at = v_now
     WHERE f.course_id = _course_id
       AND f.manually_closed_at IS NULL
       AND (f.opens_at  IS NULL OR f.opens_at  <= v_now)
       AND (f.closes_at IS NULL OR f.closes_at >  v_now)
    RETURNING f.id
  ) SELECT count(*) INTO v_count FROM upd;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_forums_for_course(uuid) FROM PUBLIC;

-- ── 1.7 check-in de asistencia — NO cierra/borra sesiones (su histórico
-- es necesario para el cálculo de notas por corte). Solo cierra ventanas de
-- check-in QR que hubieran quedado abiertas (no dejar un QR vivo en un curso
-- finalizado). No destructivo, idempotente.
CREATE OR REPLACE FUNCTION public.close_checkin_for_course(_course_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_count int := 0;
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN RETURN 0; END IF;
  WITH upd AS (
    UPDATE public.attendance_sessions
       SET check_in_open = false
     WHERE course_id = _course_id
       AND check_in_open = true
       AND deleted_at IS NULL
    RETURNING id
  ) SELECT count(*) INTO v_count FROM upd;
  IF to_regclass('public.attendance_check_in_state') IS NOT NULL THEN
    DELETE FROM public.attendance_check_in_state
     WHERE session_id IN (SELECT id FROM public.attendance_sessions WHERE course_id = _course_id);
  END IF;
  RETURN v_count;
END $fn$;
REVOKE ALL ON FUNCTION public.close_checkin_for_course(uuid) FROM PUBLIC;

-- ── Orquestador del trigger ─────────────────────────────────────────
-- ROBUSTEZ (blast radius): el cascade corre SÍNCRONO dentro de la tx que
-- finaliza el curso (set_course_status manual o el cron auto_finalize_courses,
-- que finaliza varios cursos por statement). El cierre en cascada es
-- "best-effort de visualización", NO una invariante dura: finalizar el curso
-- DEBE tener éxito aunque una sub-tarea falle. Por eso cada paso va en su
-- propio BEGIN/EXCEPTION — un fallo en una entidad no bloquea la finalización
-- ni impide cerrar las demás. Mantiene el subtransaction savepoint por paso.
CREATE OR REPLACE FUNCTION public.tg_cascade_close_on_course_finalized()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  BEGIN PERFORM public.close_exams_for_course(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cascade close_exams curso %: %', NEW.id, SQLERRM; END;
  BEGIN PERFORM public.close_workshops_for_course(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cascade close_workshops curso %: %', NEW.id, SQLERRM; END;
  BEGIN PERFORM public.close_projects_for_course(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cascade close_projects curso %: %', NEW.id, SQLERRM; END;
  BEGIN PERFORM public.close_whiteboards_for_course(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cascade close_whiteboards curso %: %', NEW.id, SQLERRM; END;
  BEGIN PERFORM public.close_polls_for_course(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cascade close_polls curso %: %', NEW.id, SQLERRM; END;
  BEGIN PERFORM public.close_forums_for_course(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cascade close_forums curso %: %', NEW.id, SQLERRM; END;
  BEGIN PERFORM public.close_checkin_for_course(NEW.id);
  EXCEPTION WHEN OTHERS THEN RAISE WARNING 'cascade close_checkin curso %: %', NEW.id, SQLERRM; END;
  RETURN NULL;  -- AFTER trigger: el retorno se ignora
END $fn$;

-- ── Trigger: solo en la TRANSICIÓN hacia 'finalizado' ───────────────
DO $$
BEGIN
  IF to_regclass('public.courses') IS NULL THEN
    RAISE NOTICE 'skip cascade trigger: tabla courses ausente';
    RETURN;
  END IF;
  DROP TRIGGER IF EXISTS trg_cascade_close_on_course_finalized ON public.courses;
  CREATE TRIGGER trg_cascade_close_on_course_finalized
    AFTER UPDATE OF status ON public.courses
    FOR EACH ROW
    WHEN (NEW.status = 'finalizado' AND OLD.status IS DISTINCT FROM 'finalizado')
    EXECUTE FUNCTION public.tg_cascade_close_on_course_finalized();
END $$;

NOTIFY pgrst, 'reload schema';

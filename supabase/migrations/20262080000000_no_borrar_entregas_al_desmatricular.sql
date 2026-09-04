-- ══════════════════════════════════════════════════════════════════════════
-- Desmatricular a un alumno NO puede destruir lo que ya entregó.
--
-- ── Lo que hacía ─────────────────────────────────────────────────────────
-- `tg_cleanup_unenrolled_student` (20260958000000) borra, al quitar una matrícula,
-- las asignaciones y las entregas SIN NOTA del alumno en ese curso. El filtro era
-- solo la nota: `ai_grade IS NULL AND final_override_grade IS NULL`. Nunca miró si
-- la entrega EXISTÍA de verdad.
--
-- Consecuencia: una entrega hecha —con sus respuestas dentro del JSONB `answers`, y
-- en un caso con los eventos de proctoring del examen— desaparecía **físicamente**
-- porque el docente todavía no la había calificado. `submissions` no está en el
-- conjunto de la papelera, así que no hay restaurar: solo un respaldo de la base.
--
-- Y el disparador es un clic. «Deseleccionar todos» en el diálogo de estudiantes
-- llama `unenrollMany` sin confirmación, con el mismo tamaño y la misma variante que
-- «Seleccionar todos», pegado al lado. Medido en producción al escribir esto: las 3
-- únicas entregas de examen entregadas y sin nota, y 3 entregas de taller
-- individuales sin nota, pertenecen a alumnos MATRICULADOS en el curso de la
-- actividad. Las 6 se borraban.
--
-- ── El arreglo, y por qué acá y no solo en la pantalla ────────────────────
-- Se agrega `submitted_at IS NULL` a los tres DELETE de entregas. El objetivo
-- declarado de la migración original es que esas filas dejen de CONTARSE como
-- pendientes en los tableros del docente, y para eso alcanza con borrar el
-- *assignment* —que se sigue borrando igual—. Una entrega ya hecha no es un
-- pendiente: es trabajo del alumno.
--
-- Va en el trigger y no solo en un `confirm()` del cliente porque el borrado ocurre
-- en la BASE: lo dispara cualquier DELETE sobre `course_enrollments`, venga de la
-- pantalla de Cursos, de la de Usuarios, de un script, de una RPC o del SQL Editor.
-- Un diálogo protege un camino; el guard protege todos.
--
-- Lo que se sigue borrando (a propósito): las entregas ARRANCADAS y nunca enviadas
-- (`submitted_at IS NULL`), que es el caso que la migración original quería limpiar
-- — un intento en curso de alguien que ya no está en el curso.
-- ══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'course_enrollments no existe en este entorno; nada que hacer.';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.tg_cleanup_unenrolled_student()
  RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $fn$
  DECLARE
    _uid UUID := OLD.user_id;
    _cid UUID := OLD.course_id;
  BEGIN
    IF _uid IS NULL OR _cid IS NULL THEN
      RETURN OLD;
    END IF;

    -- ── EXÁMENES (course_id directo) ──
    DELETE FROM public.exam_assignments ea
     USING public.exams e
     WHERE ea.exam_id = e.id AND e.course_id = _cid AND ea.user_id = _uid;

    DELETE FROM public.submissions s
     USING public.exams e
     WHERE s.exam_id = e.id AND e.course_id = _cid AND s.user_id = _uid
       -- Solo intentos NUNCA enviados. Con la entrega hecha, la fila se conserva
       -- aunque no tenga nota: el assignment de arriba ya la saca de los pendientes.
       AND s.submitted_at IS NULL
       AND s.ai_grade IS NULL AND s.final_override_grade IS NULL;

    -- ── TALLERES (M:N vía workshop_courses) ──
    -- Solo si el taller NO está en otro curso donde el user sigue matriculado.
    DELETE FROM public.workshop_assignments wa
     USING public.workshop_courses wc
     WHERE wa.workshop_id = wc.workshop_id AND wc.course_id = _cid AND wa.user_id = _uid
       AND NOT EXISTS (
         SELECT 1 FROM public.workshop_courses wc2
          JOIN public.course_enrollments ce2 ON ce2.course_id = wc2.course_id
         WHERE wc2.workshop_id = wa.workshop_id AND ce2.user_id = _uid
       );

    DELETE FROM public.workshop_submissions ws
     USING public.workshop_courses wc
     WHERE ws.workshop_id = wc.workshop_id AND wc.course_id = _cid AND ws.user_id = _uid
       AND ws.group_id IS NULL
       AND ws.submitted_at IS NULL
       AND ws.final_grade IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.workshop_courses wc2
          JOIN public.course_enrollments ce2 ON ce2.course_id = wc2.course_id
         WHERE wc2.workshop_id = ws.workshop_id AND ce2.user_id = _uid
       );

    -- ── PROYECTOS (M:N vía project_courses) ──
    DELETE FROM public.project_assignments pa
     USING public.project_courses pc
     WHERE pa.project_id = pc.project_id AND pc.course_id = _cid AND pa.user_id = _uid
       AND NOT EXISTS (
         SELECT 1 FROM public.project_courses pc2
          JOIN public.course_enrollments ce2 ON ce2.course_id = pc2.course_id
         WHERE pc2.project_id = pa.project_id AND ce2.user_id = _uid
       );

    DELETE FROM public.project_submissions ps
     USING public.project_courses pc
     WHERE ps.project_id = pc.project_id AND pc.course_id = _cid AND ps.user_id = _uid
       AND ps.group_id IS NULL
       AND ps.submitted_at IS NULL
       AND ps.final_grade IS NULL
       AND ps.submission_grade IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM public.project_courses pc2
          JOIN public.course_enrollments ce2 ON ce2.course_id = pc2.course_id
         WHERE pc2.project_id = ps.project_id AND ce2.user_id = _uid
       );

    RETURN OLD;
  END
  $fn$;
END $$;

-- ── Cuántas entregas se perderían si se desmatricula a alguien ────────────
-- La usa el diálogo de estudiantes para decir, ANTES de confirmar, qué trabajo se va
-- a destruir. Sin un número concreto, un «¿seguro?» sobre una acción masiva se
-- responde que sí por reflejo.
--
-- Cuenta con el MISMO criterio que el trigger de arriba (intentos sin enviar), así
-- que el número que se muestra es el que de verdad se va a borrar. Si el criterio
-- cambia en un lado y no en el otro, el diálogo miente — por eso los dos viven en
-- este archivo.
CREATE OR REPLACE FUNCTION public.count_unenroll_losses(_course_id uuid, _user_ids uuid[])
RETURNS int
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
  SELECT (
    (SELECT count(*) FROM public.submissions s
       JOIN public.exams e ON e.id = s.exam_id
      WHERE e.course_id = _course_id AND s.user_id = ANY(_user_ids)
        AND s.submitted_at IS NULL
        AND s.ai_grade IS NULL AND s.final_override_grade IS NULL)
  + (SELECT count(*) FROM public.workshop_submissions ws
       JOIN public.workshop_courses wc ON wc.workshop_id = ws.workshop_id
      WHERE wc.course_id = _course_id AND ws.user_id = ANY(_user_ids)
        AND ws.group_id IS NULL AND ws.submitted_at IS NULL AND ws.final_grade IS NULL)
  + (SELECT count(*) FROM public.project_submissions ps
       JOIN public.project_courses pc ON pc.project_id = ps.project_id
      WHERE pc.course_id = _course_id AND ps.user_id = ANY(_user_ids)
        AND ps.group_id IS NULL AND ps.submitted_at IS NULL
        AND ps.final_grade IS NULL AND ps.submission_grade IS NULL)
  )::int;
$$;

REVOKE ALL ON FUNCTION public.count_unenroll_losses(uuid, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.count_unenroll_losses(uuid, uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.count_unenroll_losses(uuid, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

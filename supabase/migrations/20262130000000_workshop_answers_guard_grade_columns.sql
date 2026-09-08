-- ══════════════════════════════════════════════════════════════════════
-- CRÍTICO — el candado de las notas se puso en la cabecera y se olvidó de la
-- tabla HIJA: hoy un estudiante puede ponerse la nota que quiera POR PREGUNTA.
--
-- La migración 20261034000000 cerró el vector sobre `submissions`,
-- `workshop_submissions` y `project_submissions` (un alumno PATCHeando su propia
-- entrega vía REST para auto-asignarse un 5,0). Pero las notas por pregunta de
-- un taller viven en `workshop_submission_answers`, esa tabla quedó SIN trigger,
-- y su RLS de UPDATE/INSERT es "el dueño de la entrega o miembro del grupo o
-- staff" — a nivel FILA, no columna, con GRANT sobre todas las columnas. Así que:
--
--   PATCH /rest/v1/workshop_submission_answers?id=eq.<la_suya>
--   { "ai_grade": 999 }
--
-- lo escribe el alumno con su propio JWT. Y no es un vector teórico: hasta hoy
-- ESE upsert era exactamente el camino normal del producto — el edge de IA
-- devolvía los puntajes y los persistía el NAVEGADOR del alumno.
--
-- Por qué importa más de lo que parece: la nota de la cabecera se calcula
-- sumando estas filas. O sea que consolidar "del lado del servidor" leyendo esta
-- tabla no protege NADA mientras el alumno pueda escribirla — la protección
-- server-side sería teatro. Este candado es lo que la vuelve real, y va junto
-- con el cambio que mueve la persistencia al edge (que escribe con service_role
-- y por eso pasa por el early-return de `auth.uid() IS NULL`).
--
-- ── Qué se protege y qué NO ────────────────────────────────────────────
-- PROTEGIDO (lo escribe la IA o el docente): ai_grade, ai_feedback,
--   ai_likelihood, ai_reasons, ai_detected, ai_detected_score,
--   ai_detected_reasons, ai_review_at, ai_review_by, zip_truncated,
--   zip_chars_used.
-- LIBRE (es la respuesta del alumno, y bloquearla sería peor que el bug que
--   arreglamos: lo dejaría sin poder ni contestar): answer_text,
--   selected_option, code_content, diagram_code, zip_path, code_paths.
-- Fast-path: si el INSERT/UPDATE no toca ninguna columna protegida, retorna sin
-- consultar roles — el guardado normal de una respuesta no paga el join.
--
-- ── La trampa del INSERT, que casi rompe todas las entregas ────────────
-- En INSERT no hay OLD, así que hay que mirar el valor entrante. Pero
-- `ai_detected` es **boolean NOT NULL DEFAULT false** (mig 20260426043929), o
-- sea que en un INSERT normal llega en `false`, NO en NULL: un chequeo
-- `IS NOT NULL` daría verdadero para CUALQUIER fila y habría bloqueado a todos
-- los alumnos al guardar su respuesta. Por eso esa columna se compara con
-- `IS TRUE` y las demás —todas nullable sin default— con `IS NOT NULL`.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_guard_workshop_answer_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema (el edge de IA)

  IF TG_OP = 'INSERT' THEN
    -- Ver la nota de la cabecera: `ai_detected` tiene DEFAULT false, así que
    -- acá va `IS TRUE` y no `IS NOT NULL`.
    v_touch :=
         NEW.ai_grade            IS NOT NULL
      OR NEW.ai_feedback         IS NOT NULL
      OR NEW.ai_likelihood       IS NOT NULL
      OR NEW.ai_reasons          IS NOT NULL
      OR NEW.ai_detected         IS TRUE
      OR NEW.ai_detected_score   IS NOT NULL
      OR NEW.ai_detected_reasons IS NOT NULL
      OR NEW.ai_review_at        IS NOT NULL
      OR NEW.ai_review_by        IS NOT NULL
      OR NEW.zip_truncated       IS NOT NULL
      OR NEW.zip_chars_used      IS NOT NULL;
  ELSE
    v_touch :=
         NEW.ai_grade            IS DISTINCT FROM OLD.ai_grade
      OR NEW.ai_feedback         IS DISTINCT FROM OLD.ai_feedback
      OR NEW.ai_likelihood       IS DISTINCT FROM OLD.ai_likelihood
      OR NEW.ai_reasons          IS DISTINCT FROM OLD.ai_reasons
      OR NEW.ai_detected         IS DISTINCT FROM OLD.ai_detected
      OR NEW.ai_detected_score   IS DISTINCT FROM OLD.ai_detected_score
      OR NEW.ai_detected_reasons IS DISTINCT FROM OLD.ai_detected_reasons
      OR NEW.ai_review_at        IS DISTINCT FROM OLD.ai_review_at
      OR NEW.ai_review_by        IS DISTINCT FROM OLD.ai_review_by
      OR NEW.zip_truncated       IS DISTINCT FROM OLD.zip_truncated
      OR NEW.zip_chars_used      IS DISTINCT FROM OLD.zip_chars_used;
  END IF;

  IF NOT v_touch THEN RETURN NEW; END IF;

  -- Staff = docente del curso del taller, o Admin/SuperAdmin del tenant de ese
  -- curso. Se llega por la FK: answer → workshop_submissions → workshops →
  -- courses. `is_admin_of_course_tenant` ya cubre a SuperAdmin.
  SELECT EXISTS (
    SELECT 1
      FROM public.workshop_submissions ws
      JOIN public.workshops w  ON w.id = ws.workshop_id
      JOIN public.course_teachers ct ON ct.course_id = w.course_id
     WHERE ws.id = NEW.submission_id
       AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1
      FROM public.workshop_submissions ws
      JOIN public.workshops w ON w.id = ws.workshop_id
     WHERE ws.id = NEW.submission_id
       AND public.is_admin_of_course_tenant(w.course_id)
  ) INTO v_is_staff;

  IF v_is_staff THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación o los metadatos de revisión de una respuesta';
END
$$;

REVOKE ALL ON FUNCTION public.tg_guard_workshop_answer_grade() FROM PUBLIC;

-- Trigger idempotente, guardado por to_regclass por si la tabla no existe en un
-- entorno a medio migrar (misma defensiva que 20261034000000).
DO $$ BEGIN
  IF to_regclass('public.workshop_submission_answers') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_workshop_answer_grade ON public.workshop_submission_answers;
    CREATE TRIGGER trg_guard_workshop_answer_grade
      BEFORE INSERT OR UPDATE ON public.workshop_submission_answers
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_workshop_answer_grade();
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

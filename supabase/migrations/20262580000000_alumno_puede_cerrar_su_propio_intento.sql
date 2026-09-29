-- El candado de la 20262410000000 bloquea la SUSPENSIÓN por advertencias.
--
-- ── Qué pasó, medido en producción ───────────────────────────────────────
--
-- Esa migración sumó las cuatro marcas de cierre (`closed_at`, `closed_by`,
-- `close_reason`, `close_deadline`) a `tg_guard_exam_submission_grade`, y con
-- razón: sin eso el alumno reabría su propio examen terminado por REST, todas
-- las veces que quisiera. El agujero era real y queda cerrado.
--
-- Pero la condición se escribió con `IS DISTINCT FROM`, que es SIMÉTRICO:
-- atrapa quitarlas —que es reabrir, y es lo que se quería prohibir— y también
-- PONERLAS. Y ponerlas es justo lo que hace el propio navegador del alumno
-- cuando se pasa del tope de advertencias: `performSubmit(markSuspicious)`
-- escribe `status='completado'` junto con `closed_at` / `close_reason` /
-- `closed_by`. El alumno no es staff, así que el trigger lanza
-- «No autorizado…», el UPDATE falla, el cliente reintenta dos veces, y al
-- fallar RESTAURA `submittedRef=false` para no dejar a nadie con un spinner
-- eterno. Resultado: el examen sigue abierto y el contador sigue subiendo.
--
-- Evidencia (2026-09-28, sobre un parcial en curso de UNIAJ):
--   · La última suspensión por advertencias de toda la historia de producción
--     es del 2026-09-23T03:22Z. El candado entró ese mismo día, 19:34Z.
--     CERO suspensiones en los cinco días siguientes.
--   · En ese parcial hubo intentos con 4 y con 7 advertencias sobre un tope de
--     3, todos en `en_progreso`, y 17 borrados manuales de advertencias en 50
--     minutos: el docente se pasó el examen limpiando a mano lo que el sistema
--     tenía que haber cerrado solo.
--
-- ── La regla correcta ────────────────────────────────────────────────────
--
-- CERRAR el intento propio y REABRIRLO no son la misma operación, aunque toquen
-- las mismas columnas:
--
--   · Poner las marcas desde NULL, sobre la fila propia, dejando de estar
--     `en_progreso` y firmando con el propio uid → es el alumno cerrándose. Se
--     permite; es lo que el proctoring necesita para funcionar.
--   · Cualquier otra cosa sobre esas columnas —limpiarlas, cambiarlas, firmar
--     con el uid de otro— sigue siendo staff. Ahí vive el agujero que la
--     20262410000000 cerró y que NO se reabre.
--
-- Se separan las dos familias de columnas en dos banderas: las de NOTA y
-- revisión (que el alumno no puede tocar NUNCA, ni siquiera de paso) y las de
-- CIERRE (que puede poner una sola vez, sobre sí mismo). Mezclarlas en una sola
-- condición es lo que produjo este bug, y volver a mezclarlas lo reproduce.
DO $mig$ BEGIN
  IF to_regclass('public.submissions') IS NULL THEN
    RAISE NOTICE 'submissions no existe en este entorno: se omite';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.tg_guard_exam_submission_grade()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $fn$
  DECLARE
    v_uid uuid := auth.uid();
    v_toca_notas boolean;
    v_toca_cierre boolean;
    v_cierre_propio boolean;
    v_is_staff boolean;
  BEGIN
    IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema

    -- Nota y metadatos de revisión: intocables para quien no sea staff.
    v_toca_notas :=
         NEW.final_override_grade IS DISTINCT FROM OLD.final_override_grade
      OR NEW.ai_grade             IS DISTINCT FROM OLD.ai_grade
      OR NEW.ai_detected          IS DISTINCT FROM OLD.ai_detected
      OR NEW.ai_detected_score    IS DISTINCT FROM OLD.ai_detected_score
      OR NEW.ai_detected_reasons  IS DISTINCT FROM OLD.ai_detected_reasons
      OR NEW.ai_review_at         IS DISTINCT FROM OLD.ai_review_at
      OR NEW.ai_review_by         IS DISTINCT FROM OLD.ai_review_by
      OR NEW.teacher_feedback     IS DISTINCT FROM OLD.teacher_feedback
      OR NEW.extra_seconds        IS DISTINCT FROM OLD.extra_seconds
      OR NEW.status = 'calificado'
      OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status);

    -- Marcas de cierre.
    v_toca_cierre :=
         NEW.closed_at      IS DISTINCT FROM OLD.closed_at
      OR NEW.closed_by      IS DISTINCT FROM OLD.closed_by
      OR NEW.close_reason   IS DISTINCT FROM OLD.close_reason
      OR NEW.close_deadline IS DISTINCT FROM OLD.close_deadline;

    -- El alumno cerrándose a sí mismo. `close_deadline` queda fuera a
    -- propósito: lo escribe el servidor, no el navegador del alumno.
    v_cierre_propio :=
          OLD.closed_at    IS NULL
      AND OLD.closed_by    IS NULL
      AND OLD.close_reason IS NULL
      AND NEW.closed_at    IS NOT NULL
      AND NEW.closed_by     = v_uid
      AND NEW.user_id       = v_uid
      AND NEW.status       <> 'en_progreso'
      AND NEW.close_deadline IS NOT DISTINCT FROM OLD.close_deadline;

    IF NOT v_toca_notas AND (NOT v_toca_cierre OR v_cierre_propio) THEN
      RETURN NEW;
    END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.exams e
      JOIN public.course_teachers ct ON ct.course_id = e.course_id
      WHERE e.id = NEW.exam_id AND ct.user_id = v_uid
    ) OR EXISTS (
      SELECT 1 FROM public.exams e
      WHERE e.id = NEW.exam_id AND public.is_admin_of_course_tenant(e.course_id)
    ) INTO v_is_staff;

    IF v_is_staff THEN RETURN NEW; END IF;

    RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación o los metadatos de revisión de una entrega';
  END
  $fn$;

  REVOKE ALL ON FUNCTION public.tg_guard_exam_submission_grade() FROM PUBLIC;

  -- Se re-crea el trigger por el mismo motivo que la 20262410000000: en este
  -- proyecto ya pasó que una migración figure como aplicada sin haber corrido,
  -- y ahí quedaría la función nueva sin nada que la llame. Es idempotente.
  DROP TRIGGER IF EXISTS trg_guard_exam_submission_grade ON public.submissions;
  CREATE TRIGGER trg_guard_exam_submission_grade
    BEFORE UPDATE ON public.submissions
    FOR EACH ROW EXECUTE FUNCTION public.tg_guard_exam_submission_grade();
END $mig$;

-- ══════════════════════════════════════════════════════════════════════════
-- Matricular a un estudiante DESPUÉS debe incluirlo en lo que el curso YA tenía.
--
-- ── El problema (caso real de producción) ─────────────────────────────────
-- Introducción a la Ingeniería-SB141B (UNIAJ): 16 de 34 matriculados NO tenían
-- fila en `report_signatures` para un Acuerdo Pedagógico que ya existía ANTES de
-- que ellos se matricularan. Matricular a alguien NO propaga hacia atrás: las
-- cosas del curso que se resuelven con una FILA POR ESTUDIANTE creada en el
-- momento de un evento (SNAPSHOT/EXPLÍCITA) dejan un hueco silencioso para quien
-- entra después.
--
-- Lo DINÁMICO (talleres, proyectos, contenidos, pizarras, foros, asistencia,
-- mensajería) se resuelve por `course_id`/matrícula en tiempo de consulta y NO
-- necesita nada: el nuevo entra solo. Este trigger cubre solo las DOS relaciones
-- snapshot que sí dejaban hueco:
--
--   1. `exam_assignments` — el examen es visible al alumno solo si tiene su fila
--      (RLS mig 20261070000000). El auto-asignado corre al CREAR/mover el examen
--      (app.teacher.exams.index.tsx / .$examId.tsx), no al matricular después.
--   2. `report_signatures` — la firma de un informe se pide con una fila por
--      estudiante (`request_report_signatures`, mig 20261780000000). Un informe
--      ya mandado a firmar no alcanza a quien se matricula luego.
--
-- ── Diseño ────────────────────────────────────────────────────────────────
-- Trigger AFTER INSERT en `course_enrollments`, SECURITY DEFINER (escribe en
-- tablas snapshot saltando la RLS del que inserta la matrícula — igual patrón
-- que el trigger de bienvenida). Envuelto en EXCEPTION: como la bienvenida, una
-- falla en la propagación NUNCA debe abortar la matrícula.
--
-- Solo toca actividades VIGENTES y ya ROSTERIZADAS (que ya tenían al menos una
-- fila para otro alumno), para no re-crear lo que el docente desasignó a mano ni
-- inventar pendientes de exámenes/informes que nunca se repartieron.
-- ══════════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'course_enrollments ausente; nada que hacer.';
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.tg_enroll_propagate_snapshots()
  RETURNS TRIGGER
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public AS $fn$
  DECLARE
    _uid uuid := NEW.user_id;
    _cid uuid := NEW.course_id;
  BEGIN
    IF _uid IS NULL OR _cid IS NULL THEN
      RETURN NEW;
    END IF;

    BEGIN
      -- ── 1) exam_assignments para exámenes VIGENTES ya rosterizados ──────
      -- Vigente = no en papelera (deleted_at NULL) y no vencido (end_time NULL
      -- —incluye los de horario relativo— o futuro). No externos (no hay nada
      -- que el alumno "tome"). Ya rosterizado = tiene alguna asignación. Y aún
      -- no asignado a ESTE alumno.
      IF to_regclass('public.exam_assignments') IS NOT NULL
         AND to_regclass('public.exams') IS NOT NULL THEN
        INSERT INTO public.exam_assignments (exam_id, user_id)
        SELECT e.id, _uid
          FROM public.exams e
         WHERE e.course_id = _cid
           AND e.deleted_at IS NULL
           AND COALESCE(e.is_external, false) = false
           AND (e.end_time IS NULL OR e.end_time > now())
           AND EXISTS (SELECT 1 FROM public.exam_assignments ea
                        WHERE ea.exam_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM public.exam_assignments ea2
                            WHERE ea2.exam_id = e.id AND ea2.user_id = _uid);
      END IF;

      -- ── 2) report_signatures para informes ya mandados a firmar ─────────
      -- Solo informes del curso a nivel CURSO (student_id NULL — no un informe
      -- individual de otro alumno) que YA tienen firmas pedidas, y que aún no
      -- se le pidieron a este alumno. requested_by y titulo se copian de una
      -- fila/informe existente. Se avisa igual que request_report_signatures.
      IF to_regclass('public.report_signatures') IS NOT NULL
         AND to_regclass('public.generated_reports') IS NOT NULL THEN
        WITH ins AS (
          INSERT INTO public.report_signatures (report_id, user_id, requested_by)
          SELECT gr.id, _uid,
                 (SELECT rs0.requested_by FROM public.report_signatures rs0
                   WHERE rs0.report_id = gr.id
                   ORDER BY rs0.requested_at ASC NULLS LAST LIMIT 1)
            FROM public.generated_reports gr
           WHERE gr.course_id = _cid
             AND gr.student_id IS NULL
             AND EXISTS (SELECT 1 FROM public.report_signatures rs
                          WHERE rs.report_id = gr.id)
             AND NOT EXISTS (SELECT 1 FROM public.report_signatures rs2
                              WHERE rs2.report_id = gr.id AND rs2.user_id = _uid)
          ON CONFLICT (report_id, user_id) DO NOTHING
          RETURNING report_id
        )
        INSERT INTO public.notifications (user_id, kind, title, body, link)
        SELECT _uid, 'report_signature',
               '✍️ Tienes un documento para firmar',
               COALESCE(gr.template_name, 'Informe') ||
                 ' — revísalo y confirma tu aceptación.',
               '/app/student/signatures'
          FROM ins
          JOIN public.generated_reports gr ON gr.id = ins.report_id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- La matrícula es más importante que la propagación. Si algo falla, no se
      -- aborta el INSERT de course_enrollments; el hueco se puede cerrar luego
      -- re-asignando el examen o re-pidiendo la firma.
      NULL;
    END;

    RETURN NEW;
  END
  $fn$;

  DROP TRIGGER IF EXISTS trg_enroll_propagate_snapshots ON public.course_enrollments;
  CREATE TRIGGER trg_enroll_propagate_snapshots
    AFTER INSERT ON public.course_enrollments
    FOR EACH ROW
    EXECUTE FUNCTION public.tg_enroll_propagate_snapshots();
END $mig$;

NOTIFY pgrst, 'reload schema';

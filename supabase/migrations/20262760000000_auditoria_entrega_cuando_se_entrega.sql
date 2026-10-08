-- ══════════════════════════════════════════════════════════════════════
-- Auditoría de entregas de taller y proyecto: «entregado» cuando SE ENTREGA,
-- no cuando nace la fila.
--
-- Desde el 2026-10-07 la pantalla del estudiante inserta la fila en
-- `en_progreso`, guarda las respuestas y recién con todas en la base la pasa a
-- `entregado` (antes la marcaba primero y, si una respuesta no se guardaba,
-- seguía de largo: así se perdieron respuestas la noche del 5 de octubre).
-- Este trigger registraba `submission.*.submitted` en el AFTER INSERT, así que
-- un envío que FALLA habría quedado en Auditoría como «Taller entregado», y la
-- entrega real —un UPDATE— no dejaba ningún evento.
--
-- Ahora:
--   · INSERT → `submitted` solo si la fila ya nace como entrega (p. ej. las que
--     crea «Notas externas»). Una que nace `en_progreso` no registra nada.
--   · UPDATE → `submitted` en la TRANSICIÓN no-entrega → entrega; `graded`
--     cuando cambia `final_grade` (igual que antes).
-- «Entrega» la decide `estado_es_entrega`, la misma lista negra que usa la
-- pantalla (`entrega-hecha.ts`): no se escribe una tercera.
--
-- Y de paso, carga: el UPDATE consultaba taller, curso y correo ANTES de saber
-- si había algo que registrar, y este trigger corre en CADA actualización de la
-- entrega (también en cada nota que escribe la IA). Ahora decide primero y
-- consulta solo cuando va a escribir.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._trg_audit_workshop_submission()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ws_title      text;
  v_course_id     uuid;
  v_course_name   text;
  v_student_email text;
  v_actor_id      uuid;
  v_actor_email   text;
  v_actor_role    text;
  v_action        text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT public.estado_es_entrega(NEW.status) THEN
      RETURN NEW;
    END IF;
    v_action := 'submission.workshop.submitted';
  ELSIF NOT public.estado_es_entrega(OLD.status) AND public.estado_es_entrega(NEW.status) THEN
    v_action := 'submission.workshop.submitted';
  ELSIF OLD.final_grade IS DISTINCT FROM NEW.final_grade AND NEW.final_grade IS NOT NULL THEN
    v_action := 'submission.workshop.graded';
  ELSE
    RETURN NEW;
  END IF;

  BEGIN
    SELECT w.title, w.course_id
      INTO v_ws_title, v_course_id
      FROM public.workshops w WHERE w.id = NEW.workshop_id;

    SELECT c.name INTO v_course_name
      FROM public.courses c WHERE c.id = v_course_id;

    SELECT au.email INTO v_student_email
      FROM auth.users au WHERE au.id = NEW.user_id;

    IF v_action = 'submission.workshop.submitted' THEN
      v_actor_id    := NEW.user_id;
      v_actor_email := v_student_email;
      v_actor_role  := 'Estudiante';
    ELSE
      v_actor_id    := COALESCE(public._audit_jwt_uid(), NEW.user_id);
      SELECT au.email INTO v_actor_email FROM auth.users au WHERE au.id = v_actor_id;
      SELECT ur.role::text INTO v_actor_role FROM public.user_roles ur
        WHERE ur.user_id = v_actor_id LIMIT 1;
      v_actor_role  := COALESCE(v_actor_role, 'sistema');
    END IF;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      course_id, course_name, metadata
    ) VALUES (
      v_actor_id, v_actor_email, v_actor_role,
      v_action, 'workshop', 'info',
      'workshop_submission', NEW.id::text, v_ws_title,
      v_course_id, v_course_name,
      jsonb_build_object(
        'workshop_id', NEW.workshop_id,
        'student_id', NEW.user_id,
        'student_email', v_student_email,
        'status', NEW.status,
        'final_grade', NEW.final_grade
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[audit] workshop_submission trigger failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public._trg_audit_project_submission()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prj_title     text;
  v_course_id     uuid;
  v_course_name   text;
  v_student_email text;
  v_actor_id      uuid;
  v_actor_email   text;
  v_actor_role    text;
  v_action        text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT public.estado_es_entrega(NEW.status) THEN
      RETURN NEW;
    END IF;
    v_action := 'submission.project.submitted';
  ELSIF NOT public.estado_es_entrega(OLD.status) AND public.estado_es_entrega(NEW.status) THEN
    v_action := 'submission.project.submitted';
  ELSIF OLD.final_grade IS DISTINCT FROM NEW.final_grade AND NEW.final_grade IS NOT NULL THEN
    v_action := 'submission.project.graded';
  ELSE
    RETURN NEW;
  END IF;

  BEGIN
    SELECT p.title, p.course_id
      INTO v_prj_title, v_course_id
      FROM public.projects p WHERE p.id = NEW.project_id;

    SELECT c.name INTO v_course_name
      FROM public.courses c WHERE c.id = v_course_id;

    SELECT au.email INTO v_student_email
      FROM auth.users au WHERE au.id = NEW.user_id;

    IF v_action = 'submission.project.submitted' THEN
      v_actor_id    := NEW.user_id;
      v_actor_email := v_student_email;
      v_actor_role  := 'Estudiante';
    ELSE
      v_actor_id    := COALESCE(public._audit_jwt_uid(), NEW.user_id);
      SELECT au.email INTO v_actor_email FROM auth.users au WHERE au.id = v_actor_id;
      SELECT ur.role::text INTO v_actor_role FROM public.user_roles ur
        WHERE ur.user_id = v_actor_id LIMIT 1;
      v_actor_role  := COALESCE(v_actor_role, 'sistema');
    END IF;

    INSERT INTO public.audit_logs (
      actor_id, actor_email, actor_role,
      action, category, severity,
      entity_type, entity_id, entity_name,
      course_id, course_name, metadata
    ) VALUES (
      v_actor_id, v_actor_email, v_actor_role,
      v_action, 'project', 'info',
      'project_submission', NEW.id::text, v_prj_title,
      v_course_id, v_course_name,
      jsonb_build_object(
        'project_id', NEW.project_id,
        'student_id', NEW.user_id,
        'student_email', v_student_email,
        'status', NEW.status,
        'final_grade', NEW.final_grade
      )
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[audit] project_submission trigger failed: %', SQLERRM;
  END;

  RETURN NEW;
END;
$$;

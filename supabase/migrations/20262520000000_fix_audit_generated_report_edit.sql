-- ══════════════════════════════════════════════════════════════════════
-- Arreglo: el trigger de auditoría de la edición de informes escribía una
-- columna que NO existe, y eso dejó la edición ROTA en producción.
--
-- `tg_audit_generated_report_edit` (mig 20262510000000) inserta en
-- `audit_logs` usando `user_id`. La tabla real no tiene esa columna: el autor
-- va en `actor_id`. Resultado: TODO UPDATE sobre `generated_reports` —incluido
-- el que hace el botón «Editar contenido» que se publicó con esa misma
-- migración— fallaba con 42703 «column "user_id" ... does not exist».
--
-- Por qué la verificación no lo atajó, que es lo que importa para la próxima:
-- la migración se probó contra un Postgres real (PGlite), pero el `audit_logs`
-- de ese andamiaje lo escribí a mano y le puse `user_id`. O sea que la prueba
-- validó mi suposición contra sí misma. Un andamiaje que no sale del esquema
-- real solo confirma que el SQL compila.
--
-- De paso se rellenan las columnas de contexto que la tabla sí tiene y que la
-- versión anterior ignoraba (`actor_email`, `course_id`, `course_name`,
-- `tenant_id`), que son por las que se filtra la auditoría en el panel: sin
-- `tenant_id`, la fila solo la ve el SuperAdmin y el Admin de la institución
-- pierde el rastro de las ediciones de sus propios documentos.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_audit_generated_report_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_firmas int := 0;
  v_email  text;
  v_tenant uuid;
BEGIN
  IF NEW.html IS NOT DISTINCT FROM OLD.html THEN RETURN NEW; END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN RETURN NEW; END IF;

  IF to_regclass('public.report_signatures') IS NOT NULL THEN
    SELECT count(*) INTO v_firmas
      FROM public.report_signatures rs
     WHERE rs.report_id = NEW.id AND rs.signed_at IS NOT NULL;
  END IF;

  SELECT p.institutional_email, p.tenant_id INTO v_email, v_tenant
    FROM public.profiles p WHERE p.id = auth.uid();

  -- El tenant del CURSO manda sobre el de quien edita: un SuperAdmin no tiene
  -- institución propia, y sin esto su edición quedaría con tenant NULL — o sea
  -- invisible para el Admin del curso, que es justo a quien le interesa.
  IF NEW.course_id IS NOT NULL THEN
    SELECT c.tenant_id INTO v_tenant FROM public.courses c WHERE c.id = NEW.course_id;
  END IF;

  INSERT INTO public.audit_logs (
    action, category, severity, entity_type, entity_id, entity_name,
    actor_id, actor_email, course_id, course_name, tenant_id, metadata
  ) VALUES (
    'report.html_edited', 'reports',
    CASE WHEN v_firmas > 0 THEN 'warning' ELSE 'info' END,
    'generated_report', NEW.id, NEW.template_name,
    auth.uid(), v_email, NEW.course_id, NEW.course_name, v_tenant,
    jsonb_build_object(
      'firmas_ya_puestas', v_firmas,
      'largo_antes', length(COALESCE(OLD.html, '')),
      'largo_despues', length(COALESCE(NEW.html, ''))
    )
  );
  RETURN NEW;
END
$$;

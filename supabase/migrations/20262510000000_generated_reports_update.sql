-- ══════════════════════════════════════════════════════════════════════
-- El Acuerdo Pedagógico se puede corregir desde la aplicación.
--
-- `generated_reports` nació sin policy de UPDATE a propósito (mig
-- 20260975000000: «un informe generado es un snapshot»). En la práctica ese
-- diseño no aguantó: el Acuerdo Pedagógico es un documento VIVO —se corrige un
-- nombre mal escrito, se designa el vocero que faltaba, se ajusta una fecha— y
-- cada corrección exigía una migración versionada. Ya van tres
-- (20262220000000, 20262400000000, 20262500000000), todas para arreglar texto
-- dentro de un documento. Pedir un despliegue para corregir una tilde es la
-- señal de que la puerta faltaba.
--
-- Se abre con TRES límites, porque «editable» no puede significar «escribible
-- en cualquier columna por cualquiera»:
--
--  1. QUIÉN — misma acotación que el SELECT que ya existe: el creador, el
--     docente del curso, o Admin/SuperAdmin del tenant del curso. No se usa
--     `has_role('Admin')` suelto: sin `course_in_my_tenant` sería un Admin de
--     CUALQUIER institución editando documentos de otra (el anti-patrón que
--     CLAUDE.md documenta).
--
--  2. QUÉ — la RLS es por FILA, no por columna, así que la policy sola dejaría
--     re-apuntar `course_id` a otro curso (o a otro TENANT), cambiar
--     `created_by` para atribuirle el documento a un tercero, o encender
--     `public_enabled` saltándose la RPC. El candado de columnas va en un
--     trigger: solo `html`, `page_orientation` y `page_size` pueden cambiar.
--
--  3. QUEDA RASTRO — editar un documento con firmas puestas no puede ser
--     invisible. Como el aviso de «firmas sobre versiones distintas» se retiró
--     (es un documento vivo, cambiar NO es una anomalía), la rendición de
--     cuentas se mueve a la auditoría: cada edición del html deja una fila con
--     quién, cuándo, y cuántas firmas ya había.
--
-- Por qué el guard mira `current_user` y no `auth.uid()`: las dos RPC que hoy
-- escriben esta tabla —`report_set_public` (20261990000000, toca
-- public_token/public_enabled) y el agregado de ranuras de firma
-- (20262230000000, concatena al html)— son SECURITY DEFINER y corren con
-- `auth.uid()` del usuario, así que un guard basado en el uid las rompería.
-- Dentro de una SECURITY DEFINER, `current_user` es el DUEÑO de la función; en
-- una escritura por REST es `authenticated`. Ese es el discriminante correcto:
-- clampa la puerta nueva sin tocar las que ya estaban probadas. Por lo mismo el
-- guard NO puede ser SECURITY DEFINER (ver la nota sobre la función).
-- ══════════════════════════════════════════════════════════════════════

-- ── 1. El candado de columnas ────────────────────────────────────────
-- SECURITY INVOKER (el default), y NO es un descuido: con SECURITY DEFINER
-- `current_user` dentro de la función es el DUEÑO, nunca 'authenticated', así
-- que el guard se anulaba a sí mismo y dejaba pasar TODO — verificado contra
-- un Postgres real, donde re-apuntar `course_id` desde REST no se rechazaba.
-- Además no necesita privilegios elevados: solo compara NEW contra OLD.
CREATE OR REPLACE FUNCTION public.tg_guard_generated_report_update()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  -- service_role, migraciones y las RPC SECURITY DEFINER que ya existían.
  IF current_user <> 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF NEW.id            IS DISTINCT FROM OLD.id
  OR NEW.template_id   IS DISTINCT FROM OLD.template_id
  OR NEW.template_name IS DISTINCT FROM OLD.template_name
  OR NEW.scope         IS DISTINCT FROM OLD.scope
  OR NEW.course_id     IS DISTINCT FROM OLD.course_id
  OR NEW.course_name   IS DISTINCT FROM OLD.course_name
  OR NEW.student_id    IS DISTINCT FROM OLD.student_id
  OR NEW.student_name  IS DISTINCT FROM OLD.student_name
  OR NEW.periodo       IS DISTINCT FROM OLD.periodo
  OR NEW.acta_id       IS DISTINCT FROM OLD.acta_id
  OR NEW.foco_tipo     IS DISTINCT FROM OLD.foco_tipo
  OR NEW.foco_id       IS DISTINCT FROM OLD.foco_id
  OR NEW.created_by    IS DISTINCT FROM OLD.created_by
  OR NEW.created_at    IS DISTINCT FROM OLD.created_at
  OR NEW.public_token   IS DISTINCT FROM OLD.public_token
  OR NEW.public_enabled IS DISTINCT FROM OLD.public_enabled
  THEN
    RAISE EXCEPTION 'Del documento generado solo se puede editar el contenido; el curso, el estudiante, la autoria y el enlace publico no se cambian desde aca';
  END IF;

  RETURN NEW;
END
$$;

-- ── 2. El rastro ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_audit_generated_report_edit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_firmas int := 0;
BEGIN
  IF NEW.html IS NOT DISTINCT FROM OLD.html THEN RETURN NEW; END IF;
  IF to_regclass('public.audit_logs') IS NULL THEN RETURN NEW; END IF;

  IF to_regclass('public.report_signatures') IS NOT NULL THEN
    SELECT count(*) INTO v_firmas
      FROM public.report_signatures rs
     WHERE rs.report_id = NEW.id AND rs.signed_at IS NOT NULL;
  END IF;

  INSERT INTO public.audit_logs (
    action, category, severity, entity_type, entity_id, entity_name, user_id, metadata
  ) VALUES (
    'report.html_edited', 'reports',
    -- Editar un documento que YA tiene firmas no es lo mismo que corregir un
    -- borrador: lo primero merece destacarse en la auditoría.
    CASE WHEN v_firmas > 0 THEN 'warning' ELSE 'info' END,
    'generated_report', NEW.id, NEW.template_name, auth.uid(),
    jsonb_build_object(
      'course_id', NEW.course_id,
      'course_name', NEW.course_name,
      'firmas_ya_puestas', v_firmas,
      'largo_antes', length(COALESCE(OLD.html, '')),
      'largo_despues', length(COALESCE(NEW.html, ''))
    )
  );
  RETURN NEW;
END
$$;

-- ── 3. Policy + triggers ─────────────────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.generated_reports') IS NULL THEN
    RAISE NOTICE 'skip generated_reports UPDATE: tabla ausente';
    RETURN;
  END IF;

  DROP POLICY IF EXISTS "generated_reports_update" ON public.generated_reports;
  CREATE POLICY "generated_reports_update" ON public.generated_reports
    FOR UPDATE
    USING (
      created_by = auth.uid()
      OR (
        public.course_in_my_tenant(course_id)
        AND (
          public.has_role(auth.uid(), 'Admin')
          OR public.is_super_admin()
          OR EXISTS (
            SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = generated_reports.course_id
               AND ct.user_id = auth.uid()
          )
        )
      )
    )
    -- El WITH CHECK repite el USING: sin él, la fila podría quedar en un estado
    -- que el propio caller ya no puede volver a editar.
    WITH CHECK (
      created_by = auth.uid()
      OR (
        public.course_in_my_tenant(course_id)
        AND (
          public.has_role(auth.uid(), 'Admin')
          OR public.is_super_admin()
          OR EXISTS (
            SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = generated_reports.course_id
               AND ct.user_id = auth.uid()
          )
        )
      )
    );

  DROP TRIGGER IF EXISTS trg_guard_generated_report_update ON public.generated_reports;
  CREATE TRIGGER trg_guard_generated_report_update
    BEFORE UPDATE ON public.generated_reports
    FOR EACH ROW EXECUTE FUNCTION public.tg_guard_generated_report_update();

  DROP TRIGGER IF EXISTS trg_audit_generated_report_edit ON public.generated_reports;
  CREATE TRIGGER trg_audit_generated_report_edit
    BEFORE UPDATE ON public.generated_reports
    FOR EACH ROW EXECUTE FUNCTION public.tg_audit_generated_report_edit();
END
$mig$;

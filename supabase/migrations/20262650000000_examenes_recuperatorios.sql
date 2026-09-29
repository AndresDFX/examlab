-- ══════════════════════════════════════════════════════════════════════
-- Exámenes RECUPERATORIOS (además de los supletorios que ya existían).
--
-- `exams.parent_exam_id` ya permitía colgar un examen de otro, pero con UNA sola
-- regla, la del SUPLETORIO: la nota del hijo solo cuenta si el estudiante NO
-- presentó el original. Un recuperatorio es para quien SÍ lo presentó y lo
-- perdió, así que con esa regla su nota se ignoraba en todas las pantallas.
--
--  1. `exams.makeup_kind`  ('supletorio' | 'recuperatorio', default supletorio:
--     los hijos que ya existen conservan exactamente su comportamiento).
--  2. `exams.recovery_rule` ('mayor' | 'reemplaza', default mayor): cómo combina
--     un recuperatorio con el original. «mayor» nunca le baja la nota a nadie.
--  3. `exam_attempts_raw_grade` + `exam_effective_raw_grade`: la regla en SQL.
--     ESPEJO de src/modules/grading/nota-con-recuperacion.ts
--     (`resolverNotaConRecuperacion`); si cambia una, cambia la otra.
--  4. `generate_course_acta`: usa la regla nueva. Hasta hoy el acta IGNORABA
--     por completo las recuperaciones —ni siquiera aplicaba el supletorio que
--     el gradebook, el boletín y la vista del estudiante sí aplicaban—, así que
--     el acta y el certificado podían diferir para quien presentó un supletorio.
--     El promedio de reintentos ahora se redondea a 2 decimales, como en el
--     cliente (`computeAttemptGrade`). Solo afecta actas FUTURAS.
--
--  5. Publicar una recuperación le avisa solo a sus asignados (no al curso).
--  6. Asignar un examen en borrador ya no avisa: el aviso sale al publicarlo.
--
-- Las dos funciones de nota leen entregas de CUALQUIER estudiante (son SECURITY
-- DEFINER): se revocan a todos los roles de la API. Solo las usa el acta, que
-- ya valida que quien la genera sea docente del curso o Admin.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.exams') IS NOT NULL THEN
    ALTER TABLE public.exams
      ADD COLUMN IF NOT EXISTS makeup_kind text NOT NULL DEFAULT 'supletorio',
      ADD COLUMN IF NOT EXISTS recovery_rule text NOT NULL DEFAULT 'mayor';
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exams_makeup_kind_check') THEN
      ALTER TABLE public.exams
        ADD CONSTRAINT exams_makeup_kind_check CHECK (makeup_kind IN ('supletorio', 'recuperatorio'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exams_recovery_rule_check') THEN
      ALTER TABLE public.exams
        ADD CONSTRAINT exams_recovery_rule_check CHECK (recovery_rule IN ('mayor', 'reemplaza'));
    END IF;
    COMMENT ON COLUMN public.exams.makeup_kind IS
      'Solo con parent_exam_id. supletorio: su nota cuenta solo si el estudiante NO presentó el original. recuperatorio: cuenta aunque lo haya presentado, según recovery_rule.';
    COMMENT ON COLUMN public.exams.recovery_rule IS
      'Solo para recuperatorios. mayor: cuenta la nota más alta entre el original y el recuperatorio. reemplaza: la del recuperatorio sustituye a la del original.';
  END IF;
END
$$;

-- Nota cruda de UN examen para un estudiante: sus intentos FINALIZADOS
-- combinados según el retry_mode del examen. Espejo de computeAttemptGrade.
CREATE OR REPLACE FUNCTION public.exam_attempts_raw_grade(p_exam_id uuid, p_user_id uuid)
RETURNS TABLE (presento boolean, nota numeric)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  WITH a AS (
    SELECT public.compute_effective_grade(s.final_override_grade, NULL, s.ai_grade) AS val,
           s.created_at
      FROM public.submissions s
     WHERE s.exam_id = p_exam_id
       AND s.user_id = p_user_id
       AND s.status IN ('completado', 'sospechoso')
  )
  SELECT (SELECT count(*) FROM a) > 0,
         (SELECT CASE e.retry_mode
                   WHEN 'average' THEN round(avg(a.val), 2)
                   WHEN 'highest' THEN max(a.val)
                   ELSE (array_agg(a.val ORDER BY a.created_at DESC))[1]
                 END
            FROM a
           WHERE a.val IS NOT NULL)
    FROM public.exams e
   WHERE e.id = p_exam_id;
$$;

-- Nota del examen CON sus recuperaciones. Pliegue en orden de creación:
-- la primera recuperación presentada llena la ausencia del original, y cada
-- recuperatorio posterior combina según su regla. Espejo de
-- resolverNotaConRecuperacion (nota-con-recuperacion.ts).
CREATE OR REPLACE FUNCTION public.exam_effective_raw_grade(p_exam_id uuid, p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tiene_base boolean := false;
  v_base numeric;
  g record;
  r record;
BEGIN
  SELECT * INTO g FROM public.exam_attempts_raw_grade(p_exam_id, p_user_id);
  IF COALESCE(g.presento, false) THEN
    v_tiene_base := true;
    v_base := g.nota;
  END IF;

  FOR r IN
    SELECT e.id,
           COALESCE(e.makeup_kind, 'supletorio') AS tipo,
           COALESCE(e.recovery_rule, 'mayor') AS regla
      FROM public.exams e
     WHERE e.parent_exam_id = p_exam_id
       AND e.deleted_at IS NULL
       AND COALESCE(e.status, 'published') <> 'draft'
     ORDER BY e.created_at, e.id
  LOOP
    SELECT * INTO g FROM public.exam_attempts_raw_grade(r.id, p_user_id);
    IF NOT COALESCE(g.presento, false) THEN
      CONTINUE;
    END IF;
    IF NOT v_tiene_base THEN
      v_tiene_base := true;
      v_base := g.nota;
      CONTINUE;
    END IF;
    -- Con una nota de base ya puesta, el supletorio no tiene nada que llenar.
    IF r.tipo <> 'recuperatorio' OR g.nota IS NULL THEN
      CONTINUE;
    END IF;
    IF r.regla = 'reemplaza' OR v_base IS NULL OR g.nota > v_base THEN
      v_base := g.nota;
    END IF;
  END LOOP;

  RETURN v_base;
END
$$;

REVOKE ALL ON FUNCTION public.exam_attempts_raw_grade(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.exam_effective_raw_grade(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- El acta: la definición vigente (mig 20261220000000) con los dos bloques de
-- exámenes pasados a exam_effective_raw_grade. Nada más cambia.
CREATE OR REPLACE FUNCTION public.generate_course_acta(p_course_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
DECLARE
  v_user uuid := auth.uid();
  v_is_admin boolean;
  v_is_teacher boolean;
  v_course record;
  v_period record;
  v_program record;
  v_docente record;
  v_passing numeric;
  v_scale_max numeric;
  v_scale_min numeric;
  v_snapshot jsonb;
  v_estudiantes jsonb := '[]'::jsonb;
  v_total int := 0;
  v_aprobados int := 0;
  v_reprobados int := 0;
  v_hash text;
  v_acta_id uuid;
  v_student record;
  v_cuts_arr jsonb;
  v_cut record;
  v_cut_items jsonb;
  v_all_items jsonb;
  v_attendance_pct numeric;
  v_attendance_score numeric;
  v_cut_grade numeric;
  v_nota_final numeric;
  v_estado_aprobacion text;
  v_sess_in_cut int;
  v_present_in_cut int;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  -- Con scope de institución (antes: cualquier Admin de cualquier institución).
  v_is_admin := public.is_admin_of_course_tenant(p_course_id);
  SELECT EXISTS (
    SELECT 1 FROM public.course_teachers
    WHERE course_id = p_course_id AND user_id = v_user
  ) INTO v_is_teacher;
  IF NOT (v_is_admin OR v_is_teacher) THEN
    RAISE EXCEPTION 'Solo el docente del curso o un Admin pueden generar el acta';
  END IF;
  SELECT * INTO v_course FROM public.courses WHERE id = p_course_id;
  IF v_course IS NULL THEN
    RAISE EXCEPTION 'Curso no encontrado';
  END IF;
  SELECT * INTO v_period FROM public.academic_periods WHERE id = v_course.period_id;
  SELECT * INTO v_program FROM public.academic_programs WHERE id = v_course.program_id;
  SELECT p.full_name, p.institutional_email INTO v_docente
  FROM public.course_teachers ct
  JOIN public.profiles p ON p.id = ct.user_id
  WHERE ct.course_id = p_course_id
  ORDER BY ct.user_id
  LIMIT 1;
  v_scale_max := COALESCE(v_course.grade_scale_max, 5);
  v_scale_min := COALESCE(v_course.grade_scale_min, 0);
  v_passing := COALESCE(v_course.passing_grade, 3);
  FOR v_student IN
    SELECT pr.id, pr.full_name, pr.institutional_email,
           pr.codigo, pr.documento, pr.cohorte, pr.estado AS estudiante_estado
    FROM public.course_enrollments ce
    JOIN public.profiles pr ON pr.id = ce.user_id
    WHERE ce.course_id = p_course_id
    ORDER BY pr.full_name
  LOOP
    v_total := v_total + 1;
    v_cuts_arr := '[]'::jsonb;
    v_all_items := '[]'::jsonb;
    FOR v_cut IN
      SELECT id, name, weight, attendance_weight
      FROM public.grade_cuts
      WHERE course_id = p_course_id
      ORDER BY position
    LOOP
      -- Exámenes del corte — nota re-escalada a [min,max] (bug 2).
      v_cut_items := COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', e.weight,
          'score', CASE WHEN eff.score IS NULL THEN NULL
                        ELSE v_scale_min + (eff.score / NULLIF(v_scale_max, 0)) * (v_scale_max - v_scale_min) END
        ))
        FROM public.exams e
        -- La nota del examen CON sus recuperaciones (supletorio / recuperatorio):
      -- misma regla que el gradebook, vía exam_effective_raw_grade.
      CROSS JOIN LATERAL (SELECT public.exam_effective_raw_grade(e.id, v_student.id) AS score) eff
        WHERE e.course_id = p_course_id AND e.cut_id = v_cut.id
          AND e.parent_exam_id IS NULL
          AND e.deleted_at IS NULL
          AND COALESCE(e.status, 'published') <> 'draft'
      ), '[]'::jsonb);
      -- Talleres: por MEMBRESÍA (propia O grupal) + nota ESCALADA por max_score
      -- (o escala del curso si es externa) — bug 1 (ALTA).
      v_cut_items := v_cut_items || COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', COALESCE(wc.weight, w.weight),
          'score', CASE
            WHEN public.compute_effective_grade(NULL, ws.final_grade, ws.ai_grade) IS NULL THEN NULL
            ELSE v_scale_min
                 + (public.compute_effective_grade(NULL, ws.final_grade, ws.ai_grade)
                    / NULLIF(CASE WHEN COALESCE(w.is_external, false) THEN v_scale_max ELSE COALESCE(w.max_score, 100) END, 0))
                 * (v_scale_max - v_scale_min)
          END
        ))
        FROM public.workshop_courses wc
        JOIN public.workshops w ON w.id = wc.workshop_id
        LEFT JOIN LATERAL (
          SELECT wss.final_grade, wss.ai_grade
          FROM public.workshop_submissions wss
          WHERE wss.workshop_id = w.id
            AND (
              wss.user_id = v_student.id
              OR (wss.group_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.workshop_group_members m
                    WHERE m.group_id = wss.group_id AND m.user_id = v_student.id))
            )
          ORDER BY (wss.group_id IS NOT NULL) DESC
          LIMIT 1
        ) ws ON true
        WHERE wc.course_id = p_course_id AND wc.cut_id = v_cut.id
          AND w.deleted_at IS NULL
          AND COALESCE(w.status, 'published') <> 'draft'
      ), '[]'::jsonb);
      -- Proyectos: idem, por membresía + escala por max_score.
      v_cut_items := v_cut_items || COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', pc.weight,
          'score', CASE
            WHEN public.compute_effective_grade(NULL, ps.final_grade, ps.ai_grade) IS NULL THEN NULL
            ELSE v_scale_min
                 + (public.compute_effective_grade(NULL, ps.final_grade, ps.ai_grade)
                    / NULLIF(CASE WHEN COALESCE(pr2.is_external, false) THEN v_scale_max ELSE COALESCE(pr2.max_score, 100) END, 0))
                 * (v_scale_max - v_scale_min)
          END
        ))
        FROM public.project_courses pc
        JOIN public.projects pr2 ON pr2.id = pc.project_id
        LEFT JOIN LATERAL (
          SELECT pss.final_grade, pss.ai_grade
          FROM public.project_submissions pss
          WHERE pss.project_id = pc.project_id
            AND (
              pss.user_id = v_student.id
              OR (pss.group_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.project_group_members m
                    WHERE m.group_id = pss.group_id AND m.user_id = v_student.id))
            )
          ORDER BY (pss.group_id IS NOT NULL) DESC
          LIMIT 1
        ) ps ON true
        WHERE pc.course_id = p_course_id AND pc.cut_id = v_cut.id
          AND pr2.deleted_at IS NULL
          AND COALESCE(pr2.status, 'published') <> 'draft'
      ), '[]'::jsonb);
      IF COALESCE(v_cut.attendance_weight, 0) > 0 THEN
        SELECT COUNT(*) INTO v_sess_in_cut
        FROM public.attendance_sessions ases
        WHERE ases.course_id = p_course_id AND ases.cut_id = v_cut.id;
        IF v_sess_in_cut > 0 THEN
          SELECT COUNT(*) INTO v_present_in_cut
          FROM public.attendance_records ar
          JOIN public.attendance_sessions ases ON ases.id = ar.session_id
          WHERE ases.course_id = p_course_id
            AND ases.cut_id = v_cut.id
            AND ar.user_id = v_student.id
            AND ar.status IN ('presente', 'tarde');
          v_attendance_pct := (v_present_in_cut::numeric / v_sess_in_cut::numeric) * 100;
          v_attendance_score := v_scale_min + (v_attendance_pct / 100) * (v_scale_max - v_scale_min);
          v_cut_items := v_cut_items || jsonb_build_array(jsonb_build_object(
            'weight', v_cut.attendance_weight,
            'score', v_attendance_score
          ));
        END IF;
      END IF;
      v_cut_grade := public.compute_weighted_grade(v_cut_items);
      v_all_items := v_all_items || v_cut_items;
      v_cuts_arr := v_cuts_arr || jsonb_build_object(
        'nombre', v_cut.name,
        'peso', v_cut.weight,
        'nota', v_cut_grade
      );
    END LOOP;

    -- Items SIN corte asignado (cut_id IS NULL) — bug 3: el gradebook, la vista del
    -- estudiante y el certificado los incluyen en la nota final; el acta los ignoraba
    -- porque solo acumulaba items con cut_id = <corte>. Se escalan igual y se agregan
    -- a v_all_items (NO tienen asistencia — la asistencia es siempre por corte).
    v_all_items := v_all_items || COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'weight', e.weight,
        'score', CASE WHEN eff.score IS NULL THEN NULL
                      ELSE v_scale_min + (eff.score / NULLIF(v_scale_max, 0)) * (v_scale_max - v_scale_min) END
      ))
      FROM public.exams e
      -- La nota del examen CON sus recuperaciones (supletorio / recuperatorio):
      -- misma regla que el gradebook, vía exam_effective_raw_grade.
      CROSS JOIN LATERAL (SELECT public.exam_effective_raw_grade(e.id, v_student.id) AS score) eff
      WHERE e.course_id = p_course_id AND e.cut_id IS NULL
        AND e.parent_exam_id IS NULL
        AND e.deleted_at IS NULL
        AND COALESCE(e.status, 'published') <> 'draft'
    ), '[]'::jsonb);
    v_all_items := v_all_items || COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'weight', COALESCE(wc.weight, w.weight),
        'score', CASE
          WHEN public.compute_effective_grade(NULL, ws.final_grade, ws.ai_grade) IS NULL THEN NULL
          ELSE v_scale_min
               + (public.compute_effective_grade(NULL, ws.final_grade, ws.ai_grade)
                  / NULLIF(CASE WHEN COALESCE(w.is_external, false) THEN v_scale_max ELSE COALESCE(w.max_score, 100) END, 0))
               * (v_scale_max - v_scale_min)
        END
      ))
      FROM public.workshop_courses wc
      JOIN public.workshops w ON w.id = wc.workshop_id
      LEFT JOIN LATERAL (
        SELECT wss.final_grade, wss.ai_grade
        FROM public.workshop_submissions wss
        WHERE wss.workshop_id = w.id
          AND (
            wss.user_id = v_student.id
            OR (wss.group_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.workshop_group_members m
                  WHERE m.group_id = wss.group_id AND m.user_id = v_student.id))
          )
        ORDER BY (wss.group_id IS NOT NULL) DESC
        LIMIT 1
      ) ws ON true
      WHERE wc.course_id = p_course_id AND wc.cut_id IS NULL
        AND w.deleted_at IS NULL
        AND COALESCE(w.status, 'published') <> 'draft'
    ), '[]'::jsonb);
    v_all_items := v_all_items || COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'weight', pc.weight,
        'score', CASE
          WHEN public.compute_effective_grade(NULL, ps.final_grade, ps.ai_grade) IS NULL THEN NULL
          ELSE v_scale_min
               + (public.compute_effective_grade(NULL, ps.final_grade, ps.ai_grade)
                  / NULLIF(CASE WHEN COALESCE(pr2.is_external, false) THEN v_scale_max ELSE COALESCE(pr2.max_score, 100) END, 0))
               * (v_scale_max - v_scale_min)
        END
      ))
      FROM public.project_courses pc
      JOIN public.projects pr2 ON pr2.id = pc.project_id
      LEFT JOIN LATERAL (
        SELECT pss.final_grade, pss.ai_grade
        FROM public.project_submissions pss
        WHERE pss.project_id = pc.project_id
          AND (
            pss.user_id = v_student.id
            OR (pss.group_id IS NOT NULL AND EXISTS (
                  SELECT 1 FROM public.project_group_members m
                  WHERE m.group_id = pss.group_id AND m.user_id = v_student.id))
          )
        ORDER BY (pss.group_id IS NOT NULL) DESC
        LIMIT 1
      ) ps ON true
      WHERE pc.course_id = p_course_id AND pc.cut_id IS NULL
        AND pr2.deleted_at IS NULL
        AND COALESCE(pr2.status, 'published') <> 'draft'
    ), '[]'::jsonb);

    v_nota_final := public.compute_weighted_grade(v_all_items);
    IF v_nota_final IS NULL THEN
      v_estado_aprobacion := 'sin_nota';
    ELSIF v_nota_final >= v_passing THEN
      v_estado_aprobacion := 'aprobado';
      v_aprobados := v_aprobados + 1;
    ELSE
      v_estado_aprobacion := 'reprobado';
      v_reprobados := v_reprobados + 1;
    END IF;
    v_estudiantes := v_estudiantes || jsonb_build_object(
      'id', v_student.id,
      'nombre', COALESCE(v_student.full_name, '—'),
      'email', COALESCE(v_student.institutional_email, ''),
      'codigo', COALESCE(v_student.codigo, ''),
      'documento', COALESCE(v_student.documento, ''),
      'cohorte', COALESCE(v_student.cohorte, ''),
      'estado', COALESCE(v_student.estudiante_estado, ''),
      'nota_final', v_nota_final,
      'estado_aprobacion', v_estado_aprobacion,
      'cortes', v_cuts_arr
    );
  END LOOP;
  IF v_total = 0 THEN
    RAISE EXCEPTION 'El curso no tiene estudiantes matriculados; no se puede generar el acta.';
  END IF;
  v_snapshot := jsonb_build_object(
    'version', 2,
    'generated_at', now(),
    'curso', jsonb_build_object(
      'id', v_course.id,
      'nombre', v_course.name,
      'codigo', COALESCE(v_course.code, ''),
      'grupo', COALESCE(v_course.grupo, ''),
      'semestre', v_course.semestre,
      'escala_max', v_scale_max,
      'passing_grade', v_passing
    ),
    'programa', CASE
      WHEN v_program IS NULL THEN NULL
      ELSE jsonb_build_object('nombre', v_program.name, 'codigo', COALESCE(v_program.code, ''))
    END,
    'periodo', CASE
      WHEN v_period IS NULL THEN
        jsonb_build_object('code', COALESCE(v_course.period, ''), 'name', '')
      ELSE jsonb_build_object(
        'code', v_period.code,
        'name', COALESCE(v_period.name, ''),
        'start_date', v_period.start_date,
        'end_date', v_period.end_date
      )
    END,
    'docente', jsonb_build_object(
      'nombre', COALESCE(v_docente.full_name, '—'),
      'email', COALESCE(v_docente.institutional_email, '')
    ),
    'estudiantes', v_estudiantes,
    'total_estudiantes', v_total,
    'total_aprobados', v_aprobados,
    'total_reprobados', v_reprobados,
    'total_sin_nota', v_total - v_aprobados - v_reprobados
  );
  v_hash := encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex');
  INSERT INTO public.course_actas (
    course_id, period_id, snapshot, integrity_hash,
    generated_by, curso_nombre, docente_nombre, periodo_codigo,
    total_estudiantes, total_aprobados, total_reprobados
  ) VALUES (
    p_course_id,
    v_course.period_id,
    v_snapshot,
    v_hash,
    v_user,
    v_course.name,
    COALESCE(v_docente.full_name, '—'),
    COALESCE(v_period.code, v_course.period),
    v_total,
    v_aprobados,
    v_reprobados
  )
  ON CONFLICT (course_id, COALESCE(period_id, '00000000-0000-0000-0000-000000000000'::uuid))
  DO UPDATE SET
    snapshot = EXCLUDED.snapshot,
    integrity_hash = EXCLUDED.integrity_hash,
    generated_by = EXCLUDED.generated_by,
    generated_at = now(),
    curso_nombre = EXCLUDED.curso_nombre,
    docente_nombre = EXCLUDED.docente_nombre,
    periodo_codigo = EXCLUDED.periodo_codigo,
    total_estudiantes = EXCLUDED.total_estudiantes,
    total_aprobados = EXCLUDED.total_aprobados,
    total_reprobados = EXCLUDED.total_reprobados
  RETURNING id INTO v_acta_id;
  RETURN v_acta_id;
END
$function$;

-- ══════════════════════════════════════════════════════════════════════
-- 5) AVISOS. Una recuperación le avisa SOLO a quien la presenta.
--
-- Publicar un examen le avisa a TODO el curso (`notify_course_students`), y el
-- diferido del cron también. Con una recuperación eso anunciaba «Nuevo examen
-- publicado: Recuperatorio — Parcial 1» a los que aprobaron —y de paso le
-- contaba al curso quiénes perdieron—. Ahora, si el examen tiene
-- `parent_exam_id`, el aviso va a sus ASIGNADOS (`exam_assignments`) que sigan
-- matriculados; un examen normal avisa igual que antes.
--
-- 6) Asignar un examen en BORRADOR ya no avisa. El trigger de asignación
-- avisaba «Te asignaron el examen» sin mirar el estado, y el formulario de
-- crear asigna al curso entero en el acto: un borrador que el docente todavía
-- estaba armando llegaba como aviso (y correo) a cada estudiante. El aviso de
-- un borrador ya lo da el de PUBLICAR; y lo que se asigne después de publicar
-- sigue avisando. Es lo que permite que «Crear recuperatorio» asigne en el
-- momento de crear —sin esperar a publicar, que no re-asigna— sin mandarle
-- nada a nadie.
--
-- `_tg_exam_publish_notify` y `dispatch_deferred_publish_notifications` se
-- reproducen enteras desde la mig 20262210000000 cambiando solo la llamada
-- de exámenes: talleres y proyectos quedan byte a byte como estaban.
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._notify_exam_publication(
  _exam_id uuid,
  _course_id uuid,
  _parent_exam_id uuid,
  _title text,
  _body text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _count integer := 0;
BEGIN
  IF _parent_exam_id IS NULL THEN
    RETURN public.notify_course_students(
      _course_id, _title, _body, 'exam', '/app/student/exams', 'Docente'
    );
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link, source_role)
  SELECT ea.user_id, _title, _body, 'exam', '/app/student/exams', 'Docente'
    FROM public.exam_assignments ea
    JOIN public.course_enrollments ce
      ON ce.user_id = ea.user_id AND ce.course_id = _course_id
   WHERE ea.exam_id = _exam_id;

  GET DIAGNOSTICS _count = ROW_COUNT;
  RETURN _count;
END
$$;

-- Solo la llaman el trigger y el cron (los dos SECURITY DEFINER). El REVOKE a
-- anon/authenticated es explícito: el de PUBLIC no borra el EXECUTE que
-- Supabase otorga por ALTER DEFAULT PRIVILEGES.
REVOKE ALL ON FUNCTION public._notify_exam_publication(uuid, uuid, uuid, text, text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._notify_exam_assigned()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _exam_title TEXT;
  _course_name TEXT;
BEGIN
  -- Un borrador (o un examen en la papelera) no se anuncia: el aviso sale al
  -- publicarlo. Ver el punto 6 del encabezado de esta sección.
  SELECT e.title, COALESCE(c.name, 'sin curso')
    INTO _exam_title, _course_name
    FROM public.exams e
    LEFT JOIN public.courses c ON c.id = e.course_id
   WHERE e.id = NEW.exam_id
     AND e.status IS DISTINCT FROM 'draft'
     AND e.deleted_at IS NULL;

  IF _exam_title IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notifications (user_id, title, body, kind, link)
  VALUES (
    NEW.user_id,
    'Te asignaron el examen "' || _exam_title || '"',
    'Curso: ' || _course_name || '. Revisa la fecha de inicio en tu lista de exámenes.',
    'exam',
    '/app/student/exams'
  );

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION public._tg_exam_publish_notify()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _is_publish_event BOOLEAN := false;
  _is_edit_published BOOLEAN := false;
  _defer BOOLEAN := false;
  _title TEXT;
  _body TEXT;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
    _is_publish_event := true;
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status IS DISTINCT FROM 'published' THEN
    _is_publish_event := true;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.status = 'published' AND OLD.status = 'published'
     AND OLD.publish_notified_at IS NOT NULL THEN
    IF OLD.title IS DISTINCT FROM NEW.title
       OR OLD.description IS DISTINCT FROM NEW.description
       OR OLD.start_time IS DISTINCT FROM NEW.start_time
       OR OLD.end_time IS DISTINCT FROM NEW.end_time
       OR OLD.time_limit_minutes IS DISTINCT FROM NEW.time_limit_minutes
       OR OLD.max_attempts IS DISTINCT FROM NEW.max_attempts
    THEN
      _is_edit_published := true;
    END IF;
  END IF;

  IF NOT _is_publish_event AND NOT _is_edit_published THEN
    RETURN NULL;
  END IF;

  IF _is_publish_event THEN
    -- exams.start_time es NOT NULL en el schema, pero se deja el guard
    -- IS NOT NULL por simetría con taller/proyecto y por si algún día se
    -- relaja la constraint.
    _defer := NEW.start_time IS NOT NULL
              AND NEW.start_time > now() + public._publish_notify_lead_interval();

    IF _defer THEN
      RETURN NULL;
    END IF;

    _title := 'Nuevo examen publicado';
    _body := COALESCE(NEW.title, 'Examen sin título') ||
             CASE WHEN NEW.start_time IS NOT NULL
                  THEN ' — disponible desde ' || to_char(NEW.start_time, 'DD/MM/YYYY HH24:MI')
                  ELSE '' END;
  ELSE
    _title := 'Examen actualizado';
    _body := COALESCE(NEW.title, 'Examen') || ' fue modificado por el docente. Revisa los cambios.';
  END IF;

  -- A quién: todo el curso, salvo que sea una recuperación (ver arriba).
  PERFORM public._notify_exam_publication(
    NEW.id, NEW.course_id, NEW.parent_exam_id, _title, _body
  );

  IF _is_publish_event THEN
    UPDATE public.exams SET publish_notified_at = now()
     WHERE id = NEW.id AND publish_notified_at IS NULL;
  END IF;

  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION public.dispatch_deferred_publish_notifications()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  _row RECORD;
  _title TEXT;
  _body TEXT;
  _count INTEGER := 0;
BEGIN
  IF to_regclass('public.workshops') IS NOT NULL THEN
    FOR _row IN
      SELECT id, course_id, title, due_date
        FROM public.workshops
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND publish_notified_at IS NULL
         AND start_date IS NOT NULL
         AND start_date <= now() + public._publish_notify_lead_interval()
    LOOP
      _title := 'Nuevo taller publicado';
      _body := COALESCE(_row.title, 'Taller sin título') ||
               CASE WHEN _row.due_date IS NOT NULL
                    THEN ' — entrega hasta ' || to_char(_row.due_date, 'DD/MM/YYYY HH24:MI')
                    ELSE '' END;

      PERFORM public.notify_course_students(
        _row.course_id, _title, _body, 'workshop',
        '/app/student/workshops', 'Docente'
      );

      UPDATE public.workshops SET publish_notified_at = now()
       WHERE id = _row.id AND publish_notified_at IS NULL;

      _count := _count + 1;
    END LOOP;
  END IF;

  IF to_regclass('public.exams') IS NOT NULL THEN
    FOR _row IN
      SELECT id, course_id, parent_exam_id, title, start_time
        FROM public.exams
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND publish_notified_at IS NULL
         AND start_time IS NOT NULL
         AND start_time <= now() + public._publish_notify_lead_interval()
    LOOP
      _title := 'Nuevo examen publicado';
      _body := COALESCE(_row.title, 'Examen sin título') ||
               CASE WHEN _row.start_time IS NOT NULL
                    THEN ' — disponible desde ' || to_char(_row.start_time, 'DD/MM/YYYY HH24:MI')
                    ELSE '' END;

      -- A quién: todo el curso, salvo que sea una recuperación.
      PERFORM public._notify_exam_publication(
        _row.id, _row.course_id, _row.parent_exam_id, _title, _body
      );

      UPDATE public.exams SET publish_notified_at = now()
       WHERE id = _row.id AND publish_notified_at IS NULL;

      _count := _count + 1;
    END LOOP;
  END IF;

  IF to_regclass('public.projects') IS NOT NULL THEN
    FOR _row IN
      SELECT id, course_id, title, due_date
        FROM public.projects
       WHERE status = 'published'
         AND deleted_at IS NULL
         AND publish_notified_at IS NULL
         AND start_date IS NOT NULL
         AND start_date <= now() + public._publish_notify_lead_interval()
    LOOP
      _title := 'Nuevo proyecto publicado';
      _body := COALESCE(_row.title, 'Proyecto sin título') ||
               CASE WHEN _row.due_date IS NOT NULL
                    THEN ' — entrega hasta ' || to_char(_row.due_date, 'DD/MM/YYYY HH24:MI')
                    ELSE '' END;

      PERFORM public.notify_course_students(
        _row.course_id, _title, _body, 'project',
        '/app/student/projects', 'Docente'
      );

      UPDATE public.projects SET publish_notified_at = now()
       WHERE id = _row.id AND publish_notified_at IS NULL;

      _count := _count + 1;
    END LOOP;
  END IF;

  RETURN _count;
END
$$;

REVOKE ALL ON FUNCTION public.dispatch_deferred_publish_notifications() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dispatch_deferred_publish_notifications() FROM anon;
REVOKE ALL ON FUNCTION public.dispatch_deferred_publish_notifications() FROM authenticated;

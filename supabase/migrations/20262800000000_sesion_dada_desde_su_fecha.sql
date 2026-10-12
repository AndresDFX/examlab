-- Una sesión solo «se dio» desde su fecha.
--
-- La regla de la nota relativa (mig 20262670000000) da una sesión por dictada
-- en cuanto ALGUIEN tiene una marca de asistencia en ella. Pero una clase
-- AUTÓNOMA se marca «revisada» cuando el estudiante quiera
-- (student_review_autonomous_session no mira la fecha). Medido en 6303C el
-- 2026-10-12: tres estudiantes revisaron por adelantado la autónoma del 2 de
-- noviembre, esa sesión pasó a contar como dictada y a los otros quince les
-- contaba una falta en un corte que no había empezado (Corte 3 en 0,00 y la
-- nota final hundida).
--
-- Ahora además de la marca se exige session_date <= hoy (America/Bogota). Es
-- el mismo filtro que ya usaban los pendientes por estudiante. Espejo en el
-- cliente: sesionesDadas() de src/modules/grading/nota-relativa.ts.
--
-- Se redefinen las dos funciones que deciden «sesión dada» en SQL, con el
-- cuerpo vigente de 20262670000000 y ese único cambio:
--   1. senales_nota_relativa (lo que recibe «Mis notas» del estudiante).
--   2. generate_course_acta (la asistencia de cada corte en el acta).

CREATE OR REPLACE FUNCTION public.senales_nota_relativa(_course_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.courses c WHERE c.id = _course_id AND c.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Curso no encontrado';
  END IF;
  IF NOT (
    public.is_super_admin()
    OR public.is_admin_of_course_tenant(_course_id)
    OR EXISTS (SELECT 1 FROM public.course_teachers ct
                WHERE ct.course_id = _course_id AND ct.user_id = v_uid)
    OR EXISTS (SELECT 1 FROM public.course_enrollments ce
                WHERE ce.course_id = _course_id AND ce.user_id = v_uid)
  ) THEN
    RAISE EXCEPTION 'No autorizado para ver este curso';
  END IF;

  RETURN jsonb_build_object(
    'sesiones_dadas', COALESCE((
      SELECT jsonb_agg(s.id)
        FROM public.attendance_sessions s
       WHERE s.course_id = _course_id
         AND s.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM public.attendance_records r WHERE r.session_id = s.id)
         AND s.session_date <= (now() AT TIME ZONE 'America/Bogota')::date
    ), '[]'::jsonb),
    'examenes_con_nota', COALESCE((
      SELECT jsonb_agg(e.id)
        FROM public.exams e
       WHERE e.course_id = _course_id
         AND e.deleted_at IS NULL
         AND public._examen_tiene_notas(e.id)
    ), '[]'::jsonb),
    'talleres_con_nota', COALESCE((
      SELECT jsonb_agg(w.id)
        FROM public.workshops w
       WHERE w.deleted_at IS NULL
         AND (w.course_id = _course_id OR EXISTS (
               SELECT 1 FROM public.workshop_courses wc
                WHERE wc.workshop_id = w.id AND wc.course_id = _course_id))
         AND public._taller_tiene_notas(w.id)
    ), '[]'::jsonb),
    'proyectos_con_nota', COALESCE((
      SELECT jsonb_agg(p.id)
        FROM public.projects p
       WHERE p.deleted_at IS NULL
         AND (p.course_id = _course_id OR EXISTS (
               SELECT 1 FROM public.project_courses pc
                WHERE pc.project_id = p.id AND pc.course_id = _course_id))
         AND public._proyecto_tiene_notas(p.id)
    ), '[]'::jsonb)
  );
END
$$;

REVOKE ALL ON FUNCTION public.senales_nota_relativa(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.senales_nota_relativa(uuid) TO authenticated;

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
  v_items jsonb;
  v_cut_items jsonb;
  v_all_items jsonb;
  v_attendance_score numeric;
  v_cut_grade numeric;
  v_nota_final numeric;
  v_estado_aprobacion text;
  v_sess_dadas int;
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
    -- Los ítems del estudiante, una sola vez: cada corte filtra los suyos.
    v_items := COALESCE((
      SELECT jsonb_agg(to_jsonb(i))
        FROM public.nota_relativa_items(p_course_id, v_student.id) i
    ), '[]'::jsonb);
    FOR v_cut IN
      SELECT id, name, weight, attendance_weight
      FROM public.grade_cuts
      WHERE course_id = p_course_id
      ORDER BY position
    LOOP
      -- Solo lo que CUENTA. Un ítem que cuenta sin nota (lo debe) entra con
      -- score null, que compute_weighted_grade toma como 0 con su peso.
      v_cut_items := COALESCE((
        SELECT jsonb_agg(jsonb_build_object('weight', (it->>'weight')::numeric, 'score', it->'score'))
          FROM jsonb_array_elements(v_items) it
         WHERE (it->>'cuenta')::boolean
           AND it->>'cut_id' = v_cut.id::text
      ), '[]'::jsonb);
      -- Asistencia sobre las sesiones que SE DIERON (con al menos una marca y
      -- cuya fecha ya llegó) y que no están en la papelera.
      IF COALESCE(v_cut.attendance_weight, 0) > 0 THEN
        SELECT count(*),
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM public.attendance_records ar
                  WHERE ar.session_id = s.id
                    AND ar.user_id = v_student.id
                    AND ar.status IN ('presente', 'tarde')))
          INTO v_sess_dadas, v_present_in_cut
          FROM public.attendance_sessions s
         WHERE s.course_id = p_course_id
           AND s.cut_id = v_cut.id
           AND s.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM public.attendance_records r WHERE r.session_id = s.id)
           AND s.session_date <= (now() AT TIME ZONE 'America/Bogota')::date;
        IF v_sess_dadas > 0 THEN
          v_attendance_score := v_scale_min
            + (v_present_in_cut::numeric / v_sess_dadas::numeric) * (v_scale_max - v_scale_min);
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

    -- Lo que no cae en un corte del curso NO suma: la final son los ítems de
    -- los cortes (antes sumaba las actividades sin corte con su peso por defecto).
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

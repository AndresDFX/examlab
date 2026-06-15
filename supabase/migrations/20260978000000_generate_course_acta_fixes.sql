-- ══════════════════════════════════════════════════════════════════════
-- Arreglos a generate_course_acta — "No se pudo generar el acta" (Camacho).
--
-- Diagnóstico (workflow): el fallo al pulsar "Generar acta" se debe a que el
-- RPC hacía un INSERT plano sobre course_actas, que tiene un UNIQUE
-- (course_id, COALESCE(period_id, zero-uuid)). Al regenerar un acta que YA
-- existe (el caso del usuario), el INSERT lanza 23505 → toast genérico. Además
-- el RPC todavía leía los talleres por `workshops.course_id` (modelo viejo)
-- en vez de la tabla M:N `workshop_courses`, así que los talleres COMPARTIDOS
-- (p. ej. el "Taller Final" de Camacho) se omitían del acta.
--
-- Cambios (recrea la función de 20260619000000 con):
--   1. ON CONFLICT DO UPDATE → "Generar" REGENERA el acta (la reemplaza) en
--      vez de fallar. El diálogo ya plantea regenerar; esto lo hace sin pedir
--      borrar a mano. Nuevo snapshot + hash + generated_at/by.
--   2. Talleres vía `workshop_courses` (peso/corte POR CURSO; fallback legacy).
--   3. Filtros `deleted_at IS NULL` (papelera) en exámenes/talleres/proyectos.
--   4. RAISE claro si el curso no tiene estudiantes matriculados.
--   5. `search_path = public, extensions` (defensivo para extensions.digest;
--      la llamada ya es calificada, pero alinea con el precedente pgcrypto).
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.generate_course_acta(p_course_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
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
  v_attendance_pct numeric;
  v_attendance_score numeric;
  v_cut_grade numeric;
  v_final_items jsonb;
  v_nota_final numeric;
  v_estado_aprobacion text;
  v_sess_in_cut int;
  v_present_in_cut int;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;

  v_is_admin := public.has_role(v_user, 'Admin');
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

    FOR v_cut IN
      SELECT id, name, weight, attendance_weight
      FROM public.grade_cuts
      WHERE course_id = p_course_id
      ORDER BY position
    LOOP
      -- Exámenes del corte (1:N al curso). Papelera excluida.
      v_cut_items := COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', e.weight,
          'score', public.compute_effective_grade(s.final_override_grade, s.final_grade, s.ai_grade)
        ))
        FROM public.exams e
        LEFT JOIN public.submissions s
          ON s.exam_id = e.id AND s.user_id = v_student.id
        WHERE e.course_id = p_course_id AND e.cut_id = v_cut.id
          AND e.parent_exam_id IS NULL
          AND e.deleted_at IS NULL
      ), '[]'::jsonb);

      -- Talleres del corte VÍA workshop_courses (M:N): peso/corte POR CURSO,
      -- con fallback al peso legacy. Incluye talleres COMPARTIDOS al curso.
      v_cut_items := v_cut_items || COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', COALESCE(wc.weight, w.weight),
          'score', public.compute_effective_grade(NULL, ws.final_grade, ws.ai_grade)
        ))
        FROM public.workshop_courses wc
        JOIN public.workshops w ON w.id = wc.workshop_id
        LEFT JOIN public.workshop_submissions ws
          ON ws.workshop_id = w.id AND ws.user_id = v_student.id
        WHERE wc.course_id = p_course_id AND wc.cut_id = v_cut.id
          AND w.deleted_at IS NULL
      ), '[]'::jsonb);

      -- Proyectos del corte (via project_courses). Papelera excluida.
      v_cut_items := v_cut_items || COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', pc.weight,
          'score', public.compute_effective_grade(NULL, ps.final_grade, ps.ai_grade)
        ))
        FROM public.project_courses pc
        JOIN public.projects pr2 ON pr2.id = pc.project_id
        LEFT JOIN public.project_submissions ps
          ON ps.project_id = pc.project_id AND ps.user_id = v_student.id
        WHERE pc.course_id = p_course_id AND pc.cut_id = v_cut.id
          AND pr2.deleted_at IS NULL
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
          v_attendance_score := (v_attendance_pct / 100) * v_scale_max;
          v_cut_items := v_cut_items || jsonb_build_array(jsonb_build_object(
            'weight', v_cut.attendance_weight,
            'score', v_attendance_score
          ));
        END IF;
      END IF;

      v_cut_grade := public.compute_weighted_grade(v_cut_items);
      v_cuts_arr := v_cuts_arr || jsonb_build_object(
        'nombre', v_cut.name,
        'peso', v_cut.weight,
        'nota', v_cut_grade
      );
    END LOOP;

    v_final_items := COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'weight', (c->>'peso')::numeric,
        'score', c->'nota'
      ))
      FROM jsonb_array_elements(v_cuts_arr) c
    ), '[]'::jsonb);
    v_nota_final := public.compute_weighted_grade(v_final_items);

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

  -- Sin estudiantes matriculados → no tiene sentido un acta (y evita un
  -- documento vacío). Mensaje claro (P0001 lo pasa friendlyError).
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

  -- REGENERAR: si ya existe acta para (curso, periodo) la REEMPLAZA (nuevo
  -- snapshot/hash/fecha). Así "Generar" funciona sin pedir borrar a mano.
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
$$;

NOTIFY pgrst, 'reload schema';

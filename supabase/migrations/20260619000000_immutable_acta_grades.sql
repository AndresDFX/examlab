-- ============================================================
-- Inmutabilidad de notas en actas oficiales.
--
-- Hasta ahora `generate_course_acta` snapshot-eaba SOLO la cohorte
-- (estudiantes matriculados + identidad). Las notas se recalculaban
-- en vivo al imprimir. Eso significa que tras cambiar una nota en
-- el gradebook, la próxima impresión del acta reflejaba los nuevos
-- valores — perdíamos el valor legal del documento.
--
-- Esta migración cierra esa brecha:
--   1. Helper SQL `compute_weighted_grade(items jsonb)` — réplica
--      bit-a-bit de computeWeightedGrade() en TS. Documentado como
--      invariante cross-file (ver CLAUDE.md).
--   2. Rewrite de `generate_course_acta` para que recorra la
--      jerarquía cortes→items, calcule la nota final por estudiante
--      y la guarde en el snapshot JSONB. El hash de integridad cubre
--      esas notas — ya no se pueden alterar sin que se note.
--
-- Trade-off: replicar TS en SQL crea riesgo de divergencia. Mitigado
-- por:
--   - Tests del helper TS ya existentes (computeWeightedGrade.test.ts)
--   - Comentario explícito en ambos lados apuntando al otro
--   - Misma fórmula: items con weight≤0 ignorados; si ningún score,
--     resultado null; round(weighted_sum / total_weight, 2)
-- ============================================================

-- ── Helper: compute_weighted_grade ─────────────────────────────────
-- IMMUTABLE porque depende solo del input. Compartido por el RPC
-- abajo y futuras integraciones (analytics, exports, etc).
--
-- ⚠️  INVARIANTE: este cálculo DEBE coincidir con
--    src/modules/grading/grade.ts → computeWeightedGrade().
--    Si cambia uno, actualizar el otro. El test ts cubre la lógica.
CREATE OR REPLACE FUNCTION public.compute_weighted_grade(items jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  total_weight numeric := 0;
  weighted_sum numeric := 0;
  has_any_score boolean := false;
  item jsonb;
  w numeric;
  s numeric;
BEGIN
  IF items IS NULL OR jsonb_typeof(items) <> 'array' OR jsonb_array_length(items) = 0 THEN
    RETURN NULL;
  END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(items)
  LOOP
    w := COALESCE((item->>'weight')::numeric, 0);
    IF w <= 0 THEN
      CONTINUE;
    END IF;
    total_weight := total_weight + w;
    -- Distinguir null SQL (sin nota) vs 0 (nota cero explícita).
    -- Items sin score cuentan con su peso pero score=0 implícito;
    -- solo retornamos null cuando NINGÚN item tiene score.
    IF (item->'score') IS NOT NULL AND jsonb_typeof(item->'score') <> 'null' THEN
      s := (item->>'score')::numeric;
      weighted_sum := weighted_sum + (s * w);
      has_any_score := true;
    END IF;
  END LOOP;
  IF NOT has_any_score OR total_weight <= 0 THEN
    RETURN NULL;
  END IF;
  RETURN ROUND(weighted_sum / total_weight, 2);
END;
$$;

REVOKE ALL ON FUNCTION public.compute_weighted_grade(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_weighted_grade(jsonb) TO authenticated;

-- ── Helper: compute_effective_grade ─────────────────────────────────
-- Réplica de effectiveScore() en report-context.ts:
--   final_override_grade > final_grade > ai_grade > NULL
-- Usado por generate_course_acta para no repetir el patrón
-- COALESCE en cada query.
CREATE OR REPLACE FUNCTION public.compute_effective_grade(
  p_override numeric,
  p_final numeric,
  p_ai numeric
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(p_override, p_final, p_ai);
$$;

REVOKE ALL ON FUNCTION public.compute_effective_grade(numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.compute_effective_grade(numeric, numeric, numeric) TO authenticated;

-- ── Rewrite generate_course_acta ───────────────────────────────────
-- Cambios vs versión anterior:
--   - Calcula nota_final por estudiante (jerarquía cortes→items)
--   - Calcula estado_aprobacion (aprobado/reprobado/sin_nota)
--   - total_aprobados/reprobados ahora se llenan correctamente
--   - La estructura del snapshot mantiene los campos previos +
--     `nota_final`, `estado_aprobacion`, `cortes` por estudiante
--
-- DROP necesario porque cambia el contenido sin cambiar firma (no
-- estrictamente necesario pero limpia versiones experimentales).
CREATE OR REPLACE FUNCTION public.generate_course_acta(p_course_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

  -- Curso + relaciones (defensivo: NULLs si no FK).
  SELECT * INTO v_course FROM public.courses WHERE id = p_course_id;
  IF v_course IS NULL THEN
    RAISE EXCEPTION 'Curso no encontrado';
  END IF;

  SELECT * INTO v_period FROM public.academic_periods WHERE id = v_course.period_id;
  SELECT * INTO v_program FROM public.academic_programs WHERE id = v_course.program_id;

  -- Docente principal (primer course_teacher por orden de id).
  SELECT p.full_name, p.institutional_email INTO v_docente
  FROM public.course_teachers ct
  JOIN public.profiles p ON p.id = ct.user_id
  WHERE ct.course_id = p_course_id
  ORDER BY ct.user_id
  LIMIT 1;

  v_scale_max := COALESCE(v_course.grade_scale_max, 5);
  v_passing := COALESCE(v_course.passing_grade, 3);

  -- Iteración por estudiante. Para cada uno:
  --   1. Calcular nota por cada corte (items + asistencia)
  --   2. Promediar cortes para nota_final
  --   3. Determinar estado_aprobacion
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

    -- Por cada corte, armar items + asistencia → nota del corte.
    FOR v_cut IN
      SELECT id, name, weight, attendance_weight
      FROM public.grade_cuts
      WHERE course_id = p_course_id
      ORDER BY position
    LOOP
      -- Items: exámenes del corte. Una sola query que devuelve un array
      -- jsonb con { weight, score } por examen. parent_exam_id IS NULL
      -- excluye los supletorios — solo cuenta el examen original.
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
      ), '[]'::jsonb);

      -- Talleres del corte.
      v_cut_items := v_cut_items || COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', w.weight,
          'score', public.compute_effective_grade(NULL, ws.final_grade, ws.ai_grade)
        ))
        FROM public.workshops w
        LEFT JOIN public.workshop_submissions ws
          ON ws.workshop_id = w.id AND ws.user_id = v_student.id
        WHERE w.course_id = p_course_id AND w.cut_id = v_cut.id
      ), '[]'::jsonb);

      -- Proyectos del corte (via project_courses).
      v_cut_items := v_cut_items || COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'weight', pc.weight,
          'score', public.compute_effective_grade(NULL, ps.final_grade, ps.ai_grade)
        ))
        FROM public.project_courses pc
        LEFT JOIN public.project_submissions ps
          ON ps.project_id = pc.project_id AND ps.user_id = v_student.id
        WHERE pc.course_id = p_course_id AND pc.cut_id = v_cut.id
      ), '[]'::jsonb);

      -- Asistencia del corte: % presente × escala_max, peso = attendance_weight.
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

    -- Nota final = weighted avg de notas de corte (peso = cut.weight).
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
  RETURNING id INTO v_acta_id;

  RETURN v_acta_id;
END
$$;

NOTIFY pgrst, 'reload schema';

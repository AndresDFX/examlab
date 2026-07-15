-- ══════════════════════════════════════════════════════════════════════
-- ACTA LEGAL ↔ CERTIFICADO/GRADEBOOK: alinear la ESCALA de las notas.
--
-- generate_course_acta (y el boletín en report-context.ts, arreglado en paralelo)
-- metían las notas CRUDAS al promedio ponderado, divergiendo del gradebook —que es
-- la fuente del certificado y lo que ve el estudiante—. Tres bugs confirmados:
--
--   1) Talleres/proyectos: la nota se guarda en 0..max_score (default 100). El acta
--      la usaba CRUDA (80) mezclada con exámenes 0..5 y asistencia 0..5 → el taller
--      dominaba el weighted avg y la nota final del acta salía groseramente inflada
--      (a veces > escala) y NO coincidía con el certificado. [ALTA]
--   2) Exámenes: el gradebook re-escala la nota (0..scale_max) a [min,max] con
--      toScale; el acta usaba la cruda (0-based) → en cursos con grade_scale_min>0
--      el acta quedaba por debajo del gradebook. [MEDIA]
--   3) Items SIN corte (cut_id IS NULL): el gradebook/estudiante los INCLUYEN en la
--      nota final; el acta solo acumulaba items con cut_id = <corte> → los ignoraba
--      → nota_final del acta ≠ nota del certificado. [MEDIA]
--
-- Fix: escalar cada item al rango [min,max] del curso con la MISMA fórmula del
-- gradebook (toScale(raw, rawMax) = min + (raw/rawMax)*(max-min)); rawMax =
-- grade_scale_max para exámenes, max_score (o grade_scale_max si is_external) para
-- talleres/proyectos. La asistencia ya se escalaba bien (min + ratio*(max-min)).
-- Y acumular también los items con cut_id IS NULL en v_all_items.
--
--   4) BONUS (latente): el bloque de exámenes pasaba s.final_grade a
--      compute_effective_grade, pero submissions NO tiene esa columna (solo
--      final_override_grade + ai_grade) → "column s.final_grade does not exist".
--      Solo se disparaba al ejecutarse el bloque (cursos con cortes + exámenes),
--      por eso estaba oculto. Se pasa NULL en el arg del medio. [genera fallo → arreglado]
--
-- Solo afecta actas FUTURAS: las selladas son snapshots inmutables (no se recalculan).
-- ══════════════════════════════════════════════════════════════════════

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
        LEFT JOIN LATERAL (
          SELECT CASE
            WHEN e.retry_mode = 'average' THEN AVG(a.val)
            WHEN e.retry_mode = 'highest' THEN MAX(a.val)
            ELSE (ARRAY_AGG(a.val ORDER BY a.created_at DESC))[1]
          END AS score
          FROM (
            -- submissions NO tiene final_grade (solo final_override_grade + ai_grade);
            -- pasar s.final_grade tiraba "column does not exist" al ejecutarse el
            -- bloque de exámenes (latente: solo corría en cursos con cortes+exámenes).
            SELECT public.compute_effective_grade(s.final_override_grade, NULL, s.ai_grade) AS val,
                   s.created_at
            FROM public.submissions s
            WHERE s.exam_id = e.id AND s.user_id = v_student.id
              AND s.status IN ('completado', 'sospechoso')
          ) a
          WHERE a.val IS NOT NULL
        ) eff ON true
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
      LEFT JOIN LATERAL (
        SELECT CASE
          WHEN e.retry_mode = 'average' THEN AVG(a.val)
          WHEN e.retry_mode = 'highest' THEN MAX(a.val)
          ELSE (ARRAY_AGG(a.val ORDER BY a.created_at DESC))[1]
        END AS score
        FROM (
          SELECT public.compute_effective_grade(s.final_override_grade, NULL, s.ai_grade) AS val,
                 s.created_at
          FROM public.submissions s
          WHERE s.exam_id = e.id AND s.user_id = v_student.id
            AND s.status IN ('completado', 'sospechoso')
        ) a
        WHERE a.val IS NOT NULL
      ) eff ON true
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

NOTIFY pgrst, 'reload schema';

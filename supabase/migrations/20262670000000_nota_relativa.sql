-- ══════════════════════════════════════════════════════════════════════
-- NOTA RELATIVA — la nota cuenta solo lo que ya se dio.
--
-- Hasta acá la nota de un corte contaba TODO lo que el corte tenía
-- programado: una sesión futura entraba como falta de todo el curso, y un
-- taller que vencía la semana siguiente valía 0. Medido en UNIAJ el
-- 2026-09-30, la nota final le sumaba al curso entero las faltas de las
-- sesiones de los cortes 2 y 3, que todavía no existían.
--
-- La regla (ESPEJO de src/modules/grading/nota-relativa.ts y
-- nota-del-curso.ts; si cambia una, cambia la otra):
--
--   · Una SESIÓN se dio si alguien tiene marca de asistencia en ella. Sin
--     ninguna marca no se sabe si hubo clase: no entra.
--   · Una actividad EN LÍNEA se dio cuando cerró (pasó su plazo o el docente
--     la cerró) y cerraron las recuperaciones publicadas QUE EL ESTUDIANTE TIENE
--     ASIGNADAS (una de otros no lo hace esperar: no la puede presentar). Con el
--     curso FINALIZADO, toda en línea cuenta como dada.
--   · Una actividad EXTERNA se dio cuando tiene al menos una nota cargada
--     (ella o una recuperación). Una en línea sin plazo, igual.
--   · Por estudiante: con nota, cuenta. Sin nota en una que se dio: si la
--     entregó y falta calificarla, NO cuenta (la espera es del docente); si no
--     la entregó, cuenta como 0 — salvo que no se le haya ASIGNADO (ella ni una
--     recuperación): la RLS solo le muestra al estudiante lo asignado, así que
--     no la pudo ver. En una externa la asignación no importa. Sin nota en una
--     que no se dio: no cuenta.
--   · Corte y peso EN ESTE CURSO: manda la fila de unión (workshop_courses /
--     project_courses) si tiene corte; si no, la de la actividad cuando es de
--     este curso (`corteYPesoEnCurso`). Un peso vacío vale 0.
--   · Lo que no cae en un corte del curso NO suma a la nota final.
--
-- Qué trae la migración:
--   1. Helpers de la regla (_peso_efectivo, _actividad_se_dio, _*_tiene_notas,
--      _*_se_dio, taller_nota_en_escala) y `nota_relativa_items`, que arma los
--      ítems de un estudiante. Leen entregas de cualquier estudiante (SECURITY
--      DEFINER): se revocan a los roles de la API.
--   2. `senales_nota_relativa(curso)`: lo que el ESTUDIANTE no puede calcular
--      solo porque la RLS no le deja ver lo ajeno — qué sesiones se dieron y
--      qué actividades ya tienen notas. Solo ids, nada de notas ni de nombres.
--   3. `generate_course_acta` con la regla relativa. De paso: las sesiones en la
--      papelera ya no cuentan, los talleres anclados al curso sin fila de unión
--      aparecen, y la regla «mayor» de un taller compara en la escala del curso
--      (como el cliente) y no en crudo.
--   4. `clone_workshop` vuelve a crear la fila de `workshop_courses` y a exigir
--      el alcance por institución. La mig 20262380000000 la reprodujo desde una
--      versión vieja (20260918000000) y perdió tres cosas de las migs
--      20261016000000 y 20261033000000: el Admin quedó sin scope de institución
--      (`has_role` a secas), se podía clonar un taller en la papelera, y la
--      copia nacía SIN fila de unión — invisible en el libro de notas.
--   5. El SuperAdmin puede LEER `workshop_assignments` (antes recibía 0 filas y
--      su libro de notas tomaba todo taller como no asignado).
--   6. Reparo de datos en cursos NO finalizados: la fila de unión que falta a
--      los talleres anclados, y el corte/peso de las filas de proyecto que
--      quedaron sin corte (el auto-reparo de la pantalla de proyectos las creaba
--      con el peso por defecto de 1). Los cursos finalizados no se tocan: sus
--      actas son inmutables.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Helpers de la regla ────────────────────────────────────────────

-- Sin peso no mueve la nota (`pesoEfectivo`).
CREATE OR REPLACE FUNCTION public._peso_efectivo(p numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE WHEN p > 0 THEN p ELSE 0 END;
$$;

-- ¿Una actividad (sin sus recuperaciones) ya se dio? (`actividadSeDio`, con
-- el curso finalizado marcando como cerrada toda en línea.)
CREATE OR REPLACE FUNCTION public._actividad_se_dio(
  p_externa boolean,
  p_estado text,
  p_cierre timestamptz,
  p_alguien_con_nota boolean,
  p_curso_finalizado boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN COALESCE(p_externa, false) THEN COALESCE(p_alguien_con_nota, false)
    WHEN COALESCE(p_curso_finalizado, false) OR p_estado = 'closed' THEN true
    WHEN p_cierre IS NOT NULL THEN p_cierre <= now()
    ELSE COALESCE(p_alguien_con_nota, false)
  END;
$$;

-- ¿Algún estudiante ya tiene nota en la actividad? (`actividadesConNota`.)
CREATE OR REPLACE FUNCTION public._examen_tiene_notas(p_exam_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.submissions s
     WHERE s.exam_id = p_exam_id
       AND s.status IN ('completado', 'sospechoso')
       AND COALESCE(s.final_override_grade, s.ai_grade) IS NOT NULL
  );
$$;

CREATE OR REPLACE FUNCTION public._taller_tiene_notas(p_workshop_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.workshop_submissions ws
      JOIN public.workshops w ON w.id = ws.workshop_id
     WHERE ws.workshop_id = p_workshop_id
       AND (CASE WHEN COALESCE(w.requires_defense, false) THEN ws.final_grade
                 ELSE COALESCE(ws.final_grade, ws.ai_grade) END) IS NOT NULL
  );
$$;

CREATE OR REPLACE FUNCTION public._proyecto_tiene_notas(p_project_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.project_submissions ps
     WHERE ps.project_id = p_project_id
       AND COALESCE(ps.final_grade, ps.ai_grade) IS NOT NULL
  );
$$;

-- La actividad CON las recuperaciones publicadas que el estudiante tiene
-- asignadas (`actividadConRecuperacionesSeDio` + `recuperacionesDelEstudiante`).
CREATE OR REPLACE FUNCTION public._examen_se_dio(p_exam_id uuid, p_user_id uuid, p_curso_finalizado boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN COALESCE(e.is_external, false) THEN
      public._examen_tiene_notas(e.id) OR EXISTS (
        SELECT 1 FROM public.exams r
         WHERE r.parent_exam_id = e.id
           AND r.deleted_at IS NULL
           AND COALESCE(r.status, 'published') <> 'draft'
           AND EXISTS (SELECT 1 FROM public.exam_assignments ea
                        WHERE ea.exam_id = r.id AND ea.user_id = p_user_id)
           AND public._examen_tiene_notas(r.id))
    ELSE
      public._actividad_se_dio(false, e.status, e.end_time,
                               public._examen_tiene_notas(e.id), p_curso_finalizado)
      AND NOT EXISTS (
        SELECT 1 FROM public.exams r
         WHERE r.parent_exam_id = e.id
           AND r.deleted_at IS NULL
           AND COALESCE(r.status, 'published') <> 'draft'
           AND EXISTS (SELECT 1 FROM public.exam_assignments ea
                        WHERE ea.exam_id = r.id AND ea.user_id = p_user_id)
           AND NOT public._actividad_se_dio(COALESCE(r.is_external, false), r.status, r.end_time,
                                            public._examen_tiene_notas(r.id), p_curso_finalizado))
  END
  FROM public.exams e
  WHERE e.id = p_exam_id;
$$;

CREATE OR REPLACE FUNCTION public._taller_se_dio(p_workshop_id uuid, p_user_id uuid, p_curso_finalizado boolean)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN COALESCE(w.is_external, false) THEN
      public._taller_tiene_notas(w.id) OR EXISTS (
        SELECT 1 FROM public.workshops r
         WHERE r.parent_workshop_id = w.id
           AND r.deleted_at IS NULL
           AND COALESCE(r.status, 'published') <> 'draft'
           AND EXISTS (SELECT 1 FROM public.workshop_assignments wa
                        WHERE wa.workshop_id = r.id AND wa.user_id = p_user_id)
           AND public._taller_tiene_notas(r.id))
    ELSE
      public._actividad_se_dio(false, w.status, w.due_date,
                               public._taller_tiene_notas(w.id), p_curso_finalizado)
      AND NOT EXISTS (
        SELECT 1 FROM public.workshops r
         WHERE r.parent_workshop_id = w.id
           AND r.deleted_at IS NULL
           AND COALESCE(r.status, 'published') <> 'draft'
           AND EXISTS (SELECT 1 FROM public.workshop_assignments wa
                        WHERE wa.workshop_id = r.id AND wa.user_id = p_user_id)
           AND NOT public._actividad_se_dio(COALESCE(r.is_external, false), r.status, r.due_date,
                                            public._taller_tiene_notas(r.id), p_curso_finalizado))
  END
  FROM public.workshops w
  WHERE w.id = p_workshop_id;
$$;

-- Nota del taller CON sus recuperaciones, en la ESCALA DEL CURSO. Cada taller
-- se escala con su propio tope antes de plegar, así «mayor» compara peras con
-- peras aunque original y recuperación tengan `max_score` distinto — igual que
-- el cliente (`notaDelEstudianteEnCurso`). `workshop_effective_raw_grade`
-- pliega en crudo y queda para quien la use; el acta pasa a esta.
CREATE OR REPLACE FUNCTION public.taller_nota_en_escala(
  p_workshop_id uuid,
  p_user_id uuid,
  p_min numeric,
  p_max numeric
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_tiene_base boolean := false;
  v_base numeric;
  v_nota numeric;
  v_tope numeric;
  g record;
  r record;
BEGIN
  SELECT CASE WHEN COALESCE(w.is_external, false) THEN p_max ELSE COALESCE(w.max_score, 100) END
    INTO v_tope
    FROM public.workshops w WHERE w.id = p_workshop_id;
  SELECT * INTO g FROM public.workshop_submission_raw_grade(p_workshop_id, p_user_id);
  IF COALESCE(g.presento, false) THEN
    v_tiene_base := true;
    v_base := CASE WHEN g.nota IS NULL THEN NULL
                   ELSE p_min + (CASE WHEN v_tope > 0 THEN g.nota / v_tope ELSE 0 END) * (p_max - p_min) END;
  END IF;

  FOR r IN
    SELECT w.id,
           COALESCE(w.makeup_kind, 'supletorio') AS tipo,
           COALESCE(w.recovery_rule, 'mayor') AS regla,
           CASE WHEN COALESCE(w.is_external, false) THEN p_max ELSE COALESCE(w.max_score, 100) END AS tope
      FROM public.workshops w
     WHERE w.parent_workshop_id = p_workshop_id
       AND w.deleted_at IS NULL
       AND COALESCE(w.status, 'published') <> 'draft'
     ORDER BY w.created_at, w.id
  LOOP
    SELECT * INTO g FROM public.workshop_submission_raw_grade(r.id, p_user_id);
    IF NOT COALESCE(g.presento, false) THEN
      CONTINUE;
    END IF;
    v_nota := CASE WHEN g.nota IS NULL THEN NULL
                   ELSE p_min + (CASE WHEN r.tope > 0 THEN g.nota / r.tope ELSE 0 END) * (p_max - p_min) END;
    IF NOT v_tiene_base THEN
      v_tiene_base := true;
      v_base := v_nota;
      CONTINUE;
    END IF;
    -- Con una nota de base ya puesta, el supletorio no tiene nada que llenar.
    IF r.tipo <> 'recuperatorio' OR v_nota IS NULL THEN
      CONTINUE;
    END IF;
    IF r.regla = 'reemplaza' OR v_base IS NULL OR v_nota > v_base THEN
      v_base := v_nota;
    END IF;
  END LOOP;

  RETURN v_base;
END
$$;

-- Los ítems que arman la nota de UN estudiante en UN curso: uno por actividad
-- ORIGINAL (la recuperación se pliega en la suya), con su corte y peso en este
-- curso, la nota ya en la escala del curso y si cuenta. Espejo de
-- `notaDelEstudianteEnCurso` (nota-del-curso.ts).
CREATE OR REPLACE FUNCTION public.nota_relativa_items(p_course_id uuid, p_user_id uuid)
RETURNS TABLE (tipo text, item_id uuid, cut_id uuid, weight numeric, score numeric, cuenta boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_min numeric;
  v_max numeric;
  v_fin boolean;
BEGIN
  SELECT COALESCE(c.grade_scale_min, 0), COALESCE(c.grade_scale_max, 5),
         COALESCE(c.status = 'finalizado', false)
    INTO v_min, v_max, v_fin
    FROM public.courses c WHERE c.id = p_course_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Exámenes (1:N: su corte y su peso son los de su fila).
  RETURN QUERY
  SELECT 'examen'::text, e.id, e.cut_id, public._peso_efectivo(e.weight), x.score,
         (x.score IS NOT NULL)
         OR (x.se_dio AND (COALESCE(e.is_external, false) OR (NOT x.entrego AND x.asignada)))
    FROM public.exams e
    CROSS JOIN LATERAL (SELECT public.exam_effective_raw_grade(e.id, p_user_id) AS raw) g
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN g.raw IS NULL THEN NULL
             ELSE v_min + (CASE WHEN v_max > 0 THEN g.raw / v_max ELSE 0 END) * (v_max - v_min) END AS score,
        public._examen_se_dio(e.id, p_user_id, v_fin) AS se_dio,
        EXISTS (
          SELECT 1 FROM public.submissions s
           WHERE s.user_id = p_user_id
             AND s.status IN ('completado', 'sospechoso')
             AND (s.exam_id = e.id OR s.exam_id IN (
                   SELECT r.id FROM public.exams r
                    WHERE r.parent_exam_id = e.id
                      AND r.deleted_at IS NULL
                      AND COALESCE(r.status, 'published') <> 'draft'))
        ) AS entrego,
        EXISTS (
          SELECT 1 FROM public.exam_assignments ea
           WHERE ea.user_id = p_user_id
             AND (ea.exam_id = e.id OR ea.exam_id IN (
                   SELECT r.id FROM public.exams r
                    WHERE r.parent_exam_id = e.id
                      AND r.deleted_at IS NULL
                      AND COALESCE(r.status, 'published') <> 'draft'))
        ) AS asignada
    ) x
   WHERE e.course_id = p_course_id
     AND e.parent_exam_id IS NULL
     AND e.deleted_at IS NULL
     AND COALESCE(e.status, 'published') <> 'draft';

  -- Talleres: los de la fila de unión y los anclados a este curso.
  RETURN QUERY
  SELECT 'taller'::text, w.id, cp.cut_id, cp.weight, x.score,
         (x.score IS NOT NULL)
         OR (x.se_dio AND (COALESCE(w.is_external, false) OR (NOT x.entrego AND x.asignada)))
    FROM public.workshops w
    LEFT JOIN public.workshop_courses wc ON wc.workshop_id = w.id AND wc.course_id = p_course_id
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN wc.cut_id IS NOT NULL THEN wc.cut_id
             WHEN w.course_id = p_course_id AND w.cut_id IS NOT NULL THEN w.cut_id
             ELSE NULL END AS cut_id,
        CASE WHEN wc.cut_id IS NOT NULL THEN public._peso_efectivo(COALESCE(wc.weight, w.weight))
             WHEN w.course_id = p_course_id AND w.cut_id IS NOT NULL THEN public._peso_efectivo(w.weight)
             ELSE 0 END AS weight
    ) cp
    CROSS JOIN LATERAL (
      SELECT
        public.taller_nota_en_escala(w.id, p_user_id, v_min, v_max) AS score,
        public._taller_se_dio(w.id, p_user_id, v_fin) AS se_dio,
        COALESCE((SELECT g.presento FROM public.workshop_submission_raw_grade(w.id, p_user_id) g), false)
        OR EXISTS (
          SELECT 1 FROM public.workshops r
           WHERE r.parent_workshop_id = w.id
             AND r.deleted_at IS NULL
             AND COALESCE(r.status, 'published') <> 'draft'
             AND COALESCE((SELECT g.presento FROM public.workshop_submission_raw_grade(r.id, p_user_id) g), false)
        ) AS entrego,
        EXISTS (
          SELECT 1 FROM public.workshop_assignments wa
           WHERE wa.user_id = p_user_id
             AND (wa.workshop_id = w.id OR wa.workshop_id IN (
                   SELECT r.id FROM public.workshops r
                    WHERE r.parent_workshop_id = w.id
                      AND r.deleted_at IS NULL
                      AND COALESCE(r.status, 'published') <> 'draft'))
        ) AS asignada
    ) x
   WHERE (w.course_id = p_course_id OR wc.workshop_id IS NOT NULL)
     AND w.parent_workshop_id IS NULL
     AND w.deleted_at IS NULL
     AND COALESCE(w.status, 'published') <> 'draft';

  -- Proyectos: igual, sin recuperaciones. La entrega del GRUPO gana a una
  -- individual vieja, como en el libro de notas.
  RETURN QUERY
  SELECT 'proyecto'::text, p.id, cp.cut_id, cp.weight, x.score,
         (x.score IS NOT NULL)
         OR (x.se_dio AND (COALESCE(p.is_external, false) OR (NOT x.entrego AND x.asignada)))
    FROM public.projects p
    LEFT JOIN public.project_courses pc ON pc.project_id = p.id AND pc.course_id = p_course_id
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN pc.cut_id IS NOT NULL THEN pc.cut_id
             WHEN p.course_id = p_course_id AND p.cut_id IS NOT NULL THEN p.cut_id
             ELSE NULL END AS cut_id,
        CASE WHEN pc.cut_id IS NOT NULL THEN public._peso_efectivo(COALESCE(pc.weight, p.weight))
             WHEN p.course_id = p_course_id AND p.cut_id IS NOT NULL THEN public._peso_efectivo(p.weight)
             ELSE 0 END AS weight
    ) cp
    LEFT JOIN LATERAL (
      SELECT pss.final_grade, pss.ai_grade, pss.status
        FROM public.project_submissions pss
       WHERE pss.project_id = p.id
         AND (
           pss.user_id = p_user_id
           OR (pss.group_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.project_group_members m
                  WHERE m.group_id = pss.group_id AND m.user_id = p_user_id))
         )
       ORDER BY (pss.group_id IS NOT NULL) DESC
       LIMIT 1
    ) ps ON true
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN COALESCE(ps.final_grade, ps.ai_grade) IS NULL THEN NULL
             ELSE v_min
                  + (CASE WHEN (CASE WHEN COALESCE(p.is_external, false) THEN v_max ELSE COALESCE(p.max_score, 100) END) > 0
                          THEN COALESCE(ps.final_grade, ps.ai_grade)
                               / (CASE WHEN COALESCE(p.is_external, false) THEN v_max ELSE COALESCE(p.max_score, 100) END)
                          ELSE 0 END)
                  * (v_max - v_min) END AS score,
        public._actividad_se_dio(COALESCE(p.is_external, false), p.status, p.due_date,
                                 public._proyecto_tiene_notas(p.id), v_fin) AS se_dio,
        (ps.status IS NOT NULL AND public.estado_es_entrega(ps.status)) AS entrego,
        EXISTS (
          SELECT 1 FROM public.project_assignments pa
           WHERE pa.user_id = p_user_id AND pa.project_id = p.id
        ) AS asignada
    ) x
   WHERE (p.course_id = p_course_id OR pc.project_id IS NOT NULL)
     AND p.deleted_at IS NULL
     AND COALESCE(p.status, 'published') <> 'draft';
END
$$;

REVOKE ALL ON FUNCTION public._peso_efectivo(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._actividad_se_dio(boolean, text, timestamptz, boolean, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._examen_tiene_notas(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._taller_tiene_notas(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._proyecto_tiene_notas(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._examen_se_dio(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._taller_se_dio(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.taller_nota_en_escala(uuid, uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nota_relativa_items(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── 2) Señales para «Mis notas» ───────────────────────────────────────
-- El estudiante solo ve SUS marcas y SUS entregas (RLS), así que no puede
-- saber por su cuenta si una sesión se dio o si una actividad externa ya se
-- evaluó. Esto le da exactamente eso: ids, sin notas ni nombres de nadie.
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

-- ── 3) El acta con la regla relativa ──────────────────────────────────
-- La definición vigente (mig 20262660000000) con el armado de ítems y de
-- asistencia pasado a la regla relativa. Autorización, snapshot y guardado
-- quedan igual.
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
      -- Asistencia sobre las sesiones que SE DIERON (con al menos una marca) y
      -- que no están en la papelera.
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
           AND EXISTS (SELECT 1 FROM public.attendance_records r WHERE r.session_id = s.id);
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

-- ── 4) clone_workshop: el cuerpo de 20261033000000 + `requires_defense` ──
-- Firma sin cambios → CREATE OR REPLACE. La fila de unión copia peso y corte
-- de la del ORIGEN en su curso (con respaldo en la del taller); el corte solo
-- si el destino es el mismo curso, igual que la fila del taller.
CREATE OR REPLACE FUNCTION public.clone_workshop(
  _source_id        UUID,
  _target_course_id UUID,
  _new_title        TEXT DEFAULT NULL,
  _new_start_date   TIMESTAMPTZ DEFAULT NULL,
  _new_due_date     TIMESTAMPTZ DEFAULT NULL,
  _copy_questions   BOOLEAN DEFAULT true,
  _copy_groups      BOOLEAN DEFAULT true
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _new_id UUID;
  _final_title TEXT;
BEGIN
  IF NOT (
    (
      public.is_admin_of_course_tenant((SELECT w.course_id FROM public.workshops w WHERE w.id = _source_id))
      AND public.is_admin_of_course_tenant(_target_course_id)
    )
    OR (
      EXISTS (
        SELECT 1 FROM public.workshops w
        JOIN public.course_teachers ct ON ct.course_id = w.course_id
        WHERE w.id = _source_id AND ct.user_id = auth.uid()
      )
      AND EXISTS (
        SELECT 1 FROM public.course_teachers ct
        WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
      )
    )
  ) THEN
    RAISE EXCEPTION 'No autorizado para clonar este taller al curso destino';
  END IF;

  -- Papelera: no se puede clonar un taller origen en la papelera.
  IF (SELECT w.deleted_at FROM public.workshops w WHERE w.id = _source_id) IS NOT NULL THEN
    RAISE EXCEPTION 'No se puede clonar: el taller origen está en la papelera';
  END IF;

  SELECT COALESCE(_new_title, 'Copia de ' || w.title)
    INTO _final_title
    FROM public.workshops w WHERE w.id = _source_id;

  INSERT INTO public.workshops (
    course_id, created_by, title, description, instructions, start_date, due_date,
    status, weight, is_external, group_mode, group_size_min, group_size_max,
    max_score, cut_id, requires_defense
  )
  SELECT
    _target_course_id, auth.uid(), _final_title, w.description, w.instructions,
    COALESCE(_new_start_date, w.start_date),
    COALESCE(_new_due_date, w.due_date),
    'draft', w.weight, w.is_external,
    CASE WHEN _copy_groups THEN w.group_mode ELSE 'individual' END,
    CASE WHEN _copy_groups THEN w.group_size_min ELSE NULL END,
    CASE WHEN _copy_groups THEN w.group_size_max ELSE NULL END,
    w.max_score,
    CASE WHEN _target_course_id = w.course_id THEN w.cut_id ELSE NULL END,
    w.requires_defense
  FROM public.workshops w WHERE w.id = _source_id
  RETURNING id INTO _new_id;

  -- Fila M:N para el curso destino (fuente de verdad de peso/corte en notas).
  INSERT INTO public.workshop_courses (workshop_id, course_id, weight, cut_id)
  SELECT
    _new_id,
    _target_course_id,
    COALESCE(wc.weight, w.weight),
    CASE WHEN _target_course_id = w.course_id THEN COALESCE(wc.cut_id, w.cut_id) ELSE NULL END
  FROM public.workshops w
  LEFT JOIN public.workshop_courses wc
    ON wc.workshop_id = w.id AND wc.course_id = w.course_id
  WHERE w.id = _source_id
  ON CONFLICT (workshop_id, course_id) DO NOTHING;

  IF _copy_questions THEN
    INSERT INTO public.workshop_questions (
      workshop_id, type, content, options, expected_rubric, language, starter_code,
      points, position
    )
    SELECT
      _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
      q.points, q.position
    FROM public.workshop_questions q
    WHERE q.workshop_id = _source_id;
  END IF;

  RETURN _new_id;
END
$function$;

-- ── 5) El SuperAdmin LEE las asignaciones de talleres ─────────────────
-- La nota ahora mira qué tiene asignado cada estudiante, y la SELECT de
-- `workshop_assignments` (mig 20260994000000) solo deja leer al dueño y a
-- Docente/Admin del tenant: el SuperAdmin recibía 0 filas. Su libro de notas y
-- su boletín tomaban entonces TODO taller como no asignado — notas infladas, y
-- el SuperAdmin puede emitir certificados desde ese libro. Misma convención que
-- la mig 20260602100000 (lectura cross-tenant con `is_super_admin()`); las
-- asignaciones de exámenes y proyectos ya se las dejaban leer. Solo SELECT.
DO $$
BEGIN
  IF to_regclass('public.workshop_assignments') IS NOT NULL THEN
    DROP POLICY IF EXISTS workshop_assignments_select_superadmin ON public.workshop_assignments;
    CREATE POLICY workshop_assignments_select_superadmin
      ON public.workshop_assignments FOR SELECT TO authenticated
      USING (public.is_super_admin());
  END IF;
END
$$;

-- ── 6) Reparo de datos (solo cursos NO finalizados) ───────────────────
DO $$
DECLARE
  v_n int;
BEGIN
  IF to_regclass('public.workshop_courses') IS NOT NULL THEN
    -- La fila de unión que falta a un taller en su curso ancla: la que la
    -- pantalla de talleres habría creado, con el corte y el peso del taller.
    INSERT INTO public.workshop_courses (workshop_id, course_id, cut_id, weight)
    SELECT w.id, w.course_id,
           CASE WHEN EXISTS (SELECT 1 FROM public.grade_cuts gc
                              WHERE gc.id = w.cut_id AND gc.course_id = w.course_id)
                THEN w.cut_id ELSE NULL END,
           w.weight
      FROM public.workshops w
      JOIN public.courses c ON c.id = w.course_id
     WHERE w.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND COALESCE(c.status, '') <> 'finalizado'
       AND NOT EXISTS (SELECT 1 FROM public.workshop_courses wc
                        WHERE wc.workshop_id = w.id AND wc.course_id = w.course_id)
    ON CONFLICT (workshop_id, course_id) DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'nota relativa: % filas de workshop_courses creadas', v_n;
  END IF;

  IF to_regclass('public.project_courses') IS NOT NULL THEN
    -- Fila de unión de proyecto SIN corte, en el curso ancla, con un corte de
    -- ese curso en la fila del proyecto: toma corte y peso del proyecto (es lo
    -- que la lista del estudiante ya mostraba por `filaQueManda`).
    UPDATE public.project_courses pc
       SET cut_id = p.cut_id,
           weight = COALESCE(p.weight, pc.weight)
      FROM public.projects p
      JOIN public.courses c ON c.id = p.course_id
     WHERE pc.project_id = p.id
       AND pc.course_id = p.course_id
       AND pc.cut_id IS NULL
       AND p.cut_id IS NOT NULL
       AND p.deleted_at IS NULL
       AND c.deleted_at IS NULL
       AND COALESCE(c.status, '') <> 'finalizado'
       AND EXISTS (SELECT 1 FROM public.grade_cuts gc
                    WHERE gc.id = p.cut_id AND gc.course_id = p.course_id);
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE 'nota relativa: % filas de project_courses con corte recuperado', v_n;
  END IF;
END
$$;

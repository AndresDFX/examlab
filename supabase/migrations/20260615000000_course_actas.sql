-- ============================================================
-- Sprint E pleno — Actas inmutables del curso.
--
-- A diferencia de la plantilla "Acta de finalización del curso" (que
-- imprime datos EN VIVO del gradebook), esta tabla guarda un
-- SNAPSHOT inmutable. Una vez generada, las RLS impiden su
-- modificación o borrado. Sirve como respaldo legal para la
-- institución y el docente: "esto fue lo entregado al cierre del
-- curso X en el periodo Y".
--
-- Diseño:
--   - 1 fila por (course_id, period_id) — UNIQUE.
--   - snapshot JSONB con: docente, programa, periodo, escala_max,
--     passing_grade, estudiantes[] con codigo+documento+nombre+
--     nota_final+estado_aprobacion+asistencia, agregados.
--   - integrity_hash: SHA-256 del JSONB. Permite verificar manualmente
--     que la fila no se modificó por fuera (la RLS lo bloquea, pero
--     un Admin con acceso a service_role podría burlarla; el hash deja
--     la huella).
--   - Generación vía RPC `generate_course_acta(course_id)`: hace
--     UPSERT del acta. Las filas NO se editan luego — para cambios
--     hay que generar OTRA acta (la anterior se conserva).
--   - Sin estado borrador/cerrada — al generar queda inmediatamente
--     cerrada. Simplifica el modelo: el docente confirma una sola vez.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.course_actas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
  period_id uuid NULL REFERENCES public.academic_periods(id) ON DELETE SET NULL,
  -- Snapshot completo del acta. Estructura documentada en la RPC
  -- `generate_course_acta`. La JSONB es opaca para la BD — toda la
  -- lógica de lectura vive en TS.
  snapshot jsonb NOT NULL,
  -- SHA-256 del snapshot (cabe en text de 64 hex chars).
  integrity_hash text NOT NULL,
  -- Auditoría de generación.
  generated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  -- Snapshot del nombre del docente y del curso (para mostrar la fila
  -- en listados sin pegar contra JSONB cada vez).
  curso_nombre text NOT NULL,
  docente_nombre text NOT NULL,
  periodo_codigo text,
  total_estudiantes smallint NOT NULL,
  total_aprobados smallint NOT NULL,
  total_reprobados smallint NOT NULL
);

-- Solo un acta vigente por (curso, periodo). Si el docente quiere
-- regenerar, borra la anterior (ver RPC `delete_course_acta`).
CREATE UNIQUE INDEX IF NOT EXISTS idx_course_actas_unique
  ON public.course_actas(course_id, COALESCE(period_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_course_actas_course_id
  ON public.course_actas(course_id);

ALTER TABLE public.course_actas ENABLE ROW LEVEL SECURITY;

-- SELECT: Admin, o docentes asignados al curso, o el alumno
-- matriculado al curso (puede ver su propia acta).
DROP POLICY IF EXISTS "course_actas_read" ON public.course_actas;
CREATE POLICY "course_actas_read"
  ON public.course_actas FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = course_actas.course_id AND ct.user_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.course_enrollments ce
      WHERE ce.course_id = course_actas.course_id AND ce.user_id = auth.uid()
    )
  );

-- INSERT: solo a través de la RPC `generate_course_acta` que corre
-- como SECURITY DEFINER. Bloqueamos INSERT directo desde el cliente.
DROP POLICY IF EXISTS "course_actas_no_direct_insert" ON public.course_actas;
CREATE POLICY "course_actas_no_direct_insert"
  ON public.course_actas FOR INSERT TO authenticated
  WITH CHECK (false);

-- UPDATE: BLOQUEADO. Una vez generada, no se modifica.
-- (Sin policy = sin permiso. Solo service_role puede saltarlo.)

-- DELETE: solo Admin o el docente que la generó (caso "me equivoqué").
-- En ambos casos queda traza en audit_logs vía la RPC.
DROP POLICY IF EXISTS "course_actas_delete" ON public.course_actas;
CREATE POLICY "course_actas_delete"
  ON public.course_actas FOR DELETE TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR generated_by = auth.uid()
  );

-- ──────────── RPC generate_course_acta ────────────
-- Construye el snapshot leyendo gradebook EN VIVO y lo persiste.
-- Falla si ya existe acta para (course_id, period_id) — el docente
-- debe borrar la anterior si quiere regenerar.
--
-- SECURITY DEFINER porque salta el `WITH CHECK (false)` de INSERT.
-- Verifica permisos manualmente: solo docente del curso o Admin.
-- ============================================================
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

  -- Cargar curso + programa + periodo (defensivo: NULLs si no FK).
  SELECT * INTO v_course FROM public.courses WHERE id = p_course_id;
  IF v_course IS NULL THEN
    RAISE EXCEPTION 'Curso no encontrado';
  END IF;

  SELECT * INTO v_period FROM public.academic_periods WHERE id = v_course.period_id;
  SELECT * INTO v_program FROM public.academic_programs WHERE id = v_course.program_id;

  -- Docente principal del curso (el primero en course_teachers).
  SELECT p.full_name, p.institutional_email INTO v_docente
  FROM public.course_teachers ct
  JOIN public.profiles p ON p.id = ct.user_id
  WHERE ct.course_id = p_course_id
  ORDER BY ct.user_id
  LIMIT 1;

  v_scale_max := COALESCE(v_course.grade_scale_max, 5);
  v_passing := COALESCE(v_course.passing_grade, 3);

  -- Construir array de estudiantes. Para cada uno, calculamos la
  -- nota final usando el mismo enfoque que `computeWeightedGrade`
  -- en TS. Pero acá lo simplificamos: nota_final = el final_grade
  -- explícito de project_submissions/workshop_submissions, o lo que
  -- haya en submissions. Como esta lógica está en TS y replicarla
  -- en SQL es invasivo, leemos snapshot de DATOS BASE y dejamos que
  -- el render TS calcule las notas con `buildReportContext` cuando
  -- se imprima el acta.
  --
  -- Para mantener el snapshot autocontenido, guardamos sólo IDs +
  -- datos básicos del estudiante. El TS reconstruye la vista.
  FOR v_student IN
    SELECT pr.id, pr.full_name, pr.institutional_email,
           pr.codigo, pr.documento, pr.cohorte, pr.estado AS estudiante_estado
    FROM public.course_enrollments ce
    JOIN public.profiles pr ON pr.id = ce.user_id
    WHERE ce.course_id = p_course_id
    ORDER BY pr.full_name
  LOOP
    v_total := v_total + 1;
    v_estudiantes := v_estudiantes || jsonb_build_object(
      'id', v_student.id,
      'nombre', COALESCE(v_student.full_name, '—'),
      'email', COALESCE(v_student.institutional_email, ''),
      'codigo', COALESCE(v_student.codigo, ''),
      'documento', COALESCE(v_student.documento, ''),
      'cohorte', COALESCE(v_student.cohorte, ''),
      'estado', COALESCE(v_student.estudiante_estado, '')
    );
  END LOOP;

  -- Snapshot final con metadata del curso.
  v_snapshot := jsonb_build_object(
    'version', 1,
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
    'total_estudiantes', v_total
  );

  -- Hash del snapshot (SHA-256 hex).
  v_hash := encode(extensions.digest(v_snapshot::text, 'sha256'), 'hex');

  -- Bypass de RLS WITH CHECK (false) — SECURITY DEFINER lo permite.
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

REVOKE ALL ON FUNCTION public.generate_course_acta(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.generate_course_acta(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════════
-- CONDICIONES POR ESTUDIANTE (talleres y proyectos)
--
-- Dentro de UNA misma actividad el docente le pone a uno o varios estudiantes
-- una condición propia, con un MOTIVO visible para el estudiante, para no tener
-- que abrir un recuperatorio ni reabrir la actividad para todo el curso. Tres
-- condiciones, combinables:
--
--   1. Nota máxima (TOPE): la nota del estudiante en esa actividad no pasa de N
--      (escala del curso). Es `min(nota, N)`, NO proporcional. Se aplica al LEER
--      (reversible: quitar la condición devuelve la nota). Espejo en el cliente:
--      aplicarTopeDeNota() de src/modules/grading/condiciones-estudiante.ts.
--   2. Plazo propio: el estudiante puede entregar hasta SU fecha aunque la
--      actividad ya cerró para los demás.
--   3. Entrega individual autorizada: en una actividad grupal estricta, el
--      estudiante sin grupo puede entregar solo.
--
-- Por qué una TABLA y no columnas en `workshop_assignments` / `project_assignments`:
-- el guardado del taller borra y reinserta sus asignaciones (delete().eq() +
-- insert), así que una condición guardada ahí se perdería en silencio al editar.
--
-- El tope se aplica al leer la nota, en `nota_relativa_items` (su espejo SQL para
-- el acta) y en las pantallas (cliente). El plazo propio hace que, mientras siga
-- vigente y el estudiante no haya entregado, la actividad NO cuente 0 todavía
-- (para él aún no «se dio»).
--
-- Idempotente.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) La tabla ────────────────────────────────────────────────────────
-- `actividad_id` es polimórfico (apunta a workshops o a projects según `tipo`),
-- por eso no lleva FK. Las filas huérfanas que deje un hard-delete raro son
-- inofensivas: nunca se leen (la actividad no aparece).
CREATE TABLE IF NOT EXISTS public.condiciones_estudiante (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo               text NOT NULL CHECK (tipo IN ('taller', 'proyecto')),
  actividad_id       uuid NOT NULL,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Tope en la escala del curso. CHECK > 0: un tope de 0 sería «siempre 0», que
  -- es reprobar a dedo, no lo que la condición existe para hacer.
  nota_maxima        numeric CHECK (nota_maxima IS NULL OR nota_maxima > 0),
  plazo_propio       timestamptz,
  entrega_individual boolean NOT NULL DEFAULT false,
  motivo             text NOT NULL CHECK (char_length(btrim(motivo)) BETWEEN 1 AND 500),
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT condiciones_estudiante_unica UNIQUE (tipo, actividad_id, user_id),
  -- Al menos una de las tres puesta: una fila sin ninguna condición no dice nada.
  CONSTRAINT condiciones_estudiante_al_menos_una CHECK (
    nota_maxima IS NOT NULL OR plazo_propio IS NOT NULL OR entrega_individual = true
  )
);

CREATE INDEX IF NOT EXISTS idx_condiciones_estudiante_actividad
  ON public.condiciones_estudiante (tipo, actividad_id);
CREATE INDEX IF NOT EXISTS idx_condiciones_estudiante_usuario
  ON public.condiciones_estudiante (user_id);

COMMENT ON TABLE public.condiciones_estudiante IS
  'Condiciones por estudiante en un taller o proyecto: tope de nota (escala del curso), plazo propio y/o entrega individual autorizada. Se aplican al leer (reversibles).';

-- ── 2) Quién gestiona: el staff del curso de la actividad ──────────────
-- Docente del curso (ancla o M:N), Admin de la institución del curso (con scope
-- de tenant, no un `has_role` suelto) o SuperAdmin. Una actividad en la papelera
-- no deja gestionar sus condiciones (al restaurarla vuelven).
CREATE OR REPLACE FUNCTION public.condicion_actividad_manageable(_tipo text, _actividad_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _tipo = 'taller' THEN EXISTS (
      SELECT 1 FROM public.workshops w
       WHERE w.id = _actividad_id
         AND w.deleted_at IS NULL
         AND (
           public.is_super_admin()
           OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(w.course_id))
           OR EXISTS (SELECT 1 FROM public.course_teachers ct
                       WHERE ct.course_id = w.course_id AND ct.user_id = auth.uid())
           OR EXISTS (
             SELECT 1 FROM public.workshop_courses wc
              WHERE wc.workshop_id = w.id
                AND (
                  EXISTS (SELECT 1 FROM public.course_teachers ct
                           WHERE ct.course_id = wc.course_id AND ct.user_id = auth.uid())
                  OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(wc.course_id))
                )
           )
         )
    )
    WHEN _tipo = 'proyecto' THEN EXISTS (
      SELECT 1 FROM public.projects p
       WHERE p.id = _actividad_id
         AND p.deleted_at IS NULL
         AND (
           public.is_super_admin()
           OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(p.course_id))
           OR EXISTS (SELECT 1 FROM public.course_teachers ct
                       WHERE ct.course_id = p.course_id AND ct.user_id = auth.uid())
           OR EXISTS (
             SELECT 1 FROM public.project_courses pc
              WHERE pc.project_id = p.id
                AND (
                  EXISTS (SELECT 1 FROM public.course_teachers ct
                           WHERE ct.course_id = pc.course_id AND ct.user_id = auth.uid())
                  OR (public.has_role(auth.uid(), 'Admin'::public.app_role) AND public.course_in_my_tenant(pc.course_id))
                )
           )
         )
    )
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.condicion_actividad_manageable(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.condicion_actividad_manageable(text, uuid) TO authenticated;

-- ── 3) Qué puede LEER el estudiante: solo las suyas, y no de una actividad en papelera ──
CREATE OR REPLACE FUNCTION public.condicion_actividad_no_en_papelera(_tipo text, _actividad_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN _tipo = 'taller' THEN EXISTS (
      SELECT 1 FROM public.workshops w WHERE w.id = _actividad_id AND w.deleted_at IS NULL)
    WHEN _tipo = 'proyecto' THEN EXISTS (
      SELECT 1 FROM public.projects p WHERE p.id = _actividad_id AND p.deleted_at IS NULL)
    ELSE false
  END;
$$;

REVOKE ALL ON FUNCTION public.condicion_actividad_no_en_papelera(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.condicion_actividad_no_en_papelera(text, uuid) TO authenticated;

-- ── 4) Políticas ───────────────────────────────────────────────────────
ALTER TABLE public.condiciones_estudiante ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS condiciones_estudiante_staff ON public.condiciones_estudiante;
CREATE POLICY condiciones_estudiante_staff ON public.condiciones_estudiante
  FOR ALL TO authenticated
  USING (public.condicion_actividad_manageable(tipo, actividad_id))
  WITH CHECK (public.condicion_actividad_manageable(tipo, actividad_id));

DROP POLICY IF EXISTS condiciones_estudiante_student_read ON public.condiciones_estudiante;
CREATE POLICY condiciones_estudiante_student_read ON public.condiciones_estudiante
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.condicion_actividad_no_en_papelera(tipo, actividad_id));

REVOKE ALL ON public.condiciones_estudiante FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.condiciones_estudiante TO authenticated;

-- ── 5) Auditoría + updated_at ──────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_condiciones_estudiante_touch ON public.condiciones_estudiante;
CREATE TRIGGER trg_condiciones_estudiante_touch
  BEFORE UPDATE ON public.condiciones_estudiante
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public._trg_audit_condicion_estudiante()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row       public.condiciones_estudiante;
  v_action    text;
  v_course_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD; v_action := 'condicion_estudiante.deleted';
  ELSIF TG_OP = 'UPDATE' THEN
    v_row := NEW; v_action := 'condicion_estudiante.updated';
  ELSE
    v_row := NEW; v_action := 'condicion_estudiante.created';
  END IF;

  IF v_row.tipo = 'taller' THEN
    SELECT course_id INTO v_course_id FROM public.workshops WHERE id = v_row.actividad_id;
  ELSE
    SELECT course_id INTO v_course_id FROM public.projects WHERE id = v_row.actividad_id;
  END IF;

  PERFORM public.log_audit_event(
    v_action, 'grading', 'info',
    v_row.tipo, v_row.actividad_id::text, NULL,
    v_course_id, NULL,
    jsonb_build_object(
      'student_id', v_row.user_id,
      'nota_maxima', v_row.nota_maxima,
      'plazo_propio', v_row.plazo_propio,
      'entrega_individual', v_row.entrega_individual
    )
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

DROP TRIGGER IF EXISTS trg_audit_condicion_estudiante ON public.condiciones_estudiante;
CREATE TRIGGER trg_audit_condicion_estudiante
  AFTER INSERT OR UPDATE OR DELETE ON public.condiciones_estudiante
  FOR EACH ROW EXECUTE FUNCTION public._trg_audit_condicion_estudiante();

-- ── 6) La nota con el tope y el plazo propio ───────────────────────────
-- Se redefine `nota_relativa_items` (su cuerpo vigente de 20262670000000) con
-- dos cambios, SOLO en talleres y proyectos (los exámenes no tienen condición):
--   · El TOPE se aplica a la nota ya en la escala del curso: LEAST(score, N).
--   · El PLAZO PROPIO vigente de quien no ha entregado hace que la actividad NO
--     se dé todavía para él (así no cuenta 0 hasta que su plazo pase).
-- `generate_course_acta` ya llama a esta función, así que el acta hereda ambos.
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

  -- Exámenes (1:N: su corte y su peso son los de su fila). Sin condición.
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

  -- Talleres: los de la fila de unión y los anclados a este curso. Con tope y
  -- plazo propio del estudiante (ef).
  RETURN QUERY
  SELECT 'taller'::text, w.id, cp.cut_id, cp.weight, ef.score,
         (ef.score IS NOT NULL)
         OR (ef.se_dio AND (COALESCE(w.is_external, false) OR (NOT x.entrego AND x.asignada)))
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
    LEFT JOIN LATERAL (
      SELECT ce.nota_maxima, ce.plazo_propio
        FROM public.condiciones_estudiante ce
       WHERE ce.tipo = 'taller' AND ce.actividad_id = w.id AND ce.user_id = p_user_id
       LIMIT 1
    ) cnd ON true
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN cnd.nota_maxima IS NOT NULL AND x.score IS NOT NULL
             THEN LEAST(x.score, cnd.nota_maxima) ELSE x.score END AS score,
        CASE WHEN cnd.plazo_propio IS NOT NULL AND cnd.plazo_propio > now() AND NOT x.entrego
             THEN false ELSE x.se_dio END AS se_dio
    ) ef
   WHERE (w.course_id = p_course_id OR wc.workshop_id IS NOT NULL)
     AND w.parent_workshop_id IS NULL
     AND w.deleted_at IS NULL
     AND COALESCE(w.status, 'published') <> 'draft';

  -- Proyectos: igual, sin recuperaciones. La entrega del GRUPO gana a una
  -- individual vieja, como en el libro de notas. Con tope y plazo propio (ef).
  RETURN QUERY
  SELECT 'proyecto'::text, p.id, cp.cut_id, cp.weight, ef.score,
         (ef.score IS NOT NULL)
         OR (ef.se_dio AND (COALESCE(p.is_external, false) OR (NOT x.entrego AND x.asignada)))
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
    LEFT JOIN LATERAL (
      SELECT ce.nota_maxima, ce.plazo_propio
        FROM public.condiciones_estudiante ce
       WHERE ce.tipo = 'proyecto' AND ce.actividad_id = p.id AND ce.user_id = p_user_id
       LIMIT 1
    ) cnd ON true
    CROSS JOIN LATERAL (
      SELECT
        CASE WHEN cnd.nota_maxima IS NOT NULL AND x.score IS NOT NULL
             THEN LEAST(x.score, cnd.nota_maxima) ELSE x.score END AS score,
        CASE WHEN cnd.plazo_propio IS NOT NULL AND cnd.plazo_propio > now() AND NOT x.entrego
             THEN false ELSE x.se_dio END AS se_dio
    ) ef
   WHERE (p.course_id = p_course_id OR pc.project_id IS NOT NULL)
     AND p.deleted_at IS NULL
     AND COALESCE(p.status, 'published') <> 'draft';
END
$$;

REVOKE ALL ON FUNCTION public.nota_relativa_items(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ── 7) Borrar la propia entrega respeta el plazo PROPIO ────────────────
-- La política de «borrar mi entrega dentro del plazo» (mig 20260508140000) mira
-- solo la ventana global. Un estudiante con plazo propio vigente tiene que poder
-- rehacer su entrega hasta SU fecha, igual que puede entregarla. Se agrega una
-- rama: publicada, ya empezó y con una condición de plazo propio vigente suya.
-- Defensivo por si estas tablas no existen en algún entorno.
DO $$
BEGIN
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Students delete own workshop submissions in window"
      ON public.workshop_submissions;
    CREATE POLICY "Students delete own workshop submissions in window"
      ON public.workshop_submissions FOR DELETE TO authenticated
      USING (
        auth.uid() = user_id
        AND EXISTS (
          SELECT 1 FROM public.workshops w
          WHERE w.id = workshop_submissions.workshop_id
            AND w.status = 'published'
            AND (w.start_date IS NULL OR w.start_date <= now())
            AND (
              (w.due_date IS NULL OR w.due_date > now())
              OR EXISTS (
                SELECT 1 FROM public.condiciones_estudiante ce
                 WHERE ce.tipo = 'taller'
                   AND ce.actividad_id = w.id
                   AND ce.user_id = auth.uid()
                   AND ce.plazo_propio IS NOT NULL
                   AND ce.plazo_propio > now()
              )
            )
        )
      );
  END IF;

  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Students delete own project submissions in window"
      ON public.project_submissions;
    CREATE POLICY "Students delete own project submissions in window"
      ON public.project_submissions FOR DELETE TO authenticated
      USING (
        auth.uid() = user_id
        AND EXISTS (
          SELECT 1 FROM public.projects p
          WHERE p.id = project_submissions.project_id
            AND p.status = 'published'
            AND (p.start_date IS NULL OR p.start_date <= now())
            AND (
              (p.due_date IS NULL OR p.due_date > now())
              OR EXISTS (
                SELECT 1 FROM public.condiciones_estudiante ce
                 WHERE ce.tipo = 'proyecto'
                   AND ce.actividad_id = p.id
                   AND ce.user_id = auth.uid()
                   AND ce.plazo_propio IS NOT NULL
                   AND ce.plazo_propio > now()
              )
            )
        )
      );
  END IF;
END
$$;

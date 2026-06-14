-- ──────────────────────────────────────────────────────────────────────
-- Recompute automático de `project_submissions.submission_grade`
--
-- Bug reportado (tenant Camacho, proyecto "VetCare"):
--   La IA calificaba correctamente CADA archivo del proyecto
--   (`project_submission_files.ai_grade`) pero `project_submissions.
--   submission_grade` quedaba en 0. Resultado: el docente veía notas
--   correctas en cada archivo pero la nota global salía 0.
--
-- Causa raíz: el worker IA (ai-grade-submission, modo projectFullGrading)
-- hace UPDATE de cada file individualmente pero NO recalcula la
-- ponderada en la fila padre. La única ruta que SÍ lo hacía era la
-- edición manual del docente en `app.teacher.projects.tsx`
-- (`recomputeProjectGrade` cliente, ~línea 1574). Faltaba paridad
-- en el server.
--
-- Fix: trigger SQL `AFTER UPDATE ON project_submission_files` que
-- recalcula `submission_grade` agregando los ai_grade de TODOS los
-- archivos de la submission, ponderados por sus `project_files.points`,
-- y escalados al `max_score` del proyecto. Si la submission ya tiene
-- `defense_factor`, también recalcula `final_grade`. NO toca `status`
-- (eso queda al docente o a otros triggers).
--
-- Misma lógica que el cliente — replicada en SQL para que TODOS los
-- flujos (worker IA, edición manual, futuras integraciones) converjan.
-- ──────────────────────────────────────────────────────────────────────

-- ── Helper: recompute por submission_id ──
-- SECURITY DEFINER porque los triggers pueden ejecutarse en el contexto
-- del worker IA (service_role) y necesitan leer/escribir tablas con RLS.
CREATE OR REPLACE FUNCTION public._recompute_project_submission_grade(_submission_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id UUID;
  v_max_score NUMERIC;
  v_total_points NUMERIC;
  v_earned NUMERIC;
  v_new_sub_grade NUMERIC;
  v_factor NUMERIC;
  v_new_final NUMERIC;
BEGIN
  -- Resolver el project_id y max_score del proyecto.
  SELECT ps.project_id, p.max_score
    INTO v_project_id, v_max_score
    FROM public.project_submissions ps
    JOIN public.projects p ON p.id = ps.project_id
   WHERE ps.id = _submission_id;
  IF v_project_id IS NULL THEN
    RETURN;
  END IF;

  -- Sumar los `points` de los project_files (peso por pregunta).
  -- Si el proyecto no tiene archivos definidos o todos pesan 0,
  -- skipear (no hay nada que calcular sin denominador).
  SELECT COALESCE(SUM(points), 0)
    INTO v_total_points
    FROM public.project_files
   WHERE project_id = v_project_id;
  IF v_total_points <= 0 THEN
    RETURN;
  END IF;

  -- Sumar (ai_grade ponderado al cap de cada file).
  -- min(ai_grade, points) replica el cap del cliente. Si ai_grade
  -- IS NULL, cuenta como 0 (file sin calificar).
  SELECT COALESCE(SUM(LEAST(COALESCE(psf.ai_grade, 0), pf.points)), 0)
    INTO v_earned
    FROM public.project_submission_files psf
    JOIN public.project_files pf ON pf.id = psf.file_id
   WHERE psf.submission_id = _submission_id;

  v_new_sub_grade := ROUND((v_earned / v_total_points) * v_max_score, 2);

  -- Si ya hay defense_factor, recalcular final_grade. Si no, dejarlo
  -- como está (null o el valor anterior — la sustentación pendiente
  -- mantiene su estado).
  SELECT defense_factor INTO v_factor
    FROM public.project_submissions
   WHERE id = _submission_id;
  IF v_factor IS NOT NULL THEN
    v_new_final := ROUND(v_new_sub_grade * v_factor, 2);
  END IF;

  -- UPDATE. Importante: NO tocamos `status` — eso lo gestionan otros
  -- triggers/cliente (al guardar defensa, al recalificar, etc.).
  IF v_factor IS NOT NULL THEN
    UPDATE public.project_submissions
       SET submission_grade = v_new_sub_grade,
           final_grade = v_new_final,
           updated_at = now()
     WHERE id = _submission_id;
  ELSE
    UPDATE public.project_submissions
       SET submission_grade = v_new_sub_grade,
           updated_at = now()
     WHERE id = _submission_id;
  END IF;
END;
$$;

-- ── Trigger: cuando un file individual cambia su ai_grade ──
-- Solo dispara cuando el ai_grade efectivamente cambió (DISTINCT FROM
-- evita re-runs en updates de otros campos como ai_feedback).
CREATE OR REPLACE FUNCTION public._trg_project_submission_file_recompute()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- INSERT: siempre recompute (file nuevo con ai_grade ya seteado).
  -- UPDATE: solo si ai_grade cambió.
  IF TG_OP = 'INSERT' THEN
    PERFORM public._recompute_project_submission_grade(NEW.submission_id);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.ai_grade IS DISTINCT FROM OLD.ai_grade THEN
      PERFORM public._recompute_project_submission_grade(NEW.submission_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_submission_files_recompute
  ON public.project_submission_files;
CREATE TRIGGER trg_project_submission_files_recompute
  AFTER INSERT OR UPDATE ON public.project_submission_files
  FOR EACH ROW EXECUTE FUNCTION public._trg_project_submission_file_recompute();

-- ── Backfill: recomputar TODAS las submissions con files calificados ──
-- One-shot al deployar. Cubre VetCare + cualquier otra submission
-- afectada por el bug histórico. Filtramos por las que tienen al menos
-- un archivo con ai_grade > 0 PERO la submission padre tiene grade=0.
DO $$
DECLARE
  r RECORD;
  v_count INT := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ps.id AS submission_id
      FROM public.project_submissions ps
     WHERE EXISTS (
       SELECT 1 FROM public.project_submission_files psf
        WHERE psf.submission_id = ps.id
          AND COALESCE(psf.ai_grade, 0) > 0
     )
       AND COALESCE(ps.submission_grade, 0) = 0
  LOOP
    PERFORM public._recompute_project_submission_grade(r.submission_id);
    v_count := v_count + 1;
  END LOOP;
  RAISE NOTICE 'Backfill recompute project_submissions: % filas', v_count;
END $$;

-- Permitir invocar el helper como RPC manualmente desde el cliente
-- (ej. desde un botón "Recalcular" del docente en el panel de calificación).
-- Acceso solo para Docente/Admin/SuperAdmin via has_role.
CREATE OR REPLACE FUNCTION public.recompute_project_submission_grade(_submission_id UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_grade NUMERIC;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), 'Docente') OR
    public.has_role(auth.uid(), 'Admin') OR
    public.is_super_admin()
  ) THEN
    RAISE EXCEPTION 'Permiso denegado: requiere rol Docente, Admin o SuperAdmin'
      USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._recompute_project_submission_grade(_submission_id);
  SELECT submission_grade INTO v_new_grade
    FROM public.project_submissions WHERE id = _submission_id;
  RETURN v_new_grade;
END;
$$;

GRANT EXECUTE ON FUNCTION public.recompute_project_submission_grade(UUID) TO authenticated;

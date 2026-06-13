-- ═══════════════════════════════════════════════════════════════════════
-- Normalizar la escala de talleres/proyectos del tenant Camacho (uniaj) a /5.
--
-- Problema: los talleres (7) y proyectos (1) del tenant Universidad Antonio
-- José Camacho quedaron con `max_score = 100` (default histórico del form),
-- aunque la escala del curso y de la institución es **0–5**
-- (courses.grade_scale_max = 5, app_settings.default_grade_scale_max = 5).
-- Las notas de las entregas quedaron MIXTAS: unas en escala 100 (61.43, 88,
-- 100…) y otras ya en escala 5 (4.9, 4.5, 3.8…), porque algunas se
-- calificaron con la IA/auto (que escalaba a max_score=100) y otras el
-- docente las puso a mano en /5.
--
-- Los EXÁMENES NO se tocan: no tienen `max_score` y sus notas ya están en /5
-- (verificado: ningún submissions.ai_grade/final_override_grade > 5 en Camacho).
--
-- Heurística SEGURA (idéntica al precedente 20260501023616): solo se ESCALAN
-- las notas que EXCEDEN la escala del curso (`> grade_scale_max`) — esas están
-- en escala 100. Las que ya son ≤ 5 se dejan intactas (ya estaban en /5).
-- Orden: escalar notas PRIMERO (usando el max_score viejo del elemento) y
-- recién después bajar `max_score` a la escala del curso.
--
-- Idempotente: tras correr, max_score = grade_scale_max y las notas quedan
-- ≤ grade_scale_max, así que los WHERE no vuelven a matchear en re-runs.
--
-- Alcance: SOLO el tenant Camacho (lo pedido). El fix de CÓDIGO (los forms de
-- taller/proyecto ahora heredan max_score de la escala del curso) evita que
-- vuelva a pasar en cualquier tenant. Para normalizar OTRO tenant, basta
-- cambiar v_tenant (o quitar el filtro: max_score > grade_scale_max siempre
-- es un dato inconsistente en este modelo de notas ponderadas).
-- ═══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  -- Universidad Antonio José Camacho (slug 'uniaj').
  v_tenant uuid := 'b35d1bd2-8e9b-4ba3-9ede-545262b9520d';
BEGIN
  IF to_regclass('public.workshops') IS NOT NULL
     AND to_regclass('public.workshop_submissions') IS NOT NULL THEN
    -- 1a) Escalar final_grade de entregas de taller (solo notas > escala).
    UPDATE public.workshop_submissions ws
       SET final_grade = ROUND((ws.final_grade / w.max_score) * c.grade_scale_max, 2)
      FROM public.workshops w
      JOIN public.courses c ON c.id = w.course_id
     WHERE ws.workshop_id = w.id
       AND c.tenant_id = v_tenant
       AND w.max_score > c.grade_scale_max
       AND ws.final_grade IS NOT NULL
       AND ws.final_grade > c.grade_scale_max;

    -- 1b) Escalar ai_grade de entregas de taller.
    UPDATE public.workshop_submissions ws
       SET ai_grade = ROUND((ws.ai_grade / w.max_score) * c.grade_scale_max, 2)
      FROM public.workshops w
      JOIN public.courses c ON c.id = w.course_id
     WHERE ws.workshop_id = w.id
       AND c.tenant_id = v_tenant
       AND w.max_score > c.grade_scale_max
       AND ws.ai_grade IS NOT NULL
       AND ws.ai_grade > c.grade_scale_max;

    -- 1c) Bajar el max_score del taller a la escala del curso.
    UPDATE public.workshops w
       SET max_score = c.grade_scale_max
      FROM public.courses c
     WHERE w.course_id = c.id
       AND c.tenant_id = v_tenant
       AND w.max_score > c.grade_scale_max;
  END IF;

  IF to_regclass('public.projects') IS NOT NULL
     AND to_regclass('public.project_submissions') IS NOT NULL THEN
    -- 2a) Escalar las 3 columnas de nota de entregas de proyecto.
    UPDATE public.project_submissions ps
       SET final_grade = ROUND((ps.final_grade / p.max_score) * c.grade_scale_max, 2)
      FROM public.projects p
      JOIN public.courses c ON c.id = p.course_id
     WHERE ps.project_id = p.id
       AND c.tenant_id = v_tenant
       AND p.max_score > c.grade_scale_max
       AND ps.final_grade IS NOT NULL
       AND ps.final_grade > c.grade_scale_max;

    UPDATE public.project_submissions ps
       SET submission_grade = ROUND((ps.submission_grade / p.max_score) * c.grade_scale_max, 2)
      FROM public.projects p
      JOIN public.courses c ON c.id = p.course_id
     WHERE ps.project_id = p.id
       AND c.tenant_id = v_tenant
       AND p.max_score > c.grade_scale_max
       AND ps.submission_grade IS NOT NULL
       AND ps.submission_grade > c.grade_scale_max;

    UPDATE public.project_submissions ps
       SET ai_grade = ROUND((ps.ai_grade / p.max_score) * c.grade_scale_max, 2)
      FROM public.projects p
      JOIN public.courses c ON c.id = p.course_id
     WHERE ps.project_id = p.id
       AND c.tenant_id = v_tenant
       AND p.max_score > c.grade_scale_max
       AND ps.ai_grade IS NOT NULL
       AND ps.ai_grade > c.grade_scale_max;

    -- 2b) Bajar el max_score del proyecto a la escala del curso.
    UPDATE public.projects p
       SET max_score = c.grade_scale_max
      FROM public.courses c
     WHERE p.course_id = c.id
       AND c.tenant_id = v_tenant
       AND p.max_score > c.grade_scale_max;
  END IF;
END $$;

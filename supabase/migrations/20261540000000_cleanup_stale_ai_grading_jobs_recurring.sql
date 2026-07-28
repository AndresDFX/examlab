-- ═══════════════════════════════════════════════════════════════════════
-- Limpieza RECURRENTE de jobs obsoletos en `ai_grading_queue`.
--
-- Antecedente: la migración 20260951000000 hizo esta limpieza en un bloque
-- `DO $$` de UNA SOLA VEZ. Eso no puede sostener el invariante: la cola
-- vuelve a acumular jobs obsoletos con cada calificación manual / aprobación
-- de IA / borrado de entrega. Evidencia de campo (2026-07, tenant FESNA): 3
-- jobs en `pending` con `attempts = 0` desde el 27-28 de junio — dos apuntando
-- a entregas YA calificadas (una de ellas con nota puesta a mano por el
-- docente) y uno a una entrega que ya no existe.
--
-- Por qué importa que NO se procesen: la cola de calificación se drena
-- manualmente ("Procesar ahora" del panel Cron; ver el alcance intencional
-- documentado en 20260987000000). Si alguien la drena, esos jobs
-- RE-CALIFICARÍAN con IA entregas ya cerradas — pisando la nota manual del
-- docente y gastando créditos — o fallarían contra una fila inexistente.
--
-- DOS causas de obsolescencia, y la vieja limpieza solo cubría la primera:
--   (a) La entrega ya está calificada  → el job perdió sentido.
--   (b) La fila destino YA NO EXISTE (huérfano) → NINGÚN predicado de
--       20260951 lo matchea, porque todos son `EXISTS (... WHERE id = ...)`.
--       Un job huérfano nunca se cancela y nunca puede completarse: queda
--       `pending` para siempre. Este es el agujero que dejaba residuo.
--
-- Exámenes: EXCLUIDOS del caso (a) a propósito — su re-calificación con IA
-- SÍ se puede encolar desde el monitor, así que un job sobre un examen con
-- nota previa puede ser un re-grade legítimo. Pero SÍ entran en el caso (b):
-- un huérfano es imposible de procesar sea cual sea la entidad.
--
-- `target_table` cubiertas (verificadas contra la cola en producción):
--   workshop_submissions, workshop_submission_answers, project_submissions,
--   project_submission_files, submissions.
-- Un `target_table` desconocido NO se toca (podría ser una entidad nueva).
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.cleanup_stale_ai_grading_jobs()
RETURNS TABLE (cancelled_graded INT, cancelled_orphan INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _msg_graded TEXT := 'Cancelado: la entrega ya estaba calificada (limpieza de job obsoleto).';
  _msg_orphan TEXT := 'Cancelado: la entrega destino ya no existe (limpieza de job huérfano).';
  _n INT;
  -- Acumuladores en variables LOCALES con nombres distintos a las columnas de
  -- salida: un `RETURN QUERY SELECT cancelled_graded, ...` referenciaría los
  -- parámetros OUT dentro de un SELECT y Postgres lo rechaza por ambigüedad
  -- contra los nombres de columna del RETURNS TABLE. Y una migración que falla
  -- aborta el deploy completo en Lovable.
  _graded INT := 0;
  _orphan INT := 0;
BEGIN
  IF to_regclass('public.ai_grading_queue') IS NULL THEN
    RETURN QUERY SELECT _graded, _orphan;
    RETURN;
  END IF;

  -- ── (a) Entregas YA CALIFICADAS ───────────────────────────────────────
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg_graded
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'workshop_submissions'
       AND EXISTS (
         SELECT 1 FROM public.workshop_submissions ws
          WHERE ws.id = q.target_row_id
            AND (ws.status = 'calificado' OR ws.final_grade IS NOT NULL)
       );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _graded := _graded + _n;

    IF to_regclass('public.workshop_submission_answers') IS NOT NULL THEN
      UPDATE public.ai_grading_queue q
         SET status = 'cancelled', completed_at = now(), last_error = _msg_graded
       WHERE q.status IN ('pending', 'processing')
         AND q.target_table = 'workshop_submission_answers'
         AND EXISTS (
           SELECT 1
             FROM public.workshop_submission_answers a
             JOIN public.workshop_submissions ws ON ws.id = a.submission_id
            WHERE a.id = q.target_row_id
              AND (ws.status = 'calificado' OR ws.final_grade IS NOT NULL)
         );
      GET DIAGNOSTICS _n = ROW_COUNT;
      _graded := _graded + _n;
    END IF;
  END IF;

  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg_graded
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'project_submissions'
       AND EXISTS (
         SELECT 1 FROM public.project_submissions ps
          WHERE ps.id = q.target_row_id
            AND (ps.status = 'calificado' OR ps.final_grade IS NOT NULL)
       );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _graded := _graded + _n;

    IF to_regclass('public.project_submission_files') IS NOT NULL THEN
      UPDATE public.ai_grading_queue q
         SET status = 'cancelled', completed_at = now(), last_error = _msg_graded
       WHERE q.status IN ('pending', 'processing')
         AND q.target_table = 'project_submission_files'
         AND EXISTS (
           SELECT 1
             FROM public.project_submission_files pf
             JOIN public.project_submissions ps ON ps.id = pf.submission_id
            WHERE pf.id = q.target_row_id
              AND (ps.status = 'calificado' OR ps.final_grade IS NOT NULL)
         );
      GET DIAGNOSTICS _n = ROW_COUNT;
      _graded := _graded + _n;
    END IF;
  END IF;

  -- ── (b) HUÉRFANOS: la fila destino ya no existe ───────────────────────
  -- Un `NOT EXISTS` por tabla. Se acota `target_table` en cada statement
  -- para no cancelar un job cuyo destino vive en una tabla que este bloque
  -- no conoce (entidad nueva) — ahí el `NOT EXISTS` daría true por el
  -- motivo equivocado.
  IF to_regclass('public.workshop_submissions') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg_orphan
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'workshop_submissions'
       AND NOT EXISTS (
         SELECT 1 FROM public.workshop_submissions ws WHERE ws.id = q.target_row_id
       );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _orphan := _orphan + _n;
  END IF;

  IF to_regclass('public.workshop_submission_answers') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg_orphan
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'workshop_submission_answers'
       AND NOT EXISTS (
         SELECT 1 FROM public.workshop_submission_answers a WHERE a.id = q.target_row_id
       );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _orphan := _orphan + _n;
  END IF;

  IF to_regclass('public.project_submissions') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg_orphan
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'project_submissions'
       AND NOT EXISTS (
         SELECT 1 FROM public.project_submissions ps WHERE ps.id = q.target_row_id
       );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _orphan := _orphan + _n;
  END IF;

  IF to_regclass('public.project_submission_files') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg_orphan
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'project_submission_files'
       AND NOT EXISTS (
         SELECT 1 FROM public.project_submission_files pf WHERE pf.id = q.target_row_id
       );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _orphan := _orphan + _n;
  END IF;

  IF to_regclass('public.submissions') IS NOT NULL THEN
    UPDATE public.ai_grading_queue q
       SET status = 'cancelled', completed_at = now(), last_error = _msg_orphan
     WHERE q.status IN ('pending', 'processing')
       AND q.target_table = 'submissions'
       AND NOT EXISTS (
         SELECT 1 FROM public.submissions s WHERE s.id = q.target_row_id
       );
    GET DIAGNOSTICS _n = ROW_COUNT;
    _orphan := _orphan + _n;
  END IF;

  RAISE NOTICE 'cleanup_stale_ai_grading_jobs: % ya calificados, % huérfanos',
    _graded, _orphan;

  RETURN QUERY SELECT _graded, _orphan;
END;
$$;

-- Mantenimiento de servidor, no acción de usuario: solo service_role (el cron
-- corre con ese rol). Sin esto, cualquier `authenticated` podría cancelar
-- jobs de otros tenants — la función es SECURITY DEFINER y bypassa RLS.
REVOKE ALL ON FUNCTION public.cleanup_stale_ai_grading_jobs() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_stale_ai_grading_jobs() FROM anon;
REVOKE ALL ON FUNCTION public.cleanup_stale_ai_grading_jobs() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_ai_grading_jobs() TO service_role;

COMMENT ON FUNCTION public.cleanup_stale_ai_grading_jobs() IS
  'Cancela jobs de ai_grading_queue obsoletos: entrega ya calificada (talleres/proyectos) o fila destino inexistente (huérfanos, incluidos exámenes). Idempotente. La corre el cron cleanup-stale-ai-grading-jobs-daily.';

-- ─── pg_cron schedule ─────────────────────────────────────────────────
-- OJO: `cron.schedule(...)` SIN prefijo `extensions.`. Escribirlo como
-- `extensions.cron.schedule(...)` lo interpreta Postgres como nombre de 3
-- partes (base.schema.función) → "cross-database references are not
-- implemented" → el error lo traga el `EXCEPTION WHEN OTHERS` del DO y el job
-- NUNCA queda agendado. Eso ya pasó con 5 migraciones (ver 20260987000000).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'cron') THEN
    RAISE NOTICE 'Schema "cron" no existe — pg_cron no instalado. Salida limpia.';
    RETURN;
  END IF;

  PERFORM cron.unschedule('cleanup-stale-ai-grading-jobs-daily')
   WHERE EXISTS (
     SELECT 1 FROM cron.job WHERE jobname = 'cleanup-stale-ai-grading-jobs-daily'
   );

  -- 03:20 UTC: hueco libre entre purge-deleted-items-daily (03:00),
  -- db-backup-weekly (03:05 domingos) y auto-finalize-courses-daily (04:00).
  PERFORM cron.schedule(
    'cleanup-stale-ai-grading-jobs-daily',
    '20 3 * * *',
    $cron$ SELECT public.cleanup_stale_ai_grading_jobs(); $cron$
  );
END $$;

-- Descripción legible para el panel Cron (SuperAdmin → Supabase).
DO $$
BEGIN
  IF to_regclass('public.cron_job_descriptions') IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.cron_job_descriptions (jobname, description)
  VALUES (
    'cleanup-stale-ai-grading-jobs-daily',
    'Cancela a diario los trabajos de calificación con IA que quedaron obsoletos: la entrega ya se calificó (a mano o aprobando la IA) o la entrega destino se eliminó. Evita que un "Procesar ahora" re-califique trabajos ya cerrados y pise notas puestas por el docente.'
  )
  ON CONFLICT (jobname) DO UPDATE
    SET description = EXCLUDED.description;
END $$;

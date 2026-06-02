-- ──────────────────────────────────────────────────────────────────────
-- Migración one-shot: reencolar jobs legacy IA (workshop_question,
-- project_file) que están en `pending` como sus equivalentes batch
-- (workshop_full, project_full).
--
-- Contexto: el cambio batch (commits cd95e8d / c5244de) hace que las
-- nuevas entregas encolan UN job por submission en vez de N por
-- pregunta. Esta migración aplica esa misma consolidación a los jobs
-- viejos que quedaron en la cola antes del deploy del batch.
--
-- Reglas de selección:
--   - Solo `status = 'pending'`. Los `failed` los dejamos como están —
--     fallaron por una razón y conviene que un humano los revise antes
--     de re-batchear. Si después se quiere re-batchear failed también,
--     basta cambiar la WHERE de las CTE `legacy_*_jobs`.
--   - Solo `workshop_question` → `workshop_full` y `project_file` →
--     `project_full`. Los kinds `workshop_codigo_zip` y `project_codigo_zip`
--     no se tocan (sigue 1 job por archivo ZIP, por diseño).
--
-- Comportamiento:
--   1. Por cada `submission_id` con jobs pending legacy:
--      a. Inserta UN job batch nuevo con items[] reconstruidos del body
--         de los legacy.
--      b. Marca los legacy como `cancelled` con un last_error que
--         documenta a qué job batch fueron migrados.
--   2. Devuelve counts via RAISE NOTICE para que el operator vea el
--      impacto en los logs del Publish.
--
-- Idempotencia: re-correr la migración no encuentra nada (los legacy
-- ya están en `cancelled`), entonces es no-op. Safe.
-- ──────────────────────────────────────────────────────────────────────

DO $migrate_legacy$
DECLARE
  _ws_subs_count INT := 0;
  _ws_jobs_count INT := 0;
  _pf_subs_count INT := 0;
  _pf_jobs_count INT := 0;
BEGIN
  -- ════════════════════════════════════════════════════════════════════
  -- WORKSHOPS: workshop_question pending → workshop_full
  -- ════════════════════════════════════════════════════════════════════
  WITH legacy_ws_jobs AS (
    SELECT
      q.id           AS job_id,
      q.body,
      q.course_id,
      wsa.submission_id,
      wsa.question_id
    FROM public.ai_grading_queue q
    JOIN public.workshop_submission_answers wsa
      ON wsa.id = q.target_row_id
    WHERE q.kind = 'workshop_question'
      AND q.status = 'pending'
      AND q.target_table = 'workshop_submission_answers'
  ),
  grouped_ws AS (
    SELECT
      submission_id,
      -- Todos los rows del grupo (misma submission) comparten course_id.
      -- max(uuid) no existe en PostgreSQL, así que usamos array_agg + [1].
      (array_agg(course_id))[1]                                 AS course_id,
      -- Default a 'es' si el body legacy no tenía courseLanguage.
      COALESCE(max(body->>'courseLanguage'), 'es')              AS course_language,
      jsonb_agg(jsonb_build_object(
        'qid',         question_id,
        'content',     body->>'questionContent',
        'rubric',      body->>'expectedRubric',
        'userAnswer',  body->>'studentAnswer',
        'maxPoints',   COALESCE((body->>'maxPoints')::numeric, 0)
      ))                                                        AS items,
      array_agg(job_id)                                         AS legacy_ids,
      count(*)                                                  AS legacy_count
    FROM legacy_ws_jobs
    GROUP BY submission_id
  ),
  inserted_ws AS (
    INSERT INTO public.ai_grading_queue (
      kind, invoke_target, body,
      target_table, target_row_id,
      course_id, status
    )
    SELECT
      'workshop_full',
      'ai-grade-submission',
      jsonb_build_object(
        'workshopFullGrading', true,
        'submissionId',        g.submission_id,
        'items',               g.items,
        'courseLanguage',      g.course_language
      ),
      'workshop_submissions',
      g.submission_id,
      g.course_id,
      'pending'
    FROM grouped_ws g
    WHERE jsonb_array_length(g.items) > 0
    RETURNING id, target_row_id
  ),
  cancelled_ws AS (
    UPDATE public.ai_grading_queue q
       SET status        = 'cancelled',
           last_error    = 'Reencolado como workshop_full por migración batch (commit cd95e8d).',
           completed_at  = now()
     WHERE id IN (SELECT unnest(legacy_ids) FROM grouped_ws)
     RETURNING q.id
  )
  SELECT
    (SELECT count(*) FROM inserted_ws),
    (SELECT count(*) FROM cancelled_ws)
  INTO _ws_subs_count, _ws_jobs_count;

  -- ════════════════════════════════════════════════════════════════════
  -- PROJECTS: project_file pending → project_full
  -- ════════════════════════════════════════════════════════════════════
  WITH legacy_pf_jobs AS (
    SELECT
      q.id           AS job_id,
      q.body,
      q.course_id,
      psf.submission_id,
      psf.file_id
    FROM public.ai_grading_queue q
    JOIN public.project_submission_files psf
      ON psf.id = q.target_row_id
    WHERE q.kind = 'project_file'
      AND q.status = 'pending'
      AND q.target_table = 'project_submission_files'
  ),
  grouped_pf AS (
    SELECT
      submission_id,
      -- max(uuid) no existe; ver comentario en grouped_ws.
      (array_agg(course_id))[1]                                 AS course_id,
      COALESCE(max(body->>'courseLanguage'), 'es')              AS course_language,
      -- projectDescription puede no estar en todos los bodies legacy;
      -- usamos cualquiera no-null como representante de la submission.
      max(body->>'projectDescription')                          AS project_description,
      jsonb_agg(jsonb_build_object(
        'qid',         file_id,
        -- En project_file el body usa fileTitle/fileDescription para el
        -- enunciado. El batch espera `content`. Concatenamos titulo +
        -- descripción separados por dos saltos para preservar contexto.
        'content',     trim(
                         COALESCE(body->>'fileTitle','') ||
                         CASE
                           WHEN body->>'fileDescription' IS NOT NULL
                            AND body->>'fileDescription' <> ''
                           THEN E'\n\n' || (body->>'fileDescription')
                           ELSE ''
                         END
                       ),
        'rubric',      body->>'expectedRubric',
        'userAnswer',  body->>'studentContent',
        'maxPoints',   COALESCE((body->>'maxPoints')::numeric, 0)
      ))                                                        AS items,
      array_agg(job_id)                                         AS legacy_ids,
      count(*)                                                  AS legacy_count
    FROM legacy_pf_jobs
    GROUP BY submission_id
  ),
  inserted_pf AS (
    INSERT INTO public.ai_grading_queue (
      kind, invoke_target, body,
      target_table, target_row_id,
      course_id, status
    )
    SELECT
      'project_full',
      'ai-grade-submission',
      jsonb_build_object(
        'projectFullGrading',  true,
        'submissionId',        g.submission_id,
        'items',               g.items,
        'courseLanguage',      g.course_language,
        -- Si no había projectDescription en los legacy, omitimos la key
        -- (el edge function lo trata como opcional).
        'projectDescription',  g.project_description
      ),
      'project_submissions',
      g.submission_id,
      g.course_id,
      'pending'
    FROM grouped_pf g
    WHERE jsonb_array_length(g.items) > 0
    RETURNING id, target_row_id
  ),
  cancelled_pf AS (
    UPDATE public.ai_grading_queue q
       SET status        = 'cancelled',
           last_error    = 'Reencolado como project_full por migración batch (commit c5244de).',
           completed_at  = now()
     WHERE id IN (SELECT unnest(legacy_ids) FROM grouped_pf)
     RETURNING q.id
  )
  SELECT
    (SELECT count(*) FROM inserted_pf),
    (SELECT count(*) FROM cancelled_pf)
  INTO _pf_subs_count, _pf_jobs_count;

  -- ─── Log para que se vea en los logs del Publish ──────────────────────
  RAISE NOTICE 'Migración batch IA completada:';
  RAISE NOTICE '  Talleres: % entregas consolidadas (% jobs legacy cancelados → % batch).',
               _ws_subs_count, _ws_jobs_count, _ws_subs_count;
  RAISE NOTICE '  Proyectos: % entregas consolidadas (% jobs legacy cancelados → % batch).',
               _pf_subs_count, _pf_jobs_count, _pf_subs_count;

  -- ─── Audit log de la migración ────────────────────────────────────────
  -- Para que el admin lo pueda ver desde el panel de auditoría.
  BEGIN
    PERFORM public.log_audit_event(
      p_action      := 'ai_grading.legacy_jobs_migrated_to_batch',
      p_category    := 'grading',
      p_severity    := 'info',
      p_entity_type := 'ai_grading_queue',
      p_entity_id   := NULL,
      p_entity_name := 'migracion_batch_one_shot',
      p_metadata    := jsonb_build_object(
        'workshop_submissions_consolidated', _ws_subs_count,
        'workshop_jobs_cancelled',           _ws_jobs_count,
        'project_submissions_consolidated',  _pf_subs_count,
        'project_jobs_cancelled',            _pf_jobs_count,
        'migration_file',                    '20260601002000_migrate_legacy_ai_jobs_to_batch.sql'
      )
    );
  EXCEPTION WHEN OTHERS THEN
    -- Audit ya tiene try/catch interno, pero defensivo por si la firma cambia.
    NULL;
  END;
END
$migrate_legacy$;

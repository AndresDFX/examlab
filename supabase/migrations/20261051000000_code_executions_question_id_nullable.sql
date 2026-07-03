-- ══════════════════════════════════════════════════════════════════════
-- code_executions.question_id era NOT NULL REFERENCES questions(id). Solo el
-- flujo de EXAMEN pasa un questions.id genuino; los runners de snippet de sesión
-- / contenido / notebook pasan un id que NO es de questions (o ninguno) → el
-- INSERT del edge execute-code violaba el NOT NULL/FK y la ejecución NUNCA se
-- persistía (falla silenciosa). El edge ya deja question_id en NULL fuera del
-- flujo de examen (commit del lote edges); acá lo habilitamos volviendo la
-- columna NULLABLE (el FK ya tolera NULL — los FK no rechazan NULL).
-- Guard to_regclass por si la tabla no existe en algún entorno.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.code_executions') IS NOT NULL THEN
    ALTER TABLE public.code_executions ALTER COLUMN question_id DROP NOT NULL;
  END IF;
END $$;

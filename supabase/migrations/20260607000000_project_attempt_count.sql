-- ──────────────────────────────────────────────────────────────────────
-- attempt_count para project_submissions: enforcement de max_attempts.
--
-- La migración 20260602300000 agregó `projects.max_attempts` +
-- `app_settings.default_project_max_attempts`, pero el enforcement
-- nunca se cableó al frontend (la columna no existía para contar).
--
-- A diferencia de exam_submissions (donde cada attempt es una fila
-- nueva), project_submissions usa "una fila por estudiante/grupo + por
-- proyecto" y se UPDATEa en cada re-entrega. Para saber cuántos intentos
-- consumió el alumno necesitamos un contador explícito.
--
-- Backfill: filas con status != 'no_entregado' valen 1 attempt (legacy
-- — la realidad es que ya consumieron al menos un intento). Filas en
-- estados intermedios (pendiente IA, sospechoso, etc.) también cuentan.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.project_submissions
  ADD COLUMN IF NOT EXISTS attempt_count INT NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0);

COMMENT ON COLUMN public.project_submissions.attempt_count IS
  'Número de veces que el estudiante/grupo entregó este proyecto. Se incrementa en cada submit del estudiante. El frontend bloquea nuevos submits cuando attempt_count >= projects.max_attempts (o el default global).';

-- Backfill: cualquier submission existente que ya pasó por algún
-- estado "entregado/calificado/etc." cuenta como 1 intento consumido.
-- Las filas que solo existían en placeholder se quedan en 0.
UPDATE public.project_submissions
   SET attempt_count = 1
 WHERE attempt_count = 0
   AND status IN ('entregado', 'calificado', 'sospechoso', 'ai_revisado', 'pendiente_revision');

NOTIFY pgrst, 'reload schema';

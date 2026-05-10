-- Migración: backlinks de evaluaciones al contenido generado de origen.
--
-- Cuando un docente crea un Examen / Taller / Proyecto desde el módulo
-- de Contenidos (vía CreateAssessmentDialog), persistimos en
-- `source_content_id` el id del row de `generated_contents` que sirvió
-- de contexto. Esto permite:
--   - Mostrar en el grid de Contenidos cuántas evaluaciones se han
--     derivado de cada contenido ("2 talleres · 1 examen") sin un join
--     reverso a mano.
--   - En futuro: regen de contenido + invalidación / re-sincronización
--     de descripción de las evaluaciones derivadas.
--
-- ON DELETE SET NULL: borrar el contenido NO borra la evaluación —
-- ya forma parte del curso, los estudiantes pueden tener entregas. Solo
-- se pierde el backlink (la evaluación queda "huérfana" en términos de
-- origen, pero sigue funcionando normal).
--
-- Wrap en DO $guard$ con EXECUTE para idempotencia y para no fallar
-- cuando la tabla `generated_contents` aún no existe (orden histórico
-- de migraciones en deploys nuevos).

DO $guard$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'generated_contents'
      AND relnamespace = 'public'::regnamespace
  ) THEN
    EXECUTE 'ALTER TABLE public.exams ADD COLUMN IF NOT EXISTS source_content_id UUID REFERENCES public.generated_contents(id) ON DELETE SET NULL';
    EXECUTE 'ALTER TABLE public.workshops ADD COLUMN IF NOT EXISTS source_content_id UUID REFERENCES public.generated_contents(id) ON DELETE SET NULL';
    EXECUTE 'ALTER TABLE public.projects ADD COLUMN IF NOT EXISTS source_content_id UUID REFERENCES public.generated_contents(id) ON DELETE SET NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_exams_source_content_id ON public.exams(source_content_id) WHERE source_content_id IS NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_workshops_source_content_id ON public.workshops(source_content_id) WHERE source_content_id IS NOT NULL';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_projects_source_content_id ON public.projects(source_content_id) WHERE source_content_id IS NOT NULL';
    -- PostgREST schema cache: forzar recarga para que el cliente
    -- empiece a aceptar el campo en el SELECT inmediatamente, sin
    -- esperar al refresh automático.
    NOTIFY pgrst, 'reload schema';
    RAISE NOTICE 'source_content_id columns + indexes added to exams/workshops/projects';
  ELSE
    RAISE NOTICE 'generated_contents table missing — skipping assessments backlink columns';
  END IF;
END $guard$;

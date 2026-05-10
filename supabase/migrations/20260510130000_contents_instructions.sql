-- Añade `instructions` a generated_contents: texto libre que el docente
-- escribe al crear una generación y que se concatena al user message
-- enviado al modelo. Útil para refinar el output sin tocar el system
-- prompt global (ej. "enfoca el taller en data engineering, evita
-- ejemplos de finance"). Vive en el user message — NO se interpola en
-- el system prompt — para que el contrato de placeholders no cambie.

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'generated_contents'
  ) THEN
    RAISE NOTICE 'Skipping 20260510130000: public.generated_contents no existe. Aplica primero 20260509190000_contents_module.sql.';
    RETURN;
  END IF;

  EXECUTE 'ALTER TABLE public.generated_contents
             ADD COLUMN IF NOT EXISTS instructions TEXT';
END
$guard$;

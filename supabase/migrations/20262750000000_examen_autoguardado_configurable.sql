-- Autoguardado del examen configurable por institución.
--
-- `al_cambiar_pregunta` (por defecto): la entrega se escribe en la base al pasar a otra
-- pregunta y al entregar; entre medio solo queda una copia local en el dispositivo.
-- `continuo`: el comportamiento anterior, que guardaba 1,5 s después de cada cambio.
--
-- Por qué cambia el defecto: cada guardado reescribe la fila entera de `answers`, y el
-- 2026-10-06 sesenta alumnos escribiendo a la vez agotaron el presupuesto de E/S de la
-- instancia y la base dejó de responder (tercera caída por la misma causa).
DO $$
BEGIN
  IF to_regclass('public.app_settings') IS NOT NULL THEN
    ALTER TABLE public.app_settings
      ADD COLUMN IF NOT EXISTS exam_autosave_mode text NOT NULL DEFAULT 'al_cambiar_pregunta';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'app_settings_exam_autosave_mode_check'
    ) THEN
      ALTER TABLE public.app_settings
        ADD CONSTRAINT app_settings_exam_autosave_mode_check
        CHECK (exam_autosave_mode IN ('al_cambiar_pregunta', 'continuo'));
    END IF;
  END IF;
END $$;

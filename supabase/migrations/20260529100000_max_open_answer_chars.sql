-- ──────────────────────────────────────────────────────────────────────
-- Límite máximo de caracteres para respuestas a preguntas tipo `abierta`.
--
-- Aplicado en el frontend (Textarea con `maxLength`) para evitar que el
-- alumno pegue novelas que disparen el costo de tokens de la IA o que
-- el calificador humano no pueda leer. NO se valida server-side todavía:
-- si alguien hace bypass (ej. con devtools) el edge function ya tiene
-- su propio cap independiente.
--
-- Default 5000 — alcanza para una respuesta argumentativa de ~700-1000
-- palabras o un fragmento de código. Subir si el caso de uso lo requiere.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS max_open_answer_chars integer NOT NULL DEFAULT 5000;

ALTER TABLE public.app_settings
  DROP CONSTRAINT IF EXISTS app_settings_max_open_answer_chars_check;

ALTER TABLE public.app_settings
  ADD CONSTRAINT app_settings_max_open_answer_chars_check
  CHECK (max_open_answer_chars BETWEEN 100 AND 50000);

COMMENT ON COLUMN public.app_settings.max_open_answer_chars IS
  'Límite de caracteres para respuestas a preguntas tipo "abierta" (frontend maxLength). Default 5000, rango 100..50000.';

NOTIFY pgrst, 'reload schema';

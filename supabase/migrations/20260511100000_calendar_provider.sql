-- Generaliza la conexión de calendario para soportar múltiples
-- proveedores (Google hoy, Microsoft/Outlook después). Mantenemos la
-- tabla `teacher_google_tokens` como está (data migrada, RLS, trigger)
-- y agregamos:
--   1) `provider` text — 'google' default. Un docente puede tener UNA
--      sola conexión activa a la vez (PK por teacher_id), pero el
--      provider distingue cuál (cuando agreguemos Outlook se podría
--      cambiar la PK a (teacher_id, provider) si queremos múltiples
--      a la vez).
--   2) `provider_email` — alias semántico de `google_email`. Backfill
--      desde la columna anterior. Las nuevas conexiones (Outlook etc)
--      poblarán esta y dejarán `google_email` null.
--
-- Sin renombrar la tabla — preserva todos los foreign references, RLS
-- policies y triggers existentes. El nombre "google" en la tabla se
-- vuelve histórico; el código de aplicación trata todo como "calendar".

ALTER TABLE public.teacher_google_tokens
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'google',
  ADD COLUMN IF NOT EXISTS provider_email text;

-- Backfill: cualquier fila previa es de Google. Copiamos el email.
UPDATE public.teacher_google_tokens
SET provider_email = google_email
WHERE provider_email IS NULL AND google_email IS NOT NULL;

-- Constraint laxo (solo google ahora; añadir 'microsoft' cuando se
-- implemente Outlook). Si en el futuro un seed introduce otro valor,
-- la migración correspondiente puede DROP CONSTRAINT y recrearlo.
ALTER TABLE public.teacher_google_tokens
  DROP CONSTRAINT IF EXISTS teacher_google_tokens_provider_check;
ALTER TABLE public.teacher_google_tokens
  ADD CONSTRAINT teacher_google_tokens_provider_check
  CHECK (provider IN ('google', 'microsoft'));

COMMENT ON COLUMN public.teacher_google_tokens.provider IS
  'Proveedor del calendario conectado: ''google'' o ''microsoft''. Default ''google'' por la migración inicial. La columna `google_email` queda histórica; usar `provider_email` en código nuevo.';

NOTIFY pgrst, 'reload schema';

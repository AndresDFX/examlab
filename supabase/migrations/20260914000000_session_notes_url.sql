-- ──────────────────────────────────────────────────────────────────────
-- Notas / minuta de la sesión.
--
-- Análogo a `recording_url` (enlace a la grabación de la clase), pero para
-- el enlace a las NOTAS DE REUNIÓN / minuta: el documento de Google Docs
-- que genera Gemini con "tomar notas", una página de OneNote/Loop, etc.
--
--   - `notes_url TEXT` → enlace libre. La UI lo muestra como un botón
--     "Ver notas" que abre en nueva pestaña (igual que la grabación;
--     estos servicios no permiten embed via iframe).
--
-- Vincular desde Google Calendar lo trae automáticamente: cuando el evento
-- usó "tomar notas con Gemini", el documento queda como `attachment` (un
-- Google Doc) del evento, y el edge `calendar` lo extrae con
-- `extractGoogleNotesUrl(ev)`. También hay input manual en los forms.
--
-- Guard `to_regclass`: Lovable a veces marca migraciones como aplicadas
-- aunque el CREATE TABLE no haya corrido — sin el guard, el ALTER falla y
-- aborta el deploy.
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.attendance_sessions') IS NULL THEN
    RAISE NOTICE 'public.attendance_sessions no existe — abortando migración notes_url';
    RETURN;
  END IF;

  ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS notes_url TEXT;

  COMMENT ON COLUMN public.attendance_sessions.notes_url IS
    'Enlace libre a las notas / minuta de la reunión (Google Doc de Gemini "tomar notas", OneNote/Loop, etc.). Se muestra como botón "Ver notas" porque estos servicios bloquean embed via iframe.';
END $$;

NOTIFY pgrst, 'reload schema';

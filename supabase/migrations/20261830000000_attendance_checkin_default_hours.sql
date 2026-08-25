-- ══════════════════════════════════════════════════════════════════════
-- Duración por defecto de la ventana de check-in, configurable por institución.
--
-- ── Por qué configurable y no una constante ───────────────────────────
-- El diálogo pasa a proponer "desde ahora, por N horas" con las dos fechas ya
-- escritas y editables. Seis horas es un buen default para una jornada, pero no
-- para todos: una institución que solo toma asistencia en clases de dos horas
-- va a corregir el campo cada vez, y una que hace talleres de fin de semana lo
-- va a estirar cada vez. El número tiene que poder fijarse una vez.
--
-- ── Por qué en `app_settings` ─────────────────────────────────────────
-- Es el singleton POR institución que ya existe, ya tiene `tenant_id`, ya lo
-- provisiona `tg_provision_tenant_defaults` al crear una institución y ya tiene
-- su RLS acotada. Es donde viven `require_exam_fullscreen` y los umbrales de la
-- alerta temprana. Una tabla nueva para un número sería una tabla nueva con su
-- RLS que hay que revisar, para nada.
--
-- NULL = usar el default del código (6). Así una institución a medio configurar
-- funciona igual, y no hay que rellenar la columna para todas al desplegar.
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE NOTICE 'app_settings ausente — se omite la duración por defecto del check-in';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'app_settings'
       AND column_name = 'checkin_default_hours'
  ) THEN
    ALTER TABLE public.app_settings
      ADD COLUMN checkin_default_hours numeric(5,2);
  END IF;

  -- El CHECK acompaña al `clampWindowHours` del cliente (1..168). Con los dos,
  -- un valor absurdo no llega a la base y, si llegara por otra vía, el cliente
  -- lo acota igual antes de armar el formulario.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_app_settings_checkin_hours'
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT chk_app_settings_checkin_hours
      CHECK (checkin_default_hours IS NULL
             OR (checkin_default_hours >= 1 AND checkin_default_hours <= 168));
  END IF;

  EXECUTE $c$COMMENT ON COLUMN public.app_settings.checkin_default_hours IS
    'Horas de la ventana que el dialogo de check-in propone por defecto (desde ahora). NULL = 6, el default del codigo.'$c$;
END $mig$;

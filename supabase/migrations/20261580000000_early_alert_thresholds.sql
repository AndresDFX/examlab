-- ═══════════════════════════════════════════════════════════════════════
-- Alerta temprana: umbrales configurables por institución
-- ═══════════════════════════════════════════════════════════════════════
--
-- El clasificador de riesgo vive en `src/shared/lib/early-alert.ts` y sus
-- umbrales por defecto están en `DEFAULT_RISK_THRESHOLDS`. Estas columnas
-- permiten que cada institución los ajuste sin tocar código.
--
-- Se montan sobre `app_settings` (singleton POR institución, con tenant_id,
-- ya provisionado por `tg_provision_tenant_defaults` y ya con RLS scopeada)
-- en vez de crear una tabla nueva: no hace falta RLS nueva, ni backfill, ni
-- provisión aparte.
--
-- NULL = "usar el default del código". El front cae campo por campo
-- (`thresholdsFromSettings`), así que una institución a medio configurar
-- funciona igual.
--
-- OJO: no se agrega umbral para "promedio bajo" a propósito. La nota de
-- aprobación del curso (`courses.passing_grade`) YA es ese umbral; tener dos
-- sería pedirle al Admin configurar dos veces lo mismo y abrir la puerta a
-- que se contradigan.

DO $$
BEGIN
  -- Defensivo: si `app_settings` no existe en este entorno, no abortar el
  -- deploy completo (Lovable a veces marca migraciones como aplicadas sin
  -- que el CREATE TABLE haya corrido).
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE NOTICE 'app_settings no existe; se omiten los umbrales de alerta temprana';
    RETURN;
  END IF;

  ALTER TABLE public.app_settings
    ADD COLUMN IF NOT EXISTS early_alert_min_attendance_rate NUMERIC,
    ADD COLUMN IF NOT EXISTS early_alert_max_failed INT,
    ADD COLUMN IF NOT EXISTS early_alert_max_missing INT;

  -- Rangos: la tasa es 0..1 (no 0..100 — el front la muestra como %, pero
  -- se guarda como fracción para no tener dos unidades dando vueltas).
  -- Los conteos admiten 0 (institución estricta: cero tolerancia).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'app_settings_early_alert_attendance_range'
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_early_alert_attendance_range
      CHECK (
        early_alert_min_attendance_rate IS NULL
        OR (early_alert_min_attendance_rate >= 0
            AND early_alert_min_attendance_rate <= 1)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'app_settings_early_alert_counts_range'
  ) THEN
    ALTER TABLE public.app_settings
      ADD CONSTRAINT app_settings_early_alert_counts_range
      CHECK (
        (early_alert_max_failed IS NULL
         OR (early_alert_max_failed >= 0 AND early_alert_max_failed <= 100))
        AND
        (early_alert_max_missing IS NULL
         OR (early_alert_max_missing >= 0 AND early_alert_max_missing <= 100))
      );
  END IF;

  -- Los COMMENT van DENTRO del guard: fuera, abortarían el deploy completo
  -- en un entorno sin `app_settings`, que es exactamente lo que el guard
  -- está evitando.
  COMMENT ON COLUMN public.app_settings.early_alert_min_attendance_rate IS
    'Alerta temprana: tasa mínima de asistencia (0..1). NULL = default del código (0.75).';
  COMMENT ON COLUMN public.app_settings.early_alert_max_failed IS
    'Alerta temprana: actividades reprobadas toleradas sin motivo. NULL = default (2).';
  COMMENT ON COLUMN public.app_settings.early_alert_max_missing IS
    'Alerta temprana: actividades no entregadas toleradas sin motivo. NULL = default (2).';
END $$;

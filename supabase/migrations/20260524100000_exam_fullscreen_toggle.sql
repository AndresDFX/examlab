-- ──────────────────────────────────────────────────────────────────────
-- Toggle global de pantalla completa en exámenes.
--
-- Default: TRUE (requiere FS — comportamiento histórico). El Admin puede
-- desactivarlo desde Admin → Configuración → Generales para escenarios
-- de depuración / soporte (p.ej. el alumno necesita ver consola del
-- compilador, que en FS queda detrás del overlay del navegador).
--
-- También relajamos la policy SELECT de app_settings a `authenticated`
-- para que estudiantes/docentes puedan leer la bandera al cargar la
-- pantalla del examen. Estos defaults no son sensibles (escalas de nota,
-- conteo de strikes, navegación) — la sensibilidad estaba sobreestimada.
-- Las policies de WRITE siguen siendo Admin-only.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS require_exam_fullscreen BOOLEAN NOT NULL DEFAULT TRUE;

-- Relajar SELECT a authenticated. WRITE sigue siendo Admin-only.
DROP POLICY IF EXISTS "app_settings_select" ON public.app_settings;
CREATE POLICY "app_settings_select"
  ON public.app_settings FOR SELECT TO authenticated
  USING (TRUE);

COMMENT ON COLUMN public.app_settings.require_exam_fullscreen IS
  'Si TRUE (default), los exámenes exigen pantalla completa y los strikes por fullscreen_exit aplican. Si FALSE, el examen corre en ventana normal (modo depuración/soporte).';

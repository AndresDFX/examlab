-- ============================================================
-- submissions.extra_seconds: tiempo extra concedido al estudiante
-- por el docente en un intento específico (botón +5m del monitor).
--
-- Se persiste en el intento (no solo via exam_timer_controls) para
-- que la fecha fin del intento sea persistente y consultable: el
-- monitor lo necesita para mostrar "Fin: HH:mm" diferente por
-- estudiante cuando se le agrega tiempo a uno solo.
--
-- exam_timer_controls sigue siendo la vía de push realtime al
-- cliente del estudiante; este campo es el espejo persistido.
-- ============================================================

ALTER TABLE public.submissions
  ADD COLUMN IF NOT EXISTS extra_seconds INTEGER NOT NULL DEFAULT 0;

-- ═══════════════════════════════════════════════════════════════════════
-- Pausar un examen puede decir POR QUÉ.
--
-- Hasta acá, pausar desde el monitor le tapaba la pantalla al estudiante con
-- «el docente pausó el examen» y nada más. Desde el lado del alumno eso es
-- indistinguible de una falla: no sabe si es algo suyo, si es general, si
-- alguien lo acusó de algo, ni cuánto va a durar — y no puede preguntar,
-- porque la pantalla está bloqueada y salir a buscar el celular le cuesta una
-- advertencia. El silencio en ese momento es lo que convierte una pausa
-- administrativa («esperen, se cayó el wifi del salón») en un susto.
--
-- El mensaje viaja en la MISMA fila que la orden y no en una tabla aparte:
-- el alumno ya lee `exam_timer_controls` por RLS para enterarse de la pausa,
-- así que no hace falta ninguna política nueva ni una segunda consulta — y
-- sobre todo, no puede desincronizarse de la pausa que lo explica.
--
-- Es NULLABLE a propósito: el motivo es opcional. Obligarlo llevaría a que el
-- docente escriba «.» para poder pausar rápido, que es peor que no tenerlo.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.exam_timer_controls') IS NOT NULL THEN
    ALTER TABLE public.exam_timer_controls
      ADD COLUMN IF NOT EXISTS message TEXT;

    -- El tope existe para que el overlay del alumno no quede con un texto que
    -- no cabe en el teléfono, no por espacio en la base.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'chk_exam_timer_controls_message_len'
    ) THEN
      ALTER TABLE public.exam_timer_controls
        ADD CONSTRAINT chk_exam_timer_controls_message_len
        CHECK (message IS NULL OR char_length(message) <= 300);
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN public.exam_timer_controls.message IS
  'Motivo que el docente escribe al pausar. Lo ve el estudiante en el overlay de pausa. Opcional.';

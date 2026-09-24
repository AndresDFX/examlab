-- ═══════════════════════════════════════════════════════════════════════
-- «Sospechoso» vuelve a significar fraude detectado, no advertencias.
--
-- El estado `sospechoso` de una entrega se estaba usando para DOS cosas muy
-- distintas:
--
--   · Lo que la plataforma DETECTA como fraude: la señal de IA sobre las
--     respuestas y la copia entre estudiantes. Eso es lo que el docente va a
--     revisar y, si confirma, tiene consecuencias académicas.
--   · Haber superado el tope de advertencias de proctoring — salirse de la
--     pantalla, perder el foco, que se cierre la pantalla completa.
--
-- Lo segundo NO es fraude, y llamarlo igual tiene un costo concreto: en el
-- teléfono, esas advertencias las produce el teclado del sistema, una
-- notificación o el propio navegador (por eso ya existen señales blandas
-- específicas de móvil). Media clase terminaba con una etiqueta acusatoria
-- sobre su entrega por algo que muchas veces no hizo.
--
-- Desde ahora una entrega suspendida por advertencias se guarda como
-- `completado`. **No se pierde ningún dato**: `focus_warnings` sigue
-- diciendo cuántas fueron y `answers.__warning_events` guarda el detalle
-- evento por evento — que es de donde el monitor ya saca su columna de
-- advertencias y su diálogo de detalle. Lo único que cambia es que el hecho
-- deja de disfrazarse de acusación.
--
-- ── El backfill ───────────────────────────────────────────────────────
-- Se corrigen SOLO las entregas marcadas sin detección de IA. Las que tienen
-- `ai_detected = true` se quedan como están: ahí el estado sí corresponde.
-- La copia no entra en el criterio porque nunca escribió este estado — vive
-- en `similarity_pairs`, y su `ref_id` es el examen, no la entrega.
-- ═══════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  _n INTEGER := 0;
BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    UPDATE public.submissions
       SET status = 'completado'
     WHERE status = 'sospechoso'
       AND ai_detected IS NOT TRUE;

    GET DIAGNOSTICS _n = ROW_COUNT;
    RAISE NOTICE 'Entregas devueltas a «completado» (estaban marcadas solo por advertencias): %', _n;
  END IF;
END $$;

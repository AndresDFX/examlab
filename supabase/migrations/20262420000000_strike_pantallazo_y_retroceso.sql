-- ═══════════════════════════════════════════════════════════════════════
-- Qué advertencia SUMA un strike: el pantallazo y el botón «atrás»
-- ═══════════════════════════════════════════════════════════════════════
-- `_exam_warning_is_strike` es el espejo en SQL de `TIPOS_QUE_SUMAN_STRIKE`
-- (src/modules/exams/proctoring.ts). Lo consume `teacher_clear_exam_warnings`
-- para decidir si, al perdonar una advertencia, hay que DESCONTAR el contador.
-- Si los dos lados no dicen lo mismo, el docente ve una cosa en el monitor y la
-- base hace otra con el expediente del alumno.
--
-- ── `retroceso`: sumaba y no estaba en la lista ───────────────────────
-- La pantalla de toma incrementa el contador cuando el estudiante pulsa «atrás»
-- del navegador y confirma salir. Pero lo hace FUERA de `recordWarning`, en el
-- propio botón del diálogo, así que se le escapó a una lista que se escribió
-- como «exactamente los tres tipos con los que se llama `recordWarning`».
-- Efecto: perdonar ese evento desde el monitor borraba la fila pero dejaba el
-- strike puesto, sin forma de quitarlo salvo «Limpiar todas». Hay 1 en
-- producción.
--
-- ── `pantallazo`: ahora suma ──────────────────────────────────────────
-- Nadie pulsa Impr Pant ni Cmd+Shift+4 sin querer en mitad de un examen: es
-- deliberado y unívoco, al revés que copiar o pegar, que en una pregunta de
-- código son parte de responderla y por eso siguen sin sumar.
--
-- La clave es NUEVA a propósito. La histórica `screenshot_attempt` no sumaba y
-- hay 11 así en producción; si se le cambiara el significado, perdonar una de
-- esas once DESCONTARÍA un strike que nunca se sumó — exactamente el error que
-- esta lista existe para evitar. Lo viejo se queda como estaba.
--
-- ── Lo que esto NO cubre, y conviene que quede escrito ────────────────
-- En un TELÉFONO el pantallazo es Power+Volumen: lo resuelve el sistema
-- operativo y no genera NINGÚN evento web — ni tecla, ni pérdida de foco, ni
-- cambio de visibilidad. No hay API que lo detecte ni forma de impedirlo desde
-- la web. Esto cubre computador, donde el atajo a veces llega al navegador. En
-- móvil no hay nada que contar, y prometerlo sería peor que no tenerlo.
-- ═══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public._exam_warning_is_strike(_type text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT _type IN ('pestaña', 'fullscreen_exit', 'visibility_hidden',
                   'retroceso', 'pantallazo');
$fn$;

COMMENT ON FUNCTION public._exam_warning_is_strike(text) IS
  'Que tipo de advertencia SUMO un strike. Espejo de TIPOS_QUE_SUMAN_STRIKE en src/modules/exams/proctoring.ts: si divergen, perdonar una advertencia descuenta mal. Es allowlist: un tipo desconocido no descuenta.';

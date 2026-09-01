-- ══════════════════════════════════════════════════════════════════════════
-- Corrige dos casillas del Acuerdo Pedagógico que la migración anterior dejó mal.
--
-- ── Qué pasó, sin adornos ─────────────────────────────────────────────────
-- 20262000000000 conectó las casillas del vocero con `regexp_replace` anclado al
-- rótulo y a `font-size:9pt`:
--
--     (E–mail</span></p></td>.*?<span style="font-size:9pt">)&nbsp;
--
-- La celda del e-mail resultó ser la única del bloque con **10pt**, no 9pt. Con
-- `.*?` el patrón no falla: SIGUE BUSCANDO y encuentra la próxima celda de 9pt
-- que esté en blanco — que es la de **Ciudad**, una fila más abajo. Resultado en
-- producción: la casilla "Ciudad" mostraba el correo del vocero y la de "E–mail"
-- quedaba vacía. Y como la celda de Ciudad ya estaba ocupada, el reemplazo de
-- `{{institucion.ciudad}}` después no coincidió con nada.
--
-- ── La lección, que es lo que evita el próximo ────────────────────────────
-- `.*?` entre el rótulo y la celda deja que el patrón CRUCE de celda y de fila.
-- El ancla correcta es la celda INMEDIATAMENTE siguiente al rótulo, escrita como
-- tal (`</td><td …><p …><span …>`) y sin mencionar el tamaño de fuente, que es
-- presentación y varía celda a celda en un HTML que salió de Word.
--
-- Y la verificación tiene que ser POR CASILLA: la migración anterior avisaba solo
-- si faltaba la del vocero, esa entró bien, y las otras dos rompieron en silencio.
-- Acá se comprueban las cuatro y se avisa por cada una.
-- ══════════════════════════════════════════════════════════════════════════

DO $fix$
DECLARE
  v_id   uuid;
  v_body text;
  v_falta text := '';
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'Sin report_templates: nada que corregir.';
    RETURN;
  END IF;

  SELECT id, body_html INTO v_id, v_body
    FROM public.report_templates
   WHERE name = 'Acuerdo Pedagógico'
     AND owner_id IS NULL AND course_id IS NULL
   LIMIT 1;

  IF v_id IS NULL THEN
    RAISE NOTICE 'Sin plantilla global del Acuerdo: nada que corregir.';
    RETURN;
  END IF;

  -- 1) La casilla de Ciudad quedó con el correo del vocero: se le pone lo suyo.
  v_body := regexp_replace(
    v_body,
    '(Ciudad</span></p></td><td[^>]*><p[^>]*><span[^>]*>)\{\{curso\.vocero\.email\}\}',
    '\1{{institucion.ciudad}}',
    'g'
  );

  -- 2) La casilla de E–mail quedó vacía: se le pone el correo. Ancla la celda
  --    inmediatamente siguiente al rótulo, sin mirar el tamaño de fuente.
  v_body := regexp_replace(
    v_body,
    '(E–mail</span></p></td><td[^>]*><p[^>]*><span[^>]*>)&nbsp;',
    '\1{{curso.vocero.email}}',
    'g'
  );

  -- 3) Defensivo e idempotente: si alguna de las otras dos no estuviera (por
  --    ejemplo si esta migración corre sobre una base donde la anterior no
  --    alcanzó a insertarlas), se insertan con el ancla buena.
  IF position('{{curso.vocero.nombre}}' in v_body) = 0 THEN
    v_body := regexp_replace(
      v_body,
      '(Nombre del vocero</span></p></td><td[^>]*><p[^>]*><span[^>]*>)&nbsp;',
      '\1{{curso.vocero.nombre}}',
      'g'
    );
  END IF;

  IF position('{{curso.vocero.telefono}}' in v_body) = 0 THEN
    v_body := regexp_replace(
      v_body,
      '(Teléfono</span></p></td><td[^>]*><p[^>]*><span[^>]*>)&nbsp;',
      '\1{{curso.vocero.telefono}}',
      'g'
    );
  END IF;

  UPDATE public.report_templates
     SET body_html = v_body, updated_at = now()
   WHERE id = v_id;

  -- 4) Verificación POR CASILLA. Que una falte tiene que verse en el log del
  --    despliegue, no descubrirse cuando el documento sale con la casilla vacía.
  IF position('{{curso.vocero.nombre}}'   in v_body) = 0 THEN v_falta := v_falta || ' vocero.nombre';   END IF;
  IF position('{{curso.vocero.telefono}}' in v_body) = 0 THEN v_falta := v_falta || ' vocero.telefono'; END IF;
  IF position('{{curso.vocero.email}}'    in v_body) = 0 THEN v_falta := v_falta || ' vocero.email';    END IF;
  IF position('{{institucion.ciudad}}'    in v_body) = 0 THEN v_falta := v_falta || ' institucion.ciudad'; END IF;

  IF v_falta = '' THEN
    RAISE NOTICE 'Acuerdo Pedagogico: las 4 casillas quedaron conectadas.';
  ELSE
    RAISE NOTICE 'ATENCION: quedaron sin conectar:%. Revisar la maquetacion de la plantilla.', v_falta;
  END IF;
END $fix$;

NOTIFY pgrst, 'reload schema';

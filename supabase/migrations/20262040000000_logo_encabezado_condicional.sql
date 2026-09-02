-- ══════════════════════════════════════════════════════════════════════════
-- El logo del encabezado deja de pintar un recuadro roto cuando no hay logo.
--
-- ── El problema, medido ───────────────────────────────────────────────────
-- El encabezado del Acuerdo Pedagógico trae `<img src="{{institucion.logo}}">`
-- SIN condicional. Cuando la institución no tiene logo cargado, la variable
-- resuelve a la cadena vacía y el navegador pinta su icono de "imagen rota" —
-- dentro de un acta que se imprime y se firma.
--
-- Y no es un caso hipotético: en producción `certificate_settings
-- .institution_logo_url` está en NULL en las 6 instituciones, y `tenants
-- .logo_path` solo lo tienen 2 (UNIAJ y FESNA). O sea que 4 de 6 imprimen el
-- recuadro roto.
--
-- El «Informe de evaluación» ya venía con su `{{#if institucion.logo}}`
-- (verificado por REST); el Acuerdo, no. Esta migración lo iguala.
--
-- ── El ancla ──────────────────────────────────────────────────────────────
-- Se reemplaza la etiqueta `<img …>` COMPLETA, por literal exacto y con
-- `replace()`, no con `regexp_replace`. Es la misma precaución que dejó escrita
-- 20262010000000: un `.*?` entre el ancla y el objetivo CRUZA de celda y de fila,
-- y así fue como el correo del vocero terminó en la casilla "Ciudad" en
-- producción.
--
-- Y es idempotente por construcción: si el `<img>` ya está envuelto, el literal
-- que se busca —el `<img>` a secas— ya no aparece tal cual precedido por lo que
-- se le agrega, así que el `WHERE` con el `NOT LIKE '%{{#if institucion.logo}}%'`
-- lo deja fuera.
-- ══════════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  v_id uuid;
  v_nombre text;
  v_img text;
  v_sin int;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'Sin report_templates: nada que proteger.';
    RETURN;
  END IF;

  v_img := '<img src="{{institucion.logo}}" style="width:173px;max-width:100%;height:auto;" alt="" />';

  -- Se recorre por FILA y no se filtra por nombre: cualquier plantilla cuyo
  -- encabezado tenga ESE `<img>` sin proteger es un recuadro roto esperando.
  FOR v_id, v_nombre IN
    SELECT id, name FROM public.report_templates
     WHERE header_html LIKE '%' || v_img || '%'
       AND header_html NOT LIKE '%{{#if institucion.logo}}%'
  LOOP
    UPDATE public.report_templates
       SET header_html = replace(
             header_html,
             v_img,
             '{{#if institucion.logo}}' || v_img || '{{/if}}'
           ),
           updated_at = now()
     WHERE id = v_id;
    RAISE NOTICE 'Encabezado protegido en "%" (%).', v_nombre, v_id;
  END LOOP;

  -- Verificación: que no quede NINGUNA plantilla con el logo sin condicional.
  -- Se mira por OCURRENCIA y no por fila: una plantilla podría tener un logo
  -- protegido y otro suelto, y el conteo por fila no lo denunciaría.
  SELECT count(*) INTO v_sin
    FROM public.report_templates
   WHERE header_html LIKE '%<img src="{{institucion.logo}}"%'
     AND header_html NOT LIKE '%{{#if institucion.logo}}%';
  IF v_sin = 0 THEN
    RAISE NOTICE 'Ninguna plantilla imprime el logo sin condicional.';
  ELSE
    RAISE NOTICE 'ATENCION: quedan % plantilla(s) con el logo sin proteger (ancho distinto de 173px?).', v_sin;
  END IF;
END $mig$;

NOTIFY pgrst, 'reload schema';

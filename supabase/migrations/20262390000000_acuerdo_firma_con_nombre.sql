-- ═══════════════════════════════════════════════════════════════════════
-- El Acuerdo Pedagógico firma con NOMBRE, no solo con el cargo
-- ═══════════════════════════════════════════════════════════════════════
-- Reportado: «en las firmas del acuerdo pedagógico, si es el vocero debería
-- verse el nombre completo que está en plataforma».
--
-- El bloque de firmas tiene dos filas: la de las ranuras y, debajo, la de los
-- rótulos, que dice literalmente «El Docente / Tutor» y «El Vocero» y nada más.
-- O sea que el documento que la gente firma no dice QUIÉN firmó: el nombre del
-- vocero aparece una sola vez, arriba, en la casilla «Nombre del vocero», a
-- media página de distancia de su firma.
--
-- El dato YA estaba disponible: `report-context.ts` arma `firmantes.vocero` con
-- `{ nombre, ranura }` y lo expone en el contexto de la plantilla desde que
-- existe la ranura. La plantilla usaba solo `ranura` y tiraba el nombre.
--
-- ── Por qué también el docente ────────────────────────────────────────
-- El pedido es del vocero, pero las dos celdas son la misma fila de una tabla:
-- poner el nombre bajo una y dejar la otra con el cargo pelado se lee como un
-- error de maquetación, no como una decisión. Y el argumento vale igual para
-- los dos: un acuerdo firmado tiene que decir quién lo firmó.
--
-- ── Por qué no cambia los que ya están firmados ───────────────────────
-- `generated_reports` guarda el HTML como INSTANTÁNEA, a propósito: es lo que
-- se firma y lo que `signed_hash` protege. Los Acuerdos de septiembre tienen
-- entre 18 y 32 firmas cada uno y no se tocan. Esto aplica a lo que se genere
-- de acá en adelante.
--
-- ── Alcance ──────────────────────────────────────────────────────────
-- Se parchean TODAS las plantillas que tengan la ranura del vocero, no solo la
-- global: hoy hay además una «(personalizada)» por curso, y dejarla afuera
-- haría que el mismo documento saliera distinto según el curso. El `replace`
-- va sobre un ancla corta y única (verificada: aparece exactamente una vez en
-- cada plantilla) y el `WHERE` exige que el nombre NO esté ya puesto, así que
-- correrlo dos veces no duplica nada.
--
-- Ojo con el modo de falla que el CHANGELOG ya documenta: un UPDATE con guarda
-- puede aplicar EN VERDE sin tocar una sola fila. Por eso el bloque cuenta lo
-- que cambió y lo grita con RAISE NOTICE, y por eso el efecto se verifica
-- leyendo la plantilla después del despliegue, no mirando que el workflow pase.
-- ═══════════════════════════════════════════════════════════════════════

DO $mig$
DECLARE
  v_vocero  int := 0;
  v_docente int := 0;
BEGIN
  IF to_regclass('public.report_templates') IS NULL THEN
    RAISE NOTICE 'skip: report_templates no existe en este entorno';
    RETURN;
  END IF;

  -- ── El vocero ──
  UPDATE public.report_templates
     SET body_html = replace(
           body_html,
           '<strong>El Vocero</strong></span></p>',
           '<strong>El Vocero</strong></span></p>'
           || '<p style="text-align:center"><span style="font-size:8pt">'
           || '{{firmantes.vocero.nombre}}</span></p>'
         ),
         updated_at = now()
   WHERE body_html LIKE '%<strong>El Vocero</strong></span></p>%'
     AND body_html NOT LIKE '%firmantes.vocero.nombre%';
  GET DIAGNOSTICS v_vocero = ROW_COUNT;

  -- ── El docente ──
  UPDATE public.report_templates
     SET body_html = replace(
           body_html,
           '<strong>El Docente / Tutor</strong></span></p>',
           '<strong>El Docente / Tutor</strong></span></p>'
           || '<p style="text-align:center"><span style="font-size:8pt">'
           || '{{firmantes.docente.nombre}}</span></p>'
         ),
         updated_at = now()
   WHERE body_html LIKE '%<strong>El Docente / Tutor</strong></span></p>%'
     AND body_html NOT LIKE '%firmantes.docente.nombre%';
  GET DIAGNOSTICS v_docente = ROW_COUNT;

  RAISE NOTICE 'Acuerdo: nombre bajo la firma -> vocero en % plantilla(s), docente en % plantilla(s)',
    v_vocero, v_docente;

  -- Si no cambió NINGUNA, el ancla dejó de existir (alguien re-maquetó la
  -- plantilla) y el parche quedó sin efecto. Se avisa fuerte en vez de salir
  -- en verde: un despliegue exitoso sobre un cambio que nunca se aplicó es el
  -- peor resultado posible.
  IF v_vocero = 0 AND v_docente = 0
     AND EXISTS (SELECT 1 FROM public.report_templates
                  WHERE body_html LIKE '%firmantes.vocero.ranura%') THEN
    RAISE WARNING 'Acuerdo: hay plantillas con la ranura del vocero pero NINGUNA cambio. Revisar el ancla del bloque de firmas.';
  END IF;
END
$mig$;

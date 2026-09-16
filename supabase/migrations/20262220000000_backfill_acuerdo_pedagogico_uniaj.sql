-- Backfill: estudiantes matriculados DESPUÉS de generado el Acuerdo Pedagógico
-- de Introducción a la Ingeniería SB141B, y nombres desactualizados (bakeados al
-- generar) en los Acuerdos de Programación II y Seminario de Sistemas 341C.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ── El problema, confirmado con datos reales ────────────────────────────
-- `generated_reports.html` es un SNAPSHOT inmutable (es lo que se firma). El
-- Acuerdo de SB141B se generó el 2026-09-04 con 17 matriculados; hoy el curso
-- tiene 34 (más el dueño de la cuenta, matriculado como estudiante en todo
-- curso de UNIAJ — ver CLAUDE.md). Los 16 matriculados NUEVOS —entre ellos
-- Kevin Chocue, que reportó no encontrarse en el documento— NUNCA tuvieron
-- una fila ni una ranura de firma: el HTML simplemente no los menciona. Ya
-- tenían pedida su firma (`request_report_signatures`, sesión anterior) pero
-- sin ranura anclada esa firma no tiene dónde dibujarse.
--
-- Aparte, en Programación II y Seminario de Sistemas (341C, mismo curso
-- comprimido en 2 asignaturas) 3 estudiantes quedaron con el nombre CORTO o
-- mal escrito que tenían al matricularlos, ya corregido en su perfil pero
-- nunca reflejado en el documento ya generado — el mismo mecanismo, sin fila
-- faltante esta vez, solo el texto `{{nombre}}` resuelto una sola vez y
-- congelado.
--
-- ── Por qué un UPDATE de texto y no "regenerar el informe" ──────────────
-- Regenerar con `buildReportContext` crea un `generated_reports.id` NUEVO, y
-- las firmas YA RECOLECTADAS (Sergio Palacios en SB141C, Bryan Ramos en
-- Seminario, etc.) están atadas al `report_id` VIEJO por
-- `report_signatures`. Cambiar de id las dejaría huérfanas y obligaría a
-- volver a firmar a quien YA firmó — más disruptivo que el bug que arregla.
-- Reemplazar el texto de la fila afectada, en el MISMO `id`, dentro del MISMO
-- snapshot, es la operación estrictamente mínima: las firmas existentes
-- siguen renderizando exactamente igual (se emparejan por `data-firma-uid`,
-- no por posición), y las filas nuevas quedan firmables desde ya.
--
-- ── Por qué `replace()` literal y no `regexp_replace` ───────────────────
-- Mismo criterio que 20262030000000 (que documenta el incidente real de un
-- `.*?` cruzando de celda): cada ancla acá incluye el `data-firma-uid`
-- (un UUID único), así que `replace()` de texto exacto no tiene forma de
-- matchear la fila equivocada.
--
-- ── Formato de fila, calcado del que ya imprime la plantilla ────────────
-- Ver `ranuraHtml`/`ranuraPlantillaHtml` en
-- src/modules/reports/signature-slots.ts — la celda de firma es
-- BYTE-IDÉNTICA a la que ya usan las 17 filas existentes.
-- ══════════════════════════════════════════════════════════════════════════

DO $migracion$
DECLARE
  v_html text;
  v_nueva_html text;
  v_token text;
  v_docente uuid := '0a26163e-1845-4cc6-9898-dc4c24e51a9a';
  v_filas int;
BEGIN
  IF to_regclass('public.generated_reports') IS NULL
     OR to_regclass('public.report_signatures') IS NULL THEN
    RAISE NOTICE 'Sin las tablas de informes/firmas: nada que hacer.';
    RETURN;
  END IF;

  -- ── 1) SB141B: agregar las 16 filas faltantes ──────────────────────────
  SELECT html INTO v_html FROM public.generated_reports WHERE id = '583edc5d-6faa-42e3-88fd-fe41233c3a99';
  IF v_html IS NOT NULL AND v_html NOT LIKE '%487772c8-b259-4c6f-9333-84ceebdee592%' THEN
    v_nueva_html := replace(
      v_html,
      $anchor$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">17</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Chara Peña Alan Camilo</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="a5397381-2ee8-4bee-ab75-bdca60638292" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$anchor$,
      $anchor$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">17</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Chara Peña Alan Camilo</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="a5397381-2ee8-4bee-ab75-bdca60638292" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$anchor$ || $nuevasfilas$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">18</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Diaz Martinez Yarelis Nairgleth</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="9b311327-482b-449e-b787-90f2ef6a553d" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">19</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Fonseca Bolaños Valentina</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="4109c920-2162-445b-a069-19b8a024fbc3" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">20</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Enderson Villegas</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="3c5b166d-b608-45f6-a56f-7d725d109baa" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">21</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Gonzalez Serrano Joel Andres</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="5b99f963-606f-4282-9f2b-230536d708c4" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">22</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Cristian Alexis Cuastumal Castro</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="f518ccc9-2837-493c-a5df-90031c5f6e44" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">23</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Jacome Quinto Luis Fernando</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="b3384ab1-dab9-4c32-98ee-28d03a288a8c" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">24</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Lucumi Chalacan Yan Pool</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="f2c13133-eeae-45c1-9e2f-134ae73d3c7a" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">25</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Kevin Chocue</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="19bacbe7-9de2-45af-ac3b-cb711ebbe5e8" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">26</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Garcia Angulo Maikel Esteban</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="c651ac55-ea01-434f-b25f-1844d5df4f07" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">27</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Maranda Caicedo Carlos Eduardo</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="af42890c-9526-40ec-a426-3608bde10e32" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">28</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Gaspar Artunduaga Didier Santiago</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="fcd80246-64d3-45c0-a18c-099c84d2fb0d" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">29</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Diaz Aponza Halan Fernando</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="cc363204-bfac-4631-ae89-cac4cd80ddbd" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">30</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Garcia Montaño Julian Camilo</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="dfd944f2-8450-4880-8e77-b2f2f78103e4" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">31</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Delgado Ambuila Luisa Fernanda</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="8a32d768-53cf-4da9-89d4-8f8799e87beb" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">32</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Larrahondo Aponza Mateo</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="ce228c4e-e5b1-4d1f-9428-0a54c17c955e" style="display:block;min-height:30px;">&nbsp;</span></td></tr><tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">33</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Jerez Simanca Nathalia</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="487772c8-b259-4c6f-9333-84ceebdee592" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$nuevasfilas$
    );
    IF v_nueva_html = v_html THEN
      RAISE WARNING 'SB141B: el ancla de la última fila no matcheó — no se agregó nada. Revisar a mano.';
    ELSE
      UPDATE public.generated_reports SET html = v_nueva_html WHERE id = '583edc5d-6faa-42e3-88fd-fe41233c3a99';
      RAISE NOTICE 'SB141B: agregadas 16 filas de estudiantes al Acuerdo Pedagógico.';
    END IF;
  ELSE
    RAISE NOTICE 'SB141B: ya tiene las filas (migración corrida antes) — se omite.';
  END IF;

  -- Solicitud de firma + notificación para cada matriculado tardío, repetido
  -- una vez por estudiante (16). Es la MISMA lógica de
  -- `request_report_signatures` (token + INSERT + notificación) porque esa
  -- RPC exige `auth.uid()` de un caller autenticado, y una migración corre
  -- sin sesión — así que se reescribe acá en vez de invocarla.
  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', '9b311327-482b-449e-b787-90f2ef6a553d', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      '9b311327-482b-449e-b787-90f2ef6a553d',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', '4109c920-2162-445b-a069-19b8a024fbc3', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      '4109c920-2162-445b-a069-19b8a024fbc3',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', '3c5b166d-b608-45f6-a56f-7d725d109baa', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      '3c5b166d-b608-45f6-a56f-7d725d109baa',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', '5b99f963-606f-4282-9f2b-230536d708c4', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      '5b99f963-606f-4282-9f2b-230536d708c4',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'f518ccc9-2837-493c-a5df-90031c5f6e44', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'f518ccc9-2837-493c-a5df-90031c5f6e44',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'b3384ab1-dab9-4c32-98ee-28d03a288a8c', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'b3384ab1-dab9-4c32-98ee-28d03a288a8c',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'f2c13133-eeae-45c1-9e2f-134ae73d3c7a', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'f2c13133-eeae-45c1-9e2f-134ae73d3c7a',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', '19bacbe7-9de2-45af-ac3b-cb711ebbe5e8', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      '19bacbe7-9de2-45af-ac3b-cb711ebbe5e8',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'c651ac55-ea01-434f-b25f-1844d5df4f07', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'c651ac55-ea01-434f-b25f-1844d5df4f07',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'af42890c-9526-40ec-a426-3608bde10e32', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'af42890c-9526-40ec-a426-3608bde10e32',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'fcd80246-64d3-45c0-a18c-099c84d2fb0d', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'fcd80246-64d3-45c0-a18c-099c84d2fb0d',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'cc363204-bfac-4631-ae89-cac4cd80ddbd', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'cc363204-bfac-4631-ae89-cac4cd80ddbd',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'dfd944f2-8450-4880-8e77-b2f2f78103e4', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'dfd944f2-8450-4880-8e77-b2f2f78103e4',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', '8a32d768-53cf-4da9-89d4-8f8799e87beb', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      '8a32d768-53cf-4da9-89d4-8f8799e87beb',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', 'ce228c4e-e5b1-4d1f-9428-0a54c17c955e', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      'ce228c4e-e5b1-4d1f-9428-0a54c17c955e',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  v_token := encode(extensions.gen_random_bytes(16), 'hex');
  INSERT INTO public.report_signatures (report_id, user_id, requested_by, public_token)
  VALUES ('583edc5d-6faa-42e3-88fd-fe41233c3a99', '487772c8-b259-4c6f-9333-84ceebdee592', v_docente, v_token)
  ON CONFLICT (report_id, user_id) DO NOTHING;
  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas > 0 THEN
    INSERT INTO public.notifications (user_id, kind, title, body, link)
    VALUES (
      '487772c8-b259-4c6f-9333-84ceebdee592',
      'report_signature',
      '✍️ Tienes un documento para firmar',
      'Acuerdo Pedagógico (personalizada) — Introduccion a la Ingenieria-2026-2-SB141B. Revísalo y confirma tu aceptación.',
      '/acuerdo/' || v_token
    );
  END IF;

  -- ── 2) Nombres desactualizados en Programación II y Seminario ──────────
  SELECT html INTO v_html FROM public.generated_reports WHERE id = '9c8edc13-d3aa-44aa-bee9-f5f520571b04';
  IF v_html IS NOT NULL AND v_html LIKE '%Josuan%' THEN
    v_nueva_html := replace(v_html, $viejo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">4</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Josuan</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="0fe6d696-bed3-419f-9dfb-bdb5f9faa4ab" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$viejo$, $nuevo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">4</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Beltran Castaño Josuhan David</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="0fe6d696-bed3-419f-9dfb-bdb5f9faa4ab" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$nuevo$);
    IF v_nueva_html = v_html THEN
      RAISE WARNING 'Nombre no actualizado (ancla no encontrada) para uid 0fe6d696-bed3-419f-9dfb-bdb5f9faa4ab en informe 9c8edc13-d3aa-44aa-bee9-f5f520571b04.';
    ELSE
      UPDATE public.generated_reports SET html = v_nueva_html WHERE id = '9c8edc13-d3aa-44aa-bee9-f5f520571b04';
    END IF;
  END IF;

  SELECT html INTO v_html FROM public.generated_reports WHERE id = '9c8edc13-d3aa-44aa-bee9-f5f520571b04';
  IF v_html IS NOT NULL AND v_html LIKE '%Js Cadavid%' THEN
    v_nueva_html := replace(v_html, $viejo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">5</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Js Cadavid</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="37662d3d-9da4-4b36-ad20-8f41ae373fe9" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$viejo$, $nuevo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">5</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Cadavid Urrea John Sebastian</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="37662d3d-9da4-4b36-ad20-8f41ae373fe9" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$nuevo$);
    IF v_nueva_html = v_html THEN
      RAISE WARNING 'Nombre no actualizado (ancla no encontrada) para uid 37662d3d-9da4-4b36-ad20-8f41ae373fe9 en informe 9c8edc13-d3aa-44aa-bee9-f5f520571b04.';
    ELSE
      UPDATE public.generated_reports SET html = v_nueva_html WHERE id = '9c8edc13-d3aa-44aa-bee9-f5f520571b04';
    END IF;
  END IF;

  SELECT html INTO v_html FROM public.generated_reports WHERE id = '9c8edc13-d3aa-44aa-bee9-f5f520571b04';
  IF v_html IS NOT NULL AND v_html LIKE '%Julio Cesar%' THEN
    v_nueva_html := replace(v_html, $viejo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">6</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Julio Cesar</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="ec92372d-0788-4826-9c1c-677b56d0473d" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$viejo$, $nuevo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">6</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Varela Solarte Julio Cesar</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="ec92372d-0788-4826-9c1c-677b56d0473d" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$nuevo$);
    IF v_nueva_html = v_html THEN
      RAISE WARNING 'Nombre no actualizado (ancla no encontrada) para uid ec92372d-0788-4826-9c1c-677b56d0473d en informe 9c8edc13-d3aa-44aa-bee9-f5f520571b04.';
    ELSE
      UPDATE public.generated_reports SET html = v_nueva_html WHERE id = '9c8edc13-d3aa-44aa-bee9-f5f520571b04';
    END IF;
  END IF;

  SELECT html INTO v_html FROM public.generated_reports WHERE id = 'dddff24d-554a-4e2f-9422-f38d3d0c3062';
  IF v_html IS NOT NULL AND v_html LIKE '%Josuan%' THEN
    v_nueva_html := replace(v_html, $viejo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">4</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Josuan</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="0fe6d696-bed3-419f-9dfb-bdb5f9faa4ab" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$viejo$, $nuevo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">4</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Beltran Castaño Josuhan David</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="0fe6d696-bed3-419f-9dfb-bdb5f9faa4ab" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$nuevo$);
    IF v_nueva_html = v_html THEN
      RAISE WARNING 'Nombre no actualizado (ancla no encontrada) para uid 0fe6d696-bed3-419f-9dfb-bdb5f9faa4ab en informe dddff24d-554a-4e2f-9422-f38d3d0c3062.';
    ELSE
      UPDATE public.generated_reports SET html = v_nueva_html WHERE id = 'dddff24d-554a-4e2f-9422-f38d3d0c3062';
    END IF;
  END IF;

  SELECT html INTO v_html FROM public.generated_reports WHERE id = 'dddff24d-554a-4e2f-9422-f38d3d0c3062';
  IF v_html IS NOT NULL AND v_html LIKE '%Js Cadavid%' THEN
    v_nueva_html := replace(v_html, $viejo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">5</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Js Cadavid</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="37662d3d-9da4-4b36-ad20-8f41ae373fe9" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$viejo$, $nuevo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">5</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Cadavid Urrea John Sebastian</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="37662d3d-9da4-4b36-ad20-8f41ae373fe9" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$nuevo$);
    IF v_nueva_html = v_html THEN
      RAISE WARNING 'Nombre no actualizado (ancla no encontrada) para uid 37662d3d-9da4-4b36-ad20-8f41ae373fe9 en informe dddff24d-554a-4e2f-9422-f38d3d0c3062.';
    ELSE
      UPDATE public.generated_reports SET html = v_nueva_html WHERE id = 'dddff24d-554a-4e2f-9422-f38d3d0c3062';
    END IF;
  END IF;

  SELECT html INTO v_html FROM public.generated_reports WHERE id = 'dddff24d-554a-4e2f-9422-f38d3d0c3062';
  IF v_html IS NOT NULL AND v_html LIKE '%Julio Cesar%' THEN
    v_nueva_html := replace(v_html, $viejo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">6</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Julio Cesar</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="ec92372d-0788-4826-9c1c-677b56d0473d" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$viejo$, $nuevo$<tr><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">6</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt">Varela Solarte Julio Cesar</span></td><td style="padding:4px 6px;border:1px solid #444;"><span style="font-size:9pt"></span></td><td style="padding:4px 6px;border:1px solid #444;height:30px;"><span class="examlab-firma" data-firma-uid="ec92372d-0788-4826-9c1c-677b56d0473d" style="display:block;min-height:30px;">&nbsp;</span></td></tr>$nuevo$);
    IF v_nueva_html = v_html THEN
      RAISE WARNING 'Nombre no actualizado (ancla no encontrada) para uid ec92372d-0788-4826-9c1c-677b56d0473d en informe dddff24d-554a-4e2f-9422-f38d3d0c3062.';
    ELSE
      UPDATE public.generated_reports SET html = v_nueva_html WHERE id = 'dddff24d-554a-4e2f-9422-f38d3d0c3062';
    END IF;
  END IF;

  RAISE NOTICE 'Backfill de Acuerdos Pedagógicos UNIAJ completo.';
END $migracion$;

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- UNIAJ 2026-2 · Alinear los talleres y los parciales de Arquitectura de
-- Sistemas Computacionales y Bases de Datos II con el material del curso.
--
-- ── Por qué existe ────────────────────────────────────────────────────────
-- El contenido de estos dos cursos se cargó el 2026-08-12 desde los documentos
-- del repositorio de la universidad. El 2026-08-15 esos documentos se
-- reescribieron ("Semestre 2026-2: calendario de 13 sesiones, LabEx y modalidad
-- individual") y quedó una deriva de tres días entre el material que el
-- estudiante lee y lo que la plataforma le pide. Esto la cierra.
--
-- Es una migración de DATOS: no crea ni altera tablas. Va acá —y no a mano en
-- el SQL Editor— para que quede registrado QUÉ se cambió y contra qué revisión
-- del material, que es exactamente lo que faltaba para poder explicar por qué
-- la plataforma decía una cosa y el documento otra.
--
-- ── Qué cambió en el material, medido ─────────────────────────────────────
-- Se extrajo el texto de los 29 documentos de taller y de parcial en la
-- revisión vieja (3016166, la que se cargó) y en la actual, y se comparó:
--
--   * Talleres: el CONTRATO de preguntas (cuántas, de qué tipo, con qué
--     puntaje) es IDÉNTICO en los 24 documentos. El único cambio real fue la
--     herramienta de la Clase 3 de Arquitectura (Play with Docker → LabEx
--     Docker Playground) y la plataforma nunca nombró la herramienta, así que
--     no tiene contraparte que actualizar. Los dos documentos que parecían
--     nuevos son renombres con contrato idéntico ("Actividad autónoma Clase 2"
--     → "Taller Clase 2"). La modalidad individual ya coincidía: los 6
--     talleres son group_mode='individual'.
--   * Parciales: solo cambiaron los Parciales 2 de los dos cursos, porque el
--     calendario de 13 sesiones metió la Clase 10 dentro del Corte 2 (la sesión
--     doble del 05/10 cubrió las Clases 7 y 8, y la autónoma del 12/10 fue la
--     Clase 10). Eso agrega temas y redistribuye los 100 puntos del papel.
--   * Las fechas de los 6 parciales ya coincidían con el calendario nuevo.
--
-- ── Lo que esta migración NO aplica, y por qué ────────────────────────────
-- Cuatro ítems del material movieron el enunciado de VetCare a dominios ajenos
-- al curso: en BD Parcial 1, sp_agendar_cita → sp_registrar_prestamo
-- (id_usuario / id_equipo), el trigger de Cita → Prestamo, y el caso de
-- respaldo de "la clínica veterinaria VetCare" → "una pyme"; y en BD Parcial 2
-- la consulta a optimizar, de Cita/fecha_hora/id_mascota → Pedido/fecha/
-- cliente_id. No se aplican, por tres razones concretas:
--   1. El documento se contradice a sí mismo: en BD Parcial 2 la A5 nueva, la
--      D1 y la D2 hablan de VetCare (lote de vacuna, ficha del paciente)
--      mientras la C1 habla de Pedido. Un cambio deliberado de dominio habría
--      movido todas, no una.
--   2. Los talleres de los dos cursos y el Proyecto Integrador siguen siendo
--      VetCare de punta a punta, y el material declara "Hilo conductor:
--      Proyecto Integrador VetCare DB (no es un ejercicio desconectado)".
--   3. La C1 de BD Parcial 2 es una pregunta bd_sql con una base VetCare
--      sembrada a mano —20.000 citas y sin un solo índice, a propósito, para
--      que EXPLAIN muestre diferencias reales de plan—. Rehacerla sobre Pedido
--      es reconstruir ese dataset sin ganancia pedagógica.
-- Si el cambio de dominio era intencional, hay que corregirlo en el material
-- (que es la fuente) y volver a alinear: es lo único que quedó pendiente.
--
-- Tampoco se reescribe el escenario de la D1 de BD Parcial 2: el material pasó
-- de "factura + detalle + stock del insumo" a "lote de vacuna + movimiento
-- contable", que es el MISMO concepto (dos escrituras que deben ser atómicas)
-- con otros sustantivos, y la versión de la plataforma ya tiene su base
-- sembrada con los dos caminos (COMMIT con stock y ROLLBACK sin stock). Sí se
-- le ajusta el puntaje, que es lo que cambió de verdad.
-- ═══════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- PARTE 1 · El orden de las preguntas de los 6 talleres por corte
--
-- Los 6 talleres tenían DOS preguntas en la misma posición — un off-by-one del
-- cargador del 2026-08-12 (las preguntas se insertaron todas en una sola
-- transacción, así que created_at no desempata). Con la posición repetida, el
-- orden que ve el estudiante queda a merced de lo que devuelva la base y puede
-- cambiar entre cargas: "Pregunta 4" del documento deja de señalar una pregunta
-- fija, y el taller se lee como si le faltara un paso.
--
-- El orden NO se eligió por gusto: en cada taller el texto de una de las dos
-- preguntas DEPENDE de la otra, y eso lo fija sin ambigüedad. La dependencia
-- está citada en cada bloque.
--
-- Las posiciones se asignan en ABSOLUTO (no con position + 1) para que volver a
-- correr esta migración deje el mismo resultado. El desplazamiento previo a
-- +1000 evita chocar con un índice único de (workshop_id, position) si algún día
-- se agrega: hoy no existe —justamente por eso los duplicados pudieron entrar—.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.workshop_questions') IS NULL THEN
    RAISE NOTICE 'Sin workshop_questions: nada que ordenar.';
    RETURN;
  END IF;

  UPDATE public.workshop_questions
     SET position = position + 1000
   WHERE workshop_id IN (
     'af087f38-925c-4413-a17f-70704cfb7b3e', 'eda4a37f-7bd0-4e68-a679-09a88f168fb2',
     '66c96ee5-126d-4633-b6a9-3a3c5dcea0a5', '92b3b2cc-1022-47d8-9b28-0d5b8c1f8d15',
     'a41be42a-e342-47dc-a8a9-6c99d2e40379', '9a0f727f-9e6c-4503-8b29-8136450b895f'
   )
     AND position < 1000;

  UPDATE public.workshop_questions AS q
     SET position = v.pos
    FROM (VALUES
      -- ── ARQ · Taller Corte 1 (Clases 1 a 4) ───────────────────────────────
      -- Choque: la matriz IaaS/PaaS/SaaS dice "Partiendo de la ficha y el C4
      -- Context", así que el diagrama C4 Context va ANTES que ella.
      ('0d421c07-be2b-4788-89e6-54a71d7eeb5c'::UUID,  1),  -- dominio y problema   · Clase 1
      ('91c3368e-6d6e-4e2b-a92c-03edad6ee4ef'::UUID,  2),  -- ficha del dominio    · Clase 1
      ('f7d7bb4a-7617-4197-942c-23f6a989b2cf'::UUID,  3),  -- C4 Context (diagrama)· Clase 1
      ('8efee151-3365-494a-b21f-0e4bb88db84c'::UUID,  4),  -- matriz IaaS/PaaS/SaaS· Clase 2
      ('ff1497e1-fc50-4dbc-ba2a-a32105917912'::UUID,  5),  -- ADR-001              · Clase 2
      ('fd435913-a3a4-4a8b-ac2f-de6f110443c5'::UUID,  6),  -- consecuencias del ADR· Clase 2
      ('823a9079-b5c1-45af-89e3-90b1550d407e'::UUID,  7),  -- Dockerfile           · Clase 3
      ('aec2fb88-edfb-47b6-9999-4a7ac52478a2'::UUID,  8),  -- construir y verificar· Clase 3
      ('6fcd2e3d-40cf-40da-b277-4f226f0c5c2d'::UUID,  9),  -- C4 Containers        · Clase 4
      ('c75feb8e-d9be-47b3-b71d-0cc71b7cbbcf'::UUID, 10),  -- contratos            · Clase 4
      ('106bfcef-922a-4328-bd17-fc71c0080c42'::UUID, 11),  -- riesgos              · Clase 4

      -- ── ARQ · Taller Corte 2 (Clases 6 a 10) ──────────────────────────────
      -- Choque: las dos preguntas siguientes hablan de "componente del
      -- despliegue" y de "los nombres del diagrama de Despliegue", así que el
      -- diagrama va inmediatamente ANTES de ellas, y la política de secretos
      -- cierra el bloque de seguridad de la Clase 6.
      ('500c9c23-dd2f-438f-9298-3ba194ad90c1'::UUID,  1),  -- 5 amenazas STRIDE    · Clase 6
      ('d803974d-e279-4863-a076-d13d422e7bd2'::UUID,  2),  -- control por amenaza  · Clase 6
      ('df4dc7f1-5883-42ea-8e13-16597db7f153'::UUID,  3),  -- política de secretos · Clase 6
      ('0de25f64-6c30-4c61-a3aa-403a6873bee9'::UUID,  4),  -- despliegue (diagrama)· Clase 7
      ('6fd8168d-4111-4216-bdc5-ed3bfdab4343'::UUID,  5),  -- almacenamiento       · Clase 7
      ('ebbc9160-dda1-4640-b7ce-1c217fe8820a'::UUID,  6),  -- nombres del diagrama · Clase 7
      ('df620a53-41bf-4248-a8db-a9817a38b0ba'::UUID,  7),  -- workflow de CI       · Clase 8
      ('30ff79f7-9e95-4276-8b02-89e38a720b1f'::UUID,  8),  -- qué hace el build    · Clase 8
      ('b3ff4f1c-cde9-403b-bbe4-90dc3fdecf57'::UUID,  9),  -- métricas y registros · Clase 8
      ('8024f73e-4bfb-4b6e-8910-3cf86ca6464c'::UUID, 10),  -- tabla de costos      · Clase 10
      ('e7a31177-10d3-4ec8-b4f0-d7ac0ad091f8'::UUID, 11),  -- sostenibilidad       · Clase 10

      -- ── ARQ · Taller Corte 3 (Clases 11 a 15) ─────────────────────────────
      -- Choque: la pregunta siguiente dice "el cuello de botella esperado del
      -- sistema bajo ese pico", así que el escenario de carga va justo antes.
      ('1ba9e27e-72f1-4aec-8496-54b2477a02ad'::UUID,  1),  -- backlog priorizado   · Clase 11
      ('d3c000b2-2463-4e12-ab25-f740c7492550'::UUID,  2),  -- escenario de carga   · Clase 12
      ('bec712d3-6208-4f9d-8939-acea9e4d7fcb'::UUID,  3),  -- cuello de botella    · Clase 12
      ('ef1dc3b6-1ea6-498d-852b-636028d77469'::UUID,  4),  -- autoescalado         · Clase 13
      ('0daa0cdd-7471-45f2-aa06-3e47b992010c'::UUID,  5),  -- lo que no escala     · Clase 13
      ('600bf339-01a7-48a5-bb21-b8d9b91911ab'::UUID,  6),  -- impacto en costo     · Clase 13
      ('5cfdd98d-dfd5-4bba-a1cf-c57445b3e95c'::UUID,  7),  -- Q&A de defensa       · Clase 15
      ('956f0f02-9df0-4b62-8837-0a1cdc08749b'::UUID,  8),  -- reflexión de cierre  · Clase 15

      -- ── BD · Taller Corte 1 (Clases 1 a 4) ────────────────────────────────
      -- Choque: la matriz de privilegios "rol x objeto x operacion" necesita los
      -- roles definidos inmediatamente antes, así que los roles abren el bloque
      -- de administración (Clase 2) y el alcance del PI cierra el de la Clase 1.
      ('f38c4ad3-7d09-48fd-9bfc-7c3e41ad14c8'::UUID,  1),  -- entidades y reglas   · Clase 1
      ('2a910a8e-327b-4cda-accb-bb7311459d2d'::UUID,  2),  -- ER borrador          · Clase 1
      ('989796be-40b6-4299-9d10-64ae74cac7d7'::UUID,  3),  -- alcance del PI       · Clase 1
      ('1d3ddf8e-180d-4deb-b579-6880dde96143'::UUID,  4),  -- 4 roles de VetCare   · Clase 2
      ('54294609-dbce-4d51-a2b3-3426af75c1af'::UUID,  5),  -- matriz de privilegios· Clase 2
      ('b674820f-f287-419b-9b9c-8ec4f6a3f4a6'::UUID,  6),  -- privilegio mínimo    · Clase 2
      ('2f2067b1-ceb5-4d5c-b4e1-340e19fd028d'::UUID,  7),  -- altas y bajas        · Clase 2
      ('e89c5d63-2c36-4728-9839-572ab245c740'::UUID,  8),  -- sp_agendar_cita      · Clase 3
      ('da4ca0da-a5af-4f69-8620-6896bd85f915'::UUID,  9),  -- pruebas del proc     · Clase 3
      ('48209033-cc9f-4473-96ae-bd59865cbc29'::UUID, 10),  -- firma del proc       · Clase 3
      ('d50585db-1c6b-4b65-a0e9-340ad3d8ab85'::UUID, 11),  -- función útil al PI   · Clase 4
      ('95ba2196-3c42-47db-af65-3e0bcfda97d8'::UUID, 12),  -- trigger              · Clase 4
      ('edf73eea-c350-4f84-8a98-61f04c83c942'::UUID, 13),  -- plan de respaldo     · Clase 4

      -- ── BD · Taller Corte 2 (Clases 6 a 10) ───────────────────────────────
      -- Choque: justificar "3 cambios concretos entre la version antes y la
      -- version despues" depende de las dos primeras, así que cierra el bloque
      -- de optimización; identificar las 2 consultas frecuentes abre el de
      -- índices, que la pregunta siguiente continúa creándolos.
      ('4a53a393-388e-4420-8214-7d0ccffeddc4'::UUID,  1),  -- consulta ANTES       · Clase 6
      ('08856750-c31a-4d40-8cb9-bddb6406555e'::UUID,  2),  -- consulta DESPUÉS     · Clase 6
      ('a3b4f843-3bf6-4d90-853c-d5169eecde22'::UUID,  3),  -- justificar cambios   · Clase 6
      ('fa4117a7-c08e-42b5-af17-91e136569ee8'::UUID,  4),  -- 2 consultas base     · Clase 7
      ('712df2be-4b60-4e5f-8c54-d075bef24a27'::UUID,  5),  -- crear 2 índices      · Clase 7
      ('097f383b-a5c1-4789-9e31-8732313a1905'::UUID,  6),  -- tabla de justificac. · Clase 7
      ('79d3e3ad-0d8c-47de-96f3-bd85869d99f9'::UUID,  7),  -- riesgo de sobreindex.· Clase 7
      ('9965a9d0-ba98-4dbc-b901-a819c26112ec'::UUID,  8),  -- bloque transaccional · Clase 8
      ('0b08f3f4-4f01-4cd9-9cfe-8681b57d3950'::UUID,  9),  -- forzar el fallo      · Clase 8
      ('641732a2-6df3-422d-aea0-1c2806d7422c'::UUID, 10),  -- tuning de la transac.· Clase 8
      ('1b6fce89-aad1-4e14-a159-464094ecfa9e'::UUID, 11),  -- doble reserva        · Clase 10
      ('7b586a37-a0b8-462d-b095-24fbe7d5a4b4'::UUID, 12),  -- doble descuento      · Clase 10
      ('df15d1d6-e34f-4c93-b542-7a65882da079'::UUID, 13),  -- mitigación SQL       · Clase 10
      ('9a3e2c75-8508-4166-b6a9-f3ebd7af15e6'::UUID, 14),  -- por qué no alcanza   · Clase 10

      -- ── BD · Taller Corte 3 (Clases 11 a 15) ──────────────────────────────
      -- Choque: "Para cada operacion del contrato" depende del contrato, así que
      -- el contrato va inmediatamente antes de esa pregunta.
      ('28632364-3bfd-46ac-8f9d-0e08d6981f80'::UUID,  1),  -- demostrar con SQL    · Clase 11
      ('010eb897-ab08-4878-9d65-fa42cf506d6e'::UUID,  2),  -- contrato app <-> BD  · Clase 12
      ('0173afa3-c540-4f89-875e-b9515fdd8c57'::UUID,  3),  -- errores por operación· Clase 12
      ('0f0c86db-216e-4933-a690-6177341ff8e3'::UUID,  4),  -- elegir un caso real  · Clase 13
      ('45fec00e-f9c1-45dc-820a-e29d50302c65'::UUID,  5),  -- resumir el caso      · Clase 13
      ('f27d55ac-55b7-4870-b938-dfd25790ad84'::UUID,  6),  -- 3 mejoras a VetCare  · Clase 13
      ('537b623f-9404-46fa-a926-678c6f387dbf'::UUID,  7),  -- trazar con la clase  · Clase 13
      ('10aa08fa-5103-4e56-bd83-b4cde7d43b22'::UUID,  8)   -- retrospectiva        · Clase 15
    ) AS v(id, pos)
   WHERE q.id = v.id;

  -- Si alguna quedó con el desplazamiento, es que su id ya no está en la lista
  -- de arriba (se borró o se reemplazó): se le deja un orden estable al final en
  -- vez de dejarla en 1000-y-algo, que la mandaría al fondo con un número raro.
  UPDATE public.workshop_questions
     SET position = position - 1000 + 100
   WHERE position >= 1000;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PARTE 2 · ARQ Parcial 2 — el Corte 2 ahora incluye la Clase 10 (costos)
--
-- El material redistribuyó los 100 puntos del papel: la Sección A pasó de 4
-- preguntas de 5 pts a 5 de 4 pts, la B lo mismo, y la Sección D pasó de una
-- pregunta de 35 pts a D1 de 25 + D2 de 10. La plataforma califica sobre 5, así
-- que el factor es /20: 4 pts → 0,20 · 12 → 0,60 · 25 → 1,25 · 10 → 0,50.
-- Total 5,00, igual que antes.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  ex UUID := '7549eb01-77c3-4b95-8283-800f63254191';
BEGIN
  IF to_regclass('public.questions') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exams WHERE id = ex) THEN
    RAISE NOTICE 'ARQ Parcial 2 no existe en este entorno: se omite.';
    RETURN;
  END IF;

  -- A5 · derecho de la Clase 10: right-sizing. Es de selección única porque el
  -- material la escribió así (una banda correcta entre cuatro).
  INSERT INTO public.questions (id, exam_id, type, content, expected_rubric, options, points, position)
  VALUES (
    'aa250000-0000-4000-8000-000000000001', ex, 'cerrada',
    'La instancia de la API de CloudLite lleva semanas al 8 % de CPU. Al hacer right-sizing, ¿cuál es la banda de utilización objetivo recomendada?',
    'Clave de la SOLUCIÓN: b) Entre 40 % y 70 % de utilización sostenida. Por debajo de esa banda se paga capacidad que nadie usa —el caso del 8 %—; por encima no queda margen para los picos. Tema de la Clase 10 (Costos y sostenibilidad cloud), que el calendario de 13 sesiones incorporó al Corte 2.',
    jsonb_build_object(
      'choices', jsonb_build_array(
        'Mantenerla por debajo del 10 % para tener margen',
        'Entre 40 % y 70 % de utilización sostenida',
        'Al 100 % de forma permanente',
        'La utilización no se tiene en cuenta al dimensionar'),
      'correct_index', 1),
    0.2, 1005
  ) ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content, expected_rubric = EXCLUDED.expected_rubric,
        options = EXCLUDED.options, points = EXCLUDED.points, type = EXCLUDED.type;

  -- B5 · verdadero/falso de costos. Se mantiene el tipo 'abierta' con el
  -- enunciado en formato V/F + justificación, igual que las otras cuatro de la
  -- sección: la plataforma no tiene un tipo verdadero/falso propio, y mezclar
  -- 'cerrada' acá haría que la B5 no pidiera la justificación que el papel pide.
  INSERT INTO public.questions (id, exam_id, type, content, expected_rubric, points, position)
  VALUES (
    'aa250000-0000-4000-8000-000000000002', ex, 'abierta',
    E'Indique si la siguiente afirmación es verdadera o falsa y justifique brevemente su respuesta:\n\n«Apagar por horario los entornos de desarrollo y pruebas de CloudLite fuera de la jornada laboral reduce el costo mensual sin afectar la disponibilidad de producción.»',
    'Clave de la SOLUCIÓN: VERDADERO — desarrollo y pruebas no atienden tráfico de usuarios, así que apagarlos fuera de la jornada recorta horas de cómputo facturadas mientras producción sigue encendida. Criterio: 50 % por acertar el verdadero/falso y 50 % por una justificación que distinga los entornos (no basta con "ahorra plata"). Tema de la Clase 10 (Costos y sostenibilidad cloud).',
    0.2, 1010
  ) ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content, expected_rubric = EXCLUDED.expected_rubric,
        points = EXCLUDED.points, type = EXCLUDED.type;

  -- D2 · el caso de costos que el material agregó al separar la Sección D.
  INSERT INTO public.questions (id, exam_id, type, content, expected_rubric, points, position)
  VALUES (
    'aa250000-0000-4000-8000-000000000003', ex, 'abierta',
    E'Costos y sostenibilidad de CloudLite: la factura mensual subió y el equipo detecta 3 instancias al 8 % de CPU encendidas 24/7, una imagen de contenedor de 1,2 GB y logs guardados sin límite de retención.\n\na) Proponga 3 medidas concretas de reducción de costo para este escenario e indique qué componente de la factura ataca cada una.\nb) Explique por qué el costo se trata como atributo de calidad de la arquitectura y qué otro atributo puede sacrificarse al recortar.',
    'Rúbrica del material (10 pts sobre 100 → 0,50 sobre 5; el enunciado reparte 6 y 4). a) Tres medidas que aterricen en el escenario, cada una atada a su renglón de la factura: right-sizing o apagado por horario de las 3 instancias al 8 % → cómputo; imagen multi-etapa o base slim para bajar los 1,2 GB → almacenamiento de imágenes y tiempo de despliegue; política de retención y nivel de log → almacenamiento de logs. No se acepta "usar menos la nube" ni medidas sin componente asociado. b) El costo es atributo de calidad porque se diseña, se mide y se negocia como la disponibilidad o el rendimiento, no es una consecuencia inevitable; y recortar casi siempre cede algo: menos réplicas o apagar entornos baja disponibilidad o capacidad de respuesta al pico, y recortar retención de logs baja observabilidad y capacidad de auditoría. Se valora que nombre el trade-off concreto, no que diga "hay que equilibrar".',
    0.5, 1014
  ) ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content, expected_rubric = EXCLUDED.expected_rubric,
        points = EXCLUDED.points, type = EXCLUDED.type;

  -- Puntajes y orden finales de las 14. Desplazamiento previo por si algún día
  -- aparece un índice único de (exam_id, position).
  UPDATE public.questions SET position = position + 1000
   WHERE exam_id = ex AND position < 1000;

  UPDATE public.questions AS q SET position = v.pos, points = v.pts
    FROM (VALUES
      ('6f91ae75-8833-4fea-b453-8842eda42e8a'::UUID,  1, 0.2),   -- A1 responsabilidad compartida
      ('7cbb2cac-9b52-48a1-b16a-62313033cc96'::UUID,  2, 0.2),   -- A2 object storage
      ('6df14ae8-57e9-4a28-aa24-6ff879be6b6b'::UUID,  3, 0.2),   -- A3 integración continua
      ('134ba1b5-a881-4b6c-854d-9c480e9695a4'::UUID,  4, 0.2),   -- A4 métrica de monitoreo
      ('aa250000-0000-4000-8000-000000000001'::UUID,  5, 0.2),   -- A5 right-sizing        (nueva)
      ('9c3a72fc-8056-44d2-abec-86beff9a40e5'::UUID,  6, 0.2),   -- B1 puertos innecesarios
      ('1fe30132-e53f-48a0-9280-ed7c0b2564a2'::UUID,  7, 0.2),   -- B2 entrega continua
      ('71e61b8c-ff77-4e45-87bb-3213678db979'::UUID,  8, 0.2),   -- B3 monitoreo continuo
      ('5d300f4b-110c-4fc3-84fe-bc014ec32174'::UUID,  9, 0.2),   -- B4 redes virtuales
      ('aa250000-0000-4000-8000-000000000002'::UUID, 10, 0.2),   -- B5 apagado por horario (nueva)
      ('d17b5609-1194-4b7d-902c-5ecc2a806792'::UUID, 11, 0.6),   -- C1 controles de seguridad
      ('d27aab78-87fd-4985-94ca-63a3056051a1'::UUID, 12, 0.65),  -- C2 bloques/archivos/objetos
      ('86577c20-4db1-4a81-923a-9fb4e5b3b463'::UUID, 13, 1.25),  -- D1 pipeline CI/CD (era 1,75)
      ('aa250000-0000-4000-8000-000000000003'::UUID, 14, 0.5)    -- D2 costos              (nueva)
    ) AS v(id, pos, pts)
   WHERE q.id = v.id AND q.exam_id = ex;

  UPDATE public.questions SET position = position - 1000 + 100
   WHERE exam_id = ex AND position >= 1000;

  -- El alcance del corte cambió: ahora entra la Clase 10. Es lo que el
  -- estudiante lee antes de entrar, así que decirlo acá evita la sorpresa.
  UPDATE public.exams
     SET description = 'Cierre de Corte 2 · Clases 6, 7, 8 y 10 del material: seguridad en la nube, redes y almacenamiento, monitoreo y CI/CD, y costos y sostenibilidad. Tiempo sugerido 90 min dentro del bloque de 120.'
   WHERE id = ex;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- PARTE 3 · BD Parcial 2 — el Corte 2 ahora incluye la Clase 10 (concurrencia)
-- Mismo movimiento que en Arquitectura, con la Clase 10 de control de
-- concurrencia: A5 nueva, emparejamiento ampliado a 6 pares, y la Sección D
-- partida en D1 (25 pts) + D2 (10 pts).
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  ex UUID := 'dc10379d-0bdd-47ca-9de0-5b569ead2823';
BEGIN
  IF to_regclass('public.questions') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.exams WHERE id = ex) THEN
    RAISE NOTICE 'BD Parcial 2 no existe en este entorno: se omite.';
    RETURN;
  END IF;

  -- A5 · niveles de aislamiento, de la Clase 10.
  INSERT INTO public.questions (id, exam_id, type, content, expected_rubric, options, points, position)
  VALUES (
    'bb250000-0000-4000-8000-000000000001', ex, 'cerrada',
    'En VetCare, un reporte de facturación mensual no debe ver consultas veterinarias insertadas por otras transacciones mientras se ejecuta (lectura fantasma). El nivel de aislamiento que lo garantiza es:',
    'Clave de la SOLUCIÓN: c) SERIALIZABLE. Es el único de los cuatro que impide las lecturas fantasma: READ COMMITTED evita leer datos no confirmados pero deja que aparezcan filas nuevas entre dos lecturas de la misma transacción, y READ UNCOMMITTED no evita ni eso. La d) es falsa: el nivel de aislamiento es precisamente lo que define qué anomalías de lectura son posibles. Tema de la Clase 10 (Control de concurrencia), que el calendario de 13 sesiones incorporó al Corte 2.',
    jsonb_build_object(
      'choices', jsonb_build_array(
        'READ UNCOMMITTED',
        'READ COMMITTED',
        'SERIALIZABLE',
        'Ninguno: el nivel de aislamiento no influye en las lecturas'),
      'correct_index', 2),
    0.2, 1005
  ) ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content, expected_rubric = EXCLUDED.expected_rubric,
        options = EXCLUDED.options, points = EXCLUDED.points, type = EXCLUDED.type;

  -- D2 · el caso de concurrencia que el material agregó.
  INSERT INTO public.questions (id, exam_id, type, content, expected_rubric, points, position)
  VALUES (
    'bb250000-0000-4000-8000-000000000002', ex, 'abierta',
    E'Control de concurrencia en VetCare: dos recepcionistas facturan al mismo tiempo y cada transacción actualiza el lote de vacuna y la ficha del paciente, pero en orden inverso. El motor aborta una de las dos con error de interbloqueo (deadlock).\n\na) Explique por qué se produce el interbloqueo en este escenario.\nb) Proponga 2 medidas para evitarlo.\nc) Diga qué nivel de aislamiento usaría y qué anomalía evita.',
    'Rúbrica del material (10 pts sobre 100 → 0,50 sobre 5; el enunciado reparte 4, 4 y 2). a) Cada transacción toma el bloqueo de un recurso y luego pide el que ya retiene la otra: T1 bloquea el lote y pide la ficha, T2 bloquea la ficha y pide el lote, así que ninguna puede avanzar ni liberar, y el motor rompe el ciclo abortando una. Lo que se busca es que nombre el ciclo de espera y el orden inverso, no que repita la palabra deadlock. b) Dos de: acceder siempre a los recursos en un ORDEN FIJO y documentado (la medida que ataca la causa), mantener las transacciones cortas para reducir la ventana, tomar los bloqueos por adelantado con SELECT ... FOR UPDATE en ese mismo orden, o reintentar de forma controlada la transacción abortada. c) Basta con READ COMMITTED para este caso —el interbloqueo lo causa el orden de los bloqueos de escritura, no el nivel de aislamiento—; si además se necesita que el reporte no vea filas nuevas a mitad de camino, SERIALIZABLE, que evita las lecturas fantasma. Se valora que distinga el problema de escritura del de lectura y no suba el nivel "por si acaso".',
    0.5, 1011
  ) ON CONFLICT (id) DO UPDATE
    SET content = EXCLUDED.content, expected_rubric = EXCLUDED.expected_rubric,
        points = EXCLUDED.points, type = EXCLUDED.type;

  -- El emparejamiento pasó de 4 a 6 pares: entran interbloqueo y MVCC, los dos
  -- de la Clase 10. Sigue valiendo 20 pts sobre 100 (1,0 sobre 5), así que cada
  -- par pasa de 5 a 3,33 pts (0,1667 sobre 5).
  UPDATE public.questions SET
    content = E'Empareje cada concepto de transacciones, tuning y control de concurrencia de la Columna A con su definición de la Columna B. Escriba las respuestas en el formato 1-x, 2-x, 3-x, 4-x, 5-x, 6-x.\n\nColumna A:\n1) COMMIT\n2) ROLLBACK\n3) Índice compuesto\n4) Full table scan\n5) Interbloqueo (deadlock)\n6) MVCC\n\nColumna B:\na) Confirma definitivamente los cambios de la transacción\nb) Deshace cambios no confirmados\nc) Índice sobre varias columnas\nd) Lectura completa de la tabla; a menudo costosa en tablas grandes\ne) Dos transacciones se bloquean mutuamente esperando recursos que la otra retiene\nf) Cada lectura ve una versión consistente de la fila sin bloquear a los escritores',
    expected_rubric = 'Emparejamiento correcto según la CLAVE del material: 1-a, 2-b, 3-c, 4-d, 5-e, 6-f. Los pares 1 a 4 son de las Clases 7 y 8; el 5 y el 6 son de la Clase 10, que el calendario de 13 sesiones incorporó a este corte. Asignar 0,1667 por par correcto (6 pares = 1,0 sobre 5; en el papel son 3,33 pts de 20). NOTA DE CONVERSIÓN: en el material esta es la Sección B de emparejamiento y la plataforma no tiene un tipo ''emparejamiento'', por eso se piden los pares como texto. Aceptar variantes de formato (1-a / 1a / 1 → a) siempre que el par quede identificado sin ambigüedad; no descontar por el orden en que los escriba.'
   WHERE id = '11b60eba-7ce3-4682-943c-f4c09069f042' AND exam_id = ex;

  UPDATE public.questions SET position = position + 1000
   WHERE exam_id = ex AND position < 1000;

  UPDATE public.questions AS q SET position = v.pos, points = v.pts
    FROM (VALUES
      ('640de89a-ce5a-49cf-8ba3-546166731b4c'::UUID,  1, 0.2),   -- A1 índice B-Tree
      ('964e0b1f-d581-49fa-8da4-2504b2885390'::UUID,  2, 0.2),   -- A2 EXPLAIN
      ('de87924f-e7e6-4c4c-886c-c4093e1ec0ed'::UUID,  3, 0.2),   -- A3 atomicidad
      ('e8d8e90c-9a56-4a57-b20c-25f4b2b0c554'::UUID,  4, 0.2),   -- A4 particionamiento
      ('bb250000-0000-4000-8000-000000000001'::UUID,  5, 0.2),   -- A5 aislamiento      (nueva)
      ('11b60eba-7ce3-4682-943c-f4c09069f042'::UUID,  6, 1.0),   -- B1 emparejamiento (6 pares)
      ('7ac01293-5eb8-46db-9b25-12d2200cabbb'::UUID,  7, 0.75),  -- C1 optimizar la consulta
      ('387196da-ad13-442c-b81c-21c058be7702'::UUID,  8, 0.5),   -- C2 sobre-indexar
      ('da0954fc-040c-4f05-8d14-db9309f718f3'::UUID,  9, 0.5),   -- D1a SQL transaccional (era 0,75)
      ('73044496-56ae-49e7-80c3-3af167ed9c73'::UUID, 10, 0.75),  -- D1b/c sin transacción y tuning (era 1,0)
      ('bb250000-0000-4000-8000-000000000002'::UUID, 11, 0.5)    -- D2 concurrencia     (nueva)
    ) AS v(id, pos, pts)
   WHERE q.id = v.id AND q.exam_id = ex;

  UPDATE public.questions SET position = position - 1000 + 100
   WHERE exam_id = ex AND position >= 1000;

  UPDATE public.exams
     SET description = 'Cierre de Corte 2 · Clases 6, 7, 8 y 10 del material: optimización de consultas, índices y particionamiento, tuning y transacciones, y control de concurrencia. Tiempo sugerido 90 min dentro del bloque de 120.'
   WHERE id = ex;
END $$;

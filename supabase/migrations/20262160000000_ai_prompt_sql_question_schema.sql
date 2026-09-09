-- ══════════════════════════════════════════════════════════════════════════
-- Generar el ESQUEMA DE PARTIDA de una pregunta SQL con IA, sin revelar la
-- respuesta.
--
-- ── Lo que se pidió ──────────────────────────────────────────────────────
-- «En las preguntas de tipo SQL, cuando sean de examen, al generarlas dejá
-- también una forma de generar las tablas necesarias con el componente de IA
-- que tiene la pizarra y los talleres — pero que ese componente tenga su propio
-- system prompt global manejado en la plataforma, y que específicamente NO dé la
-- respuesta a la pregunta.»
--
-- ── Por qué un use_case aparte y no reusar `sql_generation` ──────────────
-- `sql_generation` es el prompt de la hoja SQL de la pizarra y está escrito para
-- «un docente que está dando clase EN VIVO»: pide comentarios didácticos que
-- expliquen cada sentencia y, cuando le piden la consulta, la entrega. En una
-- clase eso es lo correcto. En una pregunta calificada es exactamente el daño:
-- un SELECT resuelto dentro del esquema de partida deja al estudiante abriendo
-- el ejercicio ya hecho.
--
-- Hasta hoy eso se parcheaba desde el CLIENTE, pegando una directiva al mensaje
-- del docente antes de mandarlo (`DIRECTIVA_SOLO_ESQUEMA`, en el editor de
-- preguntas de taller). Dos problemas: no era visible ni editable desde la
-- plataforma —o sea que no era «manejado en la plataforma»—, y peleaba contra un
-- system prompt que decía lo contrario; si un Admin editaba `sql_generation`, la
-- directiva quedaba discutiendo con él. Con un use_case propio, la regla vive
-- donde el Admin la puede leer y ajustar.
--
-- ── Qué toca esta migración ──────────────────────────────────────────────
--   1) Re-aplica el CHECK de `use_case` sumando 'sql_question_schema'. La lista
--      completa se copia de 20262090000000 (la última que lo re-aplicó): un
--      CHECK que omita valores ya usados rompería filas existentes.
--   2) Siembra el platform-default (tenant_id IS NULL) + backfill per-tenant,
--      mismo patrón que 20261620000000.
--
-- INVARIANTE cross-file (ver CLAUDE.md): el texto sembrado acá debe ser
-- BYTE-IDÉNTICO con:
--   - src/modules/database/sql-question-schema-prompt.ts
--     (SQL_QUESTION_SCHEMA_FALLBACK, que AdminPromptsPanel usa como
--     defaultPrompt / «Restaurar default»)
--   - supabase/functions/ai-generate-sql/index.ts
--     (FALLBACK_SQL_QUESTION_SCHEMA_PROMPT)
-- Lo fija src/modules/tutor/tutor-default-prompt.test.ts.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1) Ampliar el CHECK de use_case con 'sql_question_schema' ──
DO $$
BEGIN
  IF to_regclass('public.ai_prompts') IS NOT NULL THEN
    ALTER TABLE public.ai_prompts DROP CONSTRAINT IF EXISTS ai_prompts_use_case_check;
    BEGIN
      ALTER TABLE public.ai_prompts ADD CONSTRAINT ai_prompts_use_case_check CHECK (
        use_case IN (
          'workshop_full','workshop_question','project_file','project_full','exam_question',
          'exam_time_evaluation','plagiarism_detection','ai_content_detection','project_description',
          'project_questions','content_generation','content.presentacion','content.guia_docente',
          'content.taller_practico','content.ejercicio','content.examen','tutor_chat',
          'report_generation','platform_support','support_triage',
          'platform_support_docente','platform_support_estudiante','sql_generation',
          'group_assignment_from_image','sql_question_schema'
        )
      );
    EXCEPTION WHEN others THEN
      -- Defensivo (mismo criterio que 20261064000000): si alguna fila tiene un
      -- use_case fuera de la lista, NO abortamos el deploy entero por el CHECK.
      RAISE NOTICE 'ai_prompts_use_case_check no re-aplicado: %', SQLERRM;
    END;
  END IF;
END $$;

-- ── 2) Seed platform-default + backfill per-tenant ──
DO $$
DECLARE
  r RECORD;
  v_esquema TEXT := $esquema$Eres un asistente experto en SQL sobre PostgreSQL. Tu único trabajo es preparar el ESQUEMA DE PARTIDA de una pregunta que va a ser CALIFICADA: las tablas y los datos con los que el estudiante se encuentra al abrir el ejercicio.

## La regla que manda sobre todas las demás
No entregues la solución del ejercicio, ni completa, ni parcial, ni insinuada. El docente te describe de qué es la pregunta: eso es CONTEXTO para que el esquema sirva, NO un pedido de que la resuelvas. Si lo que te piden es la consulta, no la escribas.

Concretamente, NO incluyas:
- La consulta que responde la pregunta, ni una equivalente, ni un fragmento. Ni comentada, ni como ejemplo, ni "por si sirve de referencia".
- Comentarios que expliquen el camino: nada de "acá conviene un JOIN", "hay que agrupar por cliente", "usá HAVING".
- Nombres de tabla, columna, vista o restricción que nombren la técnica evaluada: nada de ventas_por_cliente, total_agrupado, promedio_final, vista_solucion.
- Vistas, columnas calculadas, funciones ni procedimientos que dejen el resultado servido.
- Datos sembrados de forma que la respuesta se lea a simple vista. Si la pregunta pide el cliente con más pedidos, no dejes un solo cliente con pedidos; si pide un promedio, que no salga de dos filas.

## Qué sí devuelves
- SOLO sentencias CREATE TABLE e INSERT ejecutables en PostgreSQL. Sin texto fuera del código y sin cercas de Markdown: la respuesta se inserta tal cual en el campo del esquema de partida.
- Llaves primarias y foráneas explícitas, tipos apropiados (INTEGER, TEXT, NUMERIC, DATE, TIMESTAMPTZ, BOOLEAN) y las restricciones que el ejercicio necesite (NOT NULL, UNIQUE, CHECK).
- Datos de ejemplo realistas, en español (es-CO) y coherentes entre tablas relacionadas. Suficientes para que el ejercicio se pueda resolver Y se pueda equivocar: que haya más de un caso, que existan filas que NO cumplen la condición, y valores nulos donde el tema lo pida.
- Un INSERT con varias filas es preferible a muchos INSERT sueltos. Cada sentencia termina en punto y coma.
- El esquema más pequeño que permita evaluar bien. Dos o tres tablas suelen alcanzar: un esquema enorme hace que el estudiante gaste el tiempo del examen leyendo en vez de resolviendo.

## Comentarios: solo los descriptivos
Se permite un comentario corto por tabla que diga QUÉ representa, con dos guiones al inicio de la línea. Por ejemplo: los clientes registrados en la tienda. Está prohibido cualquier comentario que hable de la consulta, del resultado esperado o de cómo resolver.

## Dónde se ejecuta
- El SQL corre en un PostgreSQL REAL dentro del navegador. La sintaxis válida es la de PostgreSQL: nada de MySQL, SQL Server ni Oracle.
- La base es temporal y arranca LIMPIA en cada ejecución: este bloque es todo lo que va a existir cuando el estudiante empiece.
- No hay usuarios reales del motor ni permisos que sobrevivan entre ejecuciones.
- No uses extensiones, tablespaces, replicación, acceso a archivos del sistema ni metacomandos del cliente psql (los que empiezan con barra invertida): en este entorno no existen.

## Sobre el esquema de partida que ya exista
Si el mensaje del docente incluye un esquema de partida, ese es el estado REAL del campo: usa EXACTAMENTE esos nombres de tabla y de columna, no los renombres, y devuelve solo lo que haga falta agregar.

## Si el pedido no es un esquema
Si el docente pide directamente la consulta que resuelve el ejercicio, no la entregues. Devuelve el esquema de partida que ese ejercicio necesita y un único comentario de una línea que diga que la solución no se genera acá porque el estudiante la vería al abrir la pregunta.$esquema$;
BEGIN
  IF to_regclass('public.ai_prompts') IS NULL THEN RETURN; END IF;

  -- Platform default (tenant_id NULL, course_id NULL). DO UPDATE: es el
  -- baseline del SuperAdmin, se re-alinea con el texto canónico del código.
  INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
  VALUES ('sql_question_schema', NULL::uuid, NULL::uuid, v_esquema)
  ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
    DO UPDATE SET system_prompt = EXCLUDED.system_prompt;

  -- Backfill per-tenant (DO NOTHING — no pisa overrides del Admin).
  IF to_regclass('public.tenants') IS NOT NULL THEN
    FOR r IN SELECT id FROM public.tenants WHERE deleted_at IS NULL LOOP
      INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
      VALUES ('sql_question_schema', NULL::uuid, v_esquema, r.id)
      ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL DO NOTHING;
    END LOOP;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

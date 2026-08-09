-- ══════════════════════════════════════════════════════════════════════
-- Generador de SQL con IA para la hoja SQL de la pizarra.
--
-- El docente escribe en lenguaje natural lo que quiere mostrar en clase
-- ("una tabla de clientes y pedidos con 10 filas", "la consulta del cliente
-- con más pedidos", "un GRANT de solo lectura") y la IA devuelve el SQL
-- comentado, listo para insertar como esquema de partida o en el editor.
--
-- Esta migración solo toca `ai_prompts`:
--   1) Re-aplica el CHECK de `use_case` sumando 'sql_generation'. La lista
--      completa se copia de 20261300000000 (última que lo re-aplicó) — un
--      CHECK que omita valores ya usados rompería filas existentes.
--   2) Siembra el platform-default (tenant_id IS NULL) + backfill per-tenant,
--      mismo patrón que 20261300000000.
--
-- INVARIANTE cross-file (ver CLAUDE.md): el texto sembrado acá debe ser
-- BYTE-IDÉNTICO con:
--   - src/modules/database/sql-generation-prompt.ts  (SQL_GENERATION_FALLBACK,
--     que AdminPromptsPanel usa como defaultPrompt / "Restaurar default")
--   - supabase/functions/ai-generate-sql/index.ts    (FALLBACK_SQL_GENERATION_PROMPT)
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Ampliar el CHECK de use_case con 'sql_generation' ──
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
          'platform_support_docente','platform_support_estudiante','sql_generation'
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
  v_sql_gen TEXT := $prompt$Eres un asistente experto en SQL sobre PostgreSQL. Ayudas a un docente que está dando clase EN VIVO: él te describe en lenguaje natural lo que quiere mostrar y tú devuelves la sentencia (o el bloque de sentencias) lista para ejecutar y explicar frente al curso.

## Dónde se ejecuta
- El SQL corre en un PostgreSQL REAL dentro del navegador. La sintaxis válida es la de PostgreSQL: nada de MySQL, SQL Server ni Oracle.
- La base es temporal y arranca LIMPIA en cada ejecución. No existe ninguna tabla previa salvo las que se creen en el mismo bloque o las que aparezcan en el esquema de partida que te entreguen.
- No hay usuarios reales del motor ni permisos que sobrevivan entre ejecuciones: las sentencias de control de acceso sirven para EXPLICAR el concepto.
- No uses extensiones, tablespaces, replicación, acceso a archivos del sistema ni metacomandos del cliente psql (los que empiezan con barra invertida): en este entorno no existen.

## Qué debes devolver
- SOLO código SQL ejecutable. Sin texto introductorio, sin explicaciones fuera del código y sin cercas de Markdown: la respuesta se inserta tal cual en el editor del docente.
- Toda explicación va como COMENTARIO SQL, con dos guiones al inicio de la línea o entre /* y */. El docente los va a leer en voz alta mientras explica, así que escríbelos en español (es-CO), claros y didácticos: qué hace la sentencia y por qué.
- Cada sentencia termina en punto y coma.
- Prefiere el ejemplo más pequeño que demuestre bien el concepto: en clase, un bloque corto se explica; uno largo se salta.

## Según lo que pida el docente
- DDL (CREATE, ALTER, DROP): declara llaves primarias y foráneas explícitas, tipos apropiados (INTEGER, TEXT, NUMERIC, DATE, TIMESTAMPTZ, BOOLEAN) y las restricciones que valga la pena explicar (NOT NULL, UNIQUE, CHECK).
- DML (INSERT, UPDATE, DELETE): cuando pidan datos de ejemplo, genera filas realistas, en español y coherentes entre tablas relacionadas; un INSERT con varias filas es preferible a muchos INSERT sueltos. En UPDATE y DELETE incluye SIEMPRE un WHERE y comenta qué pasaría sin él.
- DQL (SELECT): usa el nivel que pida el docente — JOIN, GROUP BY con HAVING, subconsultas, CTE con WITH y funciones de ventana con OVER y PARTITION BY. Alias legibles y ORDER BY para que el resultado sea estable al proyectarlo.
- DCL (GRANT, REVOKE): crea el rol con CREATE ROLE antes de otorgarle nada, otorga el privilegio mínimo del ejemplo y comenta la diferencia entre privilegios sobre tablas, sobre esquemas y sobre columnas.
- TCL (BEGIN, COMMIT, ROLLBACK, SAVEPOINT): úsalas cuando el tema sea transacciones.

## Sobre el esquema de partida
- Si el mensaje del docente incluye un esquema de partida, ese es el estado REAL de la base: usa EXACTAMENTE esos nombres de tabla y de columna, y no inventes otros.
- Si lo que se pide necesita una tabla que no aparece en ese esquema, créala e insértale datos en el mismo bloque, antes de usarla.
- Si NO hay esquema de partida y te piden una consulta, incluye primero el CREATE TABLE y los INSERT mínimos para que la consulta corra: una consulta contra tablas inexistentes falla y arruina la demostración en clase.$prompt$;
BEGIN
  IF to_regclass('public.ai_prompts') IS NULL THEN RETURN; END IF;

  -- Platform default (tenant_id NULL, course_id NULL). DO UPDATE: es el
  -- baseline del SuperAdmin, se re-alinea con el texto canónico del código.
  INSERT INTO public.ai_prompts (use_case, course_id, tenant_id, system_prompt)
  VALUES ('sql_generation', NULL::uuid, NULL::uuid, v_sql_gen)
  ON CONFLICT (use_case) WHERE course_id IS NULL AND tenant_id IS NULL
    DO UPDATE SET system_prompt = EXCLUDED.system_prompt;

  -- Backfill per-tenant (DO NOTHING — no pisa overrides del Admin).
  IF to_regclass('public.tenants') IS NOT NULL THEN
    FOR r IN SELECT id FROM public.tenants WHERE deleted_at IS NULL LOOP
      INSERT INTO public.ai_prompts (use_case, course_id, system_prompt, tenant_id)
      VALUES ('sql_generation', NULL::uuid, v_sql_gen, r.id)
      ON CONFLICT (tenant_id, use_case) WHERE course_id IS NULL DO NOTHING;
    END LOOP;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

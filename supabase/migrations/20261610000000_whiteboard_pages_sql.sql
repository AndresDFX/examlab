-- ──────────────────────────────────────────────────────────────────────
-- Whiteboard pages: nuevo tipo de hoja 'sql'.
--
-- Tercera hoja "ejecutable" de la pizarra (mig 20261410000000 sumó 'code' y
-- 'console'): el docente muestra una consulta SQL en vivo contra un
-- PostgreSQL REAL en el navegador (PGlite/WASM — mismo motor que la pregunta
-- `bd_sql`, mig 20261600000000), sin tener que crear un examen ni un taller.
--
-- Columnas nuevas:
--   - sql_setup  : esquema + datos de partida que prepara el docente (los
--                  CREATE TABLE / INSERT del ejemplo). Se ejecuta ANTES de
--                  cada corrida, en una base limpia — mismo criterio que
--                  `options.db.setupSql` en preguntas `bd_sql`.
--   - sql_answer : SQL + resultados de la última corrida, serializado con el
--                  MISMO formato que usa la respuesta de una pregunta `bd_sql`
--                  (ver src/modules/database/sql-answer.ts) — así la hoja
--                  reusa `SqlRunner` tal cual, sin reinventar el serializado.
--
-- Todas las columnas nuevas son NULLABLE y las hojas existentes conservan su
-- `page_type` — la migración no toca su contenido.
--
-- Defensiva (patrón del repo): guard con to_regclass por si `whiteboard_pages`
-- no existe en el entorno; columnas con IF NOT EXISTS; el CHECK se DROPea+recrea
-- (no se puede extender un CHECK in-place).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.whiteboard_pages') IS NULL THEN
    RAISE NOTICE 'whiteboard_pages no existe; se omite la migración de la hoja SQL.';
    RETURN;
  END IF;

  -- 1) Extender el CHECK de page_type a 'sql'.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whiteboard_pages_page_type_check'
      AND conrelid = 'public.whiteboard_pages'::regclass
  ) THEN
    ALTER TABLE public.whiteboard_pages
      DROP CONSTRAINT whiteboard_pages_page_type_check;
  END IF;
  ALTER TABLE public.whiteboard_pages
    ADD CONSTRAINT whiteboard_pages_page_type_check
    CHECK (page_type IN ('drawing', 'text', 'code', 'console', 'sql'));

  -- 2) Columnas para hojas 'sql'.
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS sql_setup TEXT;
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS sql_answer TEXT;
END $$;

NOTIFY pgrst, 'reload schema';

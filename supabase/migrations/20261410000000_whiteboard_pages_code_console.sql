-- ──────────────────────────────────────────────────────────────────────
-- Whiteboard pages: nuevos tipos de hoja 'code' y 'console'.
--
-- Antes (migs 20260811 + 20260812): cada hoja era 'drawing' (Excalidraw,
-- `scene_json`) o 'text' (markdown, `text_content`).
-- Ahora sumamos:
--   - 'code'    : hoja con un editor de código + ejecución (compilador). El
--                 docente muestra código en vivo SIN tener que crear un taller;
--                 la salida del último run queda cacheada para que el alumno la
--                 vea al revisar la pizarra. Usa `code_language`/`code_source` +
--                 `last_stdout`/`last_stderr`/`last_exit_code`/`last_executed_at`.
--   - 'console' : hoja con una consola Linux real (v86) — ver
--                 docs/server-console-v86.md. El `console_transcript` guarda la
--                 sesión (historial de comandos + salida) como artefacto de clase.
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
    RAISE NOTICE 'whiteboard_pages no existe; se omite la migración de code/console.';
    RETURN;
  END IF;

  -- 1) Extender el CHECK de page_type a code/console.
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
    CHECK (page_type IN ('drawing', 'text', 'code', 'console'));

  -- 2) Columnas para hojas 'code' (editor + ejecución).
  --    code_language: java | python | javascript (mismo set que execute-code).
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS code_language TEXT;
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS code_source TEXT;
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS last_stdout TEXT;
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS last_stderr TEXT;
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS last_exit_code INT;
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS last_executed_at TIMESTAMPTZ;

  -- 3) Columna para hojas 'console' (transcript de la sesión Linux real v86).
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS console_transcript TEXT;
END $$;

NOTIFY pgrst, 'reload schema';

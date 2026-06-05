-- ──────────────────────────────────────────────────────────────────────
-- Whiteboard pages: agregar tipo de hoja (dibujo / texto).
--
-- Antes (mig 20260811000000): cada hoja era SIEMPRE una escena Excalidraw
-- (`scene_json` JSONB). El docente sólo podía dibujar.
-- Ahora: cada hoja tiene un `page_type`:
--   - 'drawing' (default): hoja Excalidraw — usa `scene_json`.
--   - 'text': hoja tipo editor de documento — usa `text_content` (markdown).
--
-- Las dos columnas coexisten (no se mueven a un JSONB único) porque:
--   1. Querer indexar el contenido de las hojas de texto en el futuro
--      (full-text search) es más fácil con una columna TEXT propia.
--   2. El client lee sólo el campo que aplica al `page_type`. Mantener
--      ambos NULL/válidos en simultáneo simplifica el cliente.
--
-- Las hojas existentes mantienen `page_type='drawing'` por default —
-- la migración no toca su `scene_json`.
-- ──────────────────────────────────────────────────────────────────────

-- 1) page_type enum-like con CHECK. Lo expresamos como TEXT + CHECK
-- (no como ENUM type) para alinear con el resto del repo (CHECK es
-- más fácil de extender sin requerir DROP TYPE + RECREATE).
ALTER TABLE public.whiteboard_pages
  ADD COLUMN IF NOT EXISTS page_type TEXT NOT NULL DEFAULT 'drawing';

-- Defensa por si ALTER ya pasó pero sin CHECK (idempotencia).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whiteboard_pages_page_type_check'
      AND conrelid = 'public.whiteboard_pages'::regclass
  ) THEN
    ALTER TABLE public.whiteboard_pages
      ADD CONSTRAINT whiteboard_pages_page_type_check
      CHECK (page_type IN ('drawing', 'text'));
  END IF;
END $$;

-- 2) text_content nullable. Para drawing pages queda NULL; para text
-- pages se popula con el markdown editado. Sin límite estricto de
-- length — un docente puede escribir un documento largo. Si en el
-- futuro se necesita cap (ej. 1MB), se agrega CHECK length aparte.
ALTER TABLE public.whiteboard_pages
  ADD COLUMN IF NOT EXISTS text_content TEXT;

-- 3) Index parcial sobre page_type='text' por si en el futuro se hace
-- full-text search. Por ahora sirve para queries filtrando por tipo.
CREATE INDEX IF NOT EXISTS idx_whiteboard_pages_text_type
  ON public.whiteboard_pages(whiteboard_id, position)
  WHERE page_type = 'text';

NOTIFY pgrst, 'reload schema';

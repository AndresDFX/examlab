-- ──────────────────────────────────────────────────────────────────────
-- Whiteboard pages: nuevo tipo de hoja 'diagram'.
--
-- Sexto tipo de hoja de la pizarra standalone (migs 20260811 'drawing',
-- 20260812 'text', 20261410 'code'/'console', 20261610 'sql'): el docente
-- prepara y muestra un diagrama —clases, secuencia, entidad-relación,
-- flujo, estados— escrito como texto, dentro de la misma pizarra donde ya
-- dibuja y muestra código, sin tener que crear un examen ni un taller.
--
-- El editor que la hoja usa es EL MISMO que la pregunta de tipo `diagrama`
-- (src/modules/code/DiagramEditor.tsx, motor mermaid). Eso es el punto:
-- el docente enseña la sintaxis exacta con la que después va a evaluar, y
-- no hay dos editores de diagrama que se desincronicen.
--
-- Columna nueva:
--   - diagram_source : el código del diagrama que escribe el autor de la
--                      hoja. NULLABLE — la hoja nace vacía y el editor
--                      ofrece sus plantillas en un clic, así que sembrar
--                      una obligaría a borrarla.
--
-- Por qué una columna PROPIA y no reusar `text_content` ni `code_source`:
-- la invariante "una columna ⇒ un tipo de hoja" que dejó escrita la mig
-- 20260812000000 es 1:1 perfecta hoy y la respetaron los cuatro tipos
-- posteriores. Reusar sería la primera excepción, y el ahorro es nulo: esta
-- migración hay que escribirla igual para extender el CHECK de `page_type`,
-- así que la columna cuesta UNA línea y ningún GRANT (el grant de la tabla
-- ya cubre a `authenticated`, igual que con `code_source` y `sql_setup`).
-- El costo de reusar sí es real: una fila leída sin mirar `page_type` no
-- diría si ese texto es markdown o un diagrama, y al voltear el tipo de
-- una hoja el contenido se REINTERPRETA (un grafo pintado como prosa
-- rota) en vez de quedarse quieto y recuperable en su propia columna.
--
-- El valor del tipo va en INGLÉS ('diagram', no 'diagrama') porque los
-- cinco valores que ya tiene esta columna lo son. El tipo de PREGUNTA sí
-- es 'diagrama', pero es otra tabla y otro enum: mezclarlos deja un CHECK
-- que se lee como un error de tipeo y que alguien va a "corregir".
--
-- Las hojas existentes conservan su `page_type` y su contenido — la
-- migración no toca ninguna fila. Tampoco toca la RLS: ninguna de las dos
-- policies de la tabla mira `page_type` (cuelgan de la pizarra padre), así
-- que la hoja hereda permisos y el filtro de papelera sin escribir nada.
--
-- Defensiva (patrón del repo): guard con to_regclass por si
-- `whiteboard_pages` no existe en el entorno; columna con IF NOT EXISTS; el
-- CHECK se DROPea+recrea (no se puede extender un CHECK in-place).
-- ──────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF to_regclass('public.whiteboard_pages') IS NULL THEN
    RAISE NOTICE 'whiteboard_pages no existe; se omite la migración de la hoja de diagrama.';
    RETURN;
  END IF;

  -- 1) Extender el CHECK de page_type a 'diagram'.
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
    CHECK (page_type IN ('drawing', 'text', 'code', 'console', 'sql', 'diagram'));

  -- 2) Columna para hojas 'diagram'.
  --    Guarda el código del diagrama (sintaxis mermaid) tal como lo escribe
  --    el autor de la hoja. Se nombra por DOMINIO y no por motor —igual que
  --    `code_source` y `sql_setup`— para no atar el esquema a la librería.
  ALTER TABLE public.whiteboard_pages ADD COLUMN IF NOT EXISTS diagram_source TEXT;
END $$;

NOTIFY pgrst, 'reload schema';

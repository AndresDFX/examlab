-- ──────────────────────────────────────────────────────────────────────
-- generated_contents.display_name
--
-- Hasta ahora un contenido se identificaba en la UI por `topic` (el tema
-- que se le pasa a la IA como prompt). Si el docente generaba dos
-- contenidos para "Introducción a Python" (por ejemplo, uno para la
-- universidad A y otro para la B), no había forma de distinguirlos en el
-- selector del tablero — ambos aparecían con el mismo label.
--
-- Esta migración separa los dos conceptos:
--   - `topic`         → tema que se inyecta al prompt (puede repetirse).
--   - `display_name`  → nombre humano único POR DOCENTE; lo que aparece
--                       en grids, selectores y exports.
--
-- Reglas:
--   - NOT NULL: el docente debe escribir un nombre al crear.
--   - UNIQUE case-insensitive por (teacher_id, lower(display_name)): así
--     "Semana 5" y "semana 5" cuentan como el mismo nombre. Si choca, la
--     UI sugiere "Semana 5 (2)" automáticamente.
--   - Backfill determinista: para filas existentes, partimos del topic y
--     agregamos un sufijo "(2)", "(3)", … en filas con topic duplicado
--     dentro del mismo docente, ordenando por created_at. Así no rompemos
--     el constraint UNIQUE al activarlo.
-- ──────────────────────────────────────────────────────────────────────

-- 1) Columna NULL — agregar primero para poder hacer el backfill antes
-- del NOT NULL.
ALTER TABLE public.generated_contents
  ADD COLUMN IF NOT EXISTS display_name TEXT;

-- 2) Backfill: por cada (teacher_id, topic) con N filas, asignar
-- display_name = topic a la primera, topic + ' (2)' a la segunda, etc.
-- Saltamos las filas que ya tienen display_name (idempotente: re-correr
-- la migración no las pisa).
WITH numbered AS (
  SELECT
    id,
    topic,
    ROW_NUMBER() OVER (
      PARTITION BY teacher_id, lower(topic)
      ORDER BY created_at, id
    ) AS rn
  FROM public.generated_contents
  WHERE display_name IS NULL
)
UPDATE public.generated_contents AS g
SET display_name = CASE
  WHEN n.rn = 1 THEN n.topic
  ELSE n.topic || ' (' || n.rn || ')'
END
FROM numbered n
WHERE g.id = n.id;

-- 3) Garantizar que aún quedan candidatos (por si quedaron NULL por
-- topic vacío). Caso límite: si topic era NULL/'' usamos un fallback.
UPDATE public.generated_contents
SET display_name = 'Contenido ' || substring(id::text, 1, 8)
WHERE display_name IS NULL OR trim(display_name) = '';

-- 4) NOT NULL + CHECK trim length.
ALTER TABLE public.generated_contents
  ALTER COLUMN display_name SET NOT NULL;

ALTER TABLE public.generated_contents
  DROP CONSTRAINT IF EXISTS generated_contents_display_name_nonempty;

ALTER TABLE public.generated_contents
  ADD CONSTRAINT generated_contents_display_name_nonempty
  CHECK (length(trim(display_name)) > 0);

-- 5) UNIQUE case-insensitive por docente. Si el docente intenta crear
-- dos contenidos con el mismo nombre, la inserción falla con código
-- 23505 (PostgreSQL unique_violation) y la UI sugiere un alternativo.
DROP INDEX IF EXISTS generated_contents_display_name_unique_per_teacher;
CREATE UNIQUE INDEX generated_contents_display_name_unique_per_teacher
  ON public.generated_contents (teacher_id, lower(display_name));

NOTIFY pgrst, 'reload schema';

-- ──────────────────────────────────────────────────────────────────────
-- generated_contents: pasar de `modality` enum string a `tags TEXT[]`.
--
-- Razón: hoy `modality` es uno de {teorica, practica, teorico_practica}
-- — un set fijo de 3 combinaciones. El docente ahora puede combinar
-- libremente tags:
--   - `teorico`  → genera presentación + guía docente.
--   - `practico` → agrega taller práctico + ejercicio estudiante (+ sol).
--   - `examen`   → agrega examen por sesión (oculto al estudiante).
-- Combinables: ["teorico", "practico"], ["teorico", "examen"],
-- ["teorico", "practico", "examen"], etc.
--
-- Backfill:
--   teorica         → ['teorico']
--   practica        → ['practico']
--   teorico_practica → ['teorico', 'practico']
--   NULL            → ['teorico'] (default histórico cuando el docente
--                                  no eligió modalidad)
--
-- Mantenemos `modality` como columna NULLABLE por compatibilidad — el
-- edge function `generate-contents` la sigue usando como fallback. En
-- un futuro release la dropearemos.
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.generated_contents
  ADD COLUMN IF NOT EXISTS tags TEXT[];

-- Backfill solo donde tags está NULL — idempotente.
UPDATE public.generated_contents
SET tags = CASE
  WHEN modality = 'teorica' THEN ARRAY['teorico']
  WHEN modality = 'practica' THEN ARRAY['practico']
  WHEN modality = 'teorico_practica' THEN ARRAY['teorico', 'practico']
  ELSE ARRAY['teorico']
END
WHERE tags IS NULL;

-- CHECK que cada tag esté en el set conocido — protege contra typos
-- desde el cliente (sin tipo enum porque queremos flexibilidad para
-- agregar tags nuevos sin migrar el enum).
ALTER TABLE public.generated_contents
  DROP CONSTRAINT IF EXISTS generated_contents_tags_check;
ALTER TABLE public.generated_contents
  ADD CONSTRAINT generated_contents_tags_check CHECK (
    tags IS NULL
    OR tags <@ ARRAY['teorico', 'practico', 'examen']::text[]
  );

NOTIFY pgrst, 'reload schema';

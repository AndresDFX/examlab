-- ──────────────────────────────────────────────────────────────────────
-- generated_contents.prompt_overrides
--
-- Permite sobrescribir, POR CONTENIDO ESPECÍFICO (no por curso ni por
-- docente), el system prompt orquestador `content_generation` y/o
-- cualquiera de los 5 sub-prompts (`content.presentacion`,
-- `content.guia_docente`, `content.taller_practico`, `content.ejercicio`,
-- `content.examen`).
--
-- Jerarquía resuelta por el edge function `generate-contents`:
--   1) generated_contents.prompt_overrides[use_case]  (override de fila)
--   2) ai_prompts WHERE use_case=$key AND course_id IS NULL  (global Admin)
--   3) fallback hardcoded en el código del edge function
--
-- Diseño: JSONB con shape `{ [use_case]: string }`. Una key faltante o
-- con string vacío significa "usar el global". Esto permite mezclar
-- (ej. solo personalizar `content.presentacion` y dejar el resto en
-- global) sin tener que copiar todos los prompts.
--
-- Sin tabla aparte: el override pertenece 1-a-1 al contenido y se borra
-- con él. JSONB es suficiente, no necesitamos indexarlo (siempre se lee
-- por id del contenido).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.generated_contents
  ADD COLUMN IF NOT EXISTS prompt_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- CHECK: solo se permiten las keys conocidas. Defensa contra typos del
-- cliente (ej. "content.presentacion " con espacio). NO incluimos keys
-- de otros módulos para evitar que un cliente malicioso meta overrides
-- de `workshop_full` aprovechando este JSONB.
--
-- PostgreSQL NO permite subqueries dentro de CHECK constraints (error
-- "cannot use subquery in check constraint" / SQLSTATE 0A000). El
-- workaround es envolver la lógica en una función IMMUTABLE y llamarla
-- desde el CHECK — el planner trata la llamada como una expresión.
CREATE OR REPLACE FUNCTION public._check_content_prompt_overrides_keys(_overrides JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    _overrides IS NULL
    OR _overrides = '{}'::jsonb
    OR (
      SELECT bool_and(k IN (
        'content_generation',
        'content.presentacion',
        'content.guia_docente',
        'content.taller_practico',
        'content.ejercicio',
        'content.examen'
      ))
      FROM jsonb_object_keys(_overrides) AS k
    );
$$;

ALTER TABLE public.generated_contents
  DROP CONSTRAINT IF EXISTS generated_contents_prompt_overrides_keys_check;

ALTER TABLE public.generated_contents
  ADD CONSTRAINT generated_contents_prompt_overrides_keys_check
  CHECK (public._check_content_prompt_overrides_keys(prompt_overrides));

NOTIFY pgrst, 'reload schema';

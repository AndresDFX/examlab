-- ══════════════════════════════════════════════════════════════════════
-- Rename visible "Banco de preguntas" -> "Preguntas" en strings SEMBRADOS EN DB.
--
-- El rename del modulo (mas entendible como "Preguntas") ya se hizo en el codigo
-- (i18n es/en, module-catalog label, tour). Pero dos titulos VISIBLES viven
-- sembrados en tablas por migracion y no se actualizan editando el source:
--   1. platform_help_videos: titulo del video de ayuda del modulo (modulo-t06).
--   2. platform_kb_docs: titulo del doc del Knowledge Base del Asistente IA.
--
-- Identificadores INTERNOS intactos: el slug 'banco-de-preguntas' (id del KB doc)
-- y el id 'modulo-t06' NO se tocan — solo los TITULOS/CUERPO visibles.
--
-- Descubrimiento: el cuerpo del KB doc CONSERVA la mencion "banco de preguntas"
-- para que el Asistente IA siga matcheando a quien use el termino viejo.
-- Defensiva con to_regclass. Idempotente (busca por ILIKE del nombre viejo).
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.platform_help_videos') IS NOT NULL THEN
    UPDATE public.platform_help_videos
       SET title = regexp_replace(title, 'Banco de [Pp]reguntas', 'Preguntas', 'g')
     WHERE title ILIKE '%banco de preguntas%';
  END IF;

  IF to_regclass('public.platform_kb_docs') IS NOT NULL THEN
    -- Titulo visible -> "Preguntas". El slug (id) NO cambia.
    UPDATE public.platform_kb_docs
       SET title = 'Preguntas'
     WHERE slug = 'banco-de-preguntas' AND title ILIKE '%banco de preguntas%';
    -- Cuerpo: renombrar la referencia al modulo pero DEJAR el termino viejo como
    -- alias de descubrimiento para el asistente.
    UPDATE public.platform_kb_docs
       SET body = replace(
             body,
             'módulo "Banco de preguntas"',
             'módulo "Preguntas" (antes «Banco de preguntas»)'
           )
     WHERE slug = 'banco-de-preguntas'
       AND body LIKE '%módulo "Banco de preguntas"%';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

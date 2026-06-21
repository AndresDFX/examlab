-- ════════════════════════════════════════════════════════════════════
-- Pizarras: estado (borrador / activa / cerrada).
--
-- Hasta ahora una pizarra no tenía ciclo de vida — existía o estaba en la
-- papelera. Se agrega `status` con el MISMO vocabulario que exámenes/talleres/
-- proyectos (`draft | published | closed`) para reusar tal cual el filtro
-- compartido `matchesActivityStatus` (default oculta `closed`), el `StatusBadge`
-- y el `ActivityStatusSelect`. Así "Cerrada" se comporta igual que en el resto:
-- por defecto NO aparece en el listado activo (ni para el docente ni para el
-- alumno) hasta cambiar el filtro a "Cerradas" / "Todas".
--
-- DEFAULT 'published' → las pizarras existentes quedan ACTIVAS (visibles) sin
-- backfill; `matchesActivityStatus` también trata el nullish como published.
-- ════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.whiteboards') IS NULL THEN
    RAISE NOTICE 'skip whiteboards.status: tabla ausente en este entorno';
    RETURN;
  END IF;

  ALTER TABLE public.whiteboards
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'published';

  -- CHECK idempotente (lo agregamos solo si no existe ya).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.whiteboards'::regclass
       AND conname = 'whiteboards_status_check'
  ) THEN
    ALTER TABLE public.whiteboards
      ADD CONSTRAINT whiteboards_status_check
      CHECK (status IN ('draft', 'published', 'closed'));
  END IF;

  -- Índice parcial para listar rápido las activas (lo más común).
  CREATE INDEX IF NOT EXISTS idx_whiteboards_status
    ON public.whiteboards(status);
END $$;

NOTIFY pgrst, 'reload schema';

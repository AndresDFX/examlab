-- ============================================================
-- Sprint C — Periodo académico como entidad.
--
-- Hasta ahora `courses.period` era texto libre ("2026-1"). Tres
-- problemas:
--   1. Typos: "2026-1" vs "2026-I" no reconcilian. Los filtros y
--      analytics requieren match exacto.
--   2. Sin fechas: el periodo NO tenía start/end propios — solo los
--      cursos individuales. No se podía decir "del 4/02 al 17/06
--      es Periodo 2026-1".
--   3. Sin estado: no había forma de "cerrar" un periodo (la
--      institución cierra periodos para evitar modificaciones a
--      calificaciones posteriores; futuro mecanismo de Actas).
--
-- Modelo:
--   academic_periods (code, name, start_date, end_date, status)
--   status ∈ {planificado, activo, cerrado}
--
-- courses.period_id es FK opcional. Mantenemos `courses.period`
-- (texto) por compat con queries existentes; al guardar desde el
-- form, ambos se setean.
--
-- Backfill: por cada `code` distinto en `courses.period`, creamos
-- una fila en `academic_periods` con ese code y fijamos los FKs.
-- Los periodos backfill quedan en `planificado` con start/end NULL
-- — el admin los completa cuando los gestione manualmente.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.academic_periods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Código único usado por filtros y display (ej. "2026-1", "2026-2").
  code text NOT NULL,
  -- Nombre opcional para display largo (ej. "Primer semestre 2026").
  name text,
  -- Fechas del periodo. NULL permitido para periodos sin definir aún
  -- (puede que el admin solo sepa el código y complete las fechas
  -- cuando se acerquen).
  start_date date,
  end_date date,
  -- Estado del ciclo:
  --   planificado → futuro o sin fecha. Editable libremente.
  --   activo      → en curso. Editable.
  --   cerrado     → finalizado. La UI bloquea modificaciones a
  --                 calificaciones y muestra badge "Periodo cerrado".
  status text NOT NULL DEFAULT 'planificado'
    CHECK (status IN ('planificado', 'activo', 'cerrado')),
  -- Auditoría del cierre — para tener trazabilidad de quién/cuándo
  -- cerró un periodo.
  closed_at timestamptz,
  closed_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Code único por institución (1 instancia = 1 universidad).
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_periods_code
  ON public.academic_periods(LOWER(code));

-- Trigger updated_at.
DROP TRIGGER IF EXISTS trg_academic_periods_updated_at ON public.academic_periods;
CREATE TRIGGER trg_academic_periods_updated_at
  BEFORE UPDATE ON public.academic_periods
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.academic_periods ENABLE ROW LEVEL SECURITY;

-- SELECT abierto — los nombres aparecen en headers de informe y
-- dropdowns visibles por docentes/estudiantes.
DROP POLICY IF EXISTS "academic_periods_read" ON public.academic_periods;
CREATE POLICY "academic_periods_read"
  ON public.academic_periods FOR SELECT TO authenticated
  USING (true);

-- Write solo Admin.
DROP POLICY IF EXISTS "academic_periods_admin_write" ON public.academic_periods;
CREATE POLICY "academic_periods_admin_write"
  ON public.academic_periods FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ── FK desde courses ──
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS period_id uuid NULL
  REFERENCES public.academic_periods(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_courses_period_id
  ON public.courses(period_id);

-- ── Backfill: crear periodos desde los `period` text distintos
--    en `courses` y asignar period_id. ─────────────────────────
DO $$
DECLARE
  r RECORD;
  pid uuid;
BEGIN
  FOR r IN
    SELECT DISTINCT period FROM public.courses
    WHERE period IS NOT NULL AND length(trim(period)) > 0
  LOOP
    -- Si ya existe (por re-correr la migración), tomamos el id existente.
    SELECT id INTO pid FROM public.academic_periods WHERE LOWER(code) = LOWER(trim(r.period));
    IF pid IS NULL THEN
      INSERT INTO public.academic_periods (code, status)
      VALUES (trim(r.period), 'planificado')
      RETURNING id INTO pid;
    END IF;
    UPDATE public.courses
       SET period_id = pid
     WHERE period_id IS NULL AND trim(period) = trim(r.period);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';

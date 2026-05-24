-- ============================================================
-- Sprint B — Identidad del estudiante.
--
-- Las universidades exigen ciertos datos oficiales en actas,
-- certificados y reportes:
--   - código estudiantil (matrícula institucional, único por programa)
--   - documento de identidad
--   - cohorte (semestre/año de ingreso a la institución)
--   - estado (activo / retirado / graduado / aplazado)
--   - programa al que pertenece el estudiante
--
-- Todos OPCIONALES — no rompen usuarios existentes ni el flujo de
-- registro. El admin los completa para los estudiantes; los Docentes
-- y Admins no los necesitan (quedan null para ellos).
--
-- Cohorte se modela como texto "YYYY-N" (igual que `courses.period`)
-- para no forzar un formato — distintas instituciones manejan
-- distintos esquemas (semestre, trimestre, ciclo).
-- ============================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS codigo TEXT,
  ADD COLUMN IF NOT EXISTS documento TEXT,
  ADD COLUMN IF NOT EXISTS cohorte TEXT,
  ADD COLUMN IF NOT EXISTS estado TEXT,
  ADD COLUMN IF NOT EXISTS programa_id UUID
    REFERENCES public.academic_programs(id) ON DELETE SET NULL;

-- Estados canónicos. NULL queda permitido (estudiantes sin estado fijado
-- todavía, o usuarios no-Estudiante).
ALTER TABLE public.profiles
  DROP CONSTRAINT IF EXISTS chk_profiles_estado;
ALTER TABLE public.profiles
  ADD CONSTRAINT chk_profiles_estado
  CHECK (estado IS NULL OR estado IN ('activo', 'retirado', 'graduado', 'aplazado'));

-- Índices para búsquedas habituales:
--   - codigo: lookup por matrícula institucional (admin, secretaría).
--   - documento: lookup por cédula (verificación de actas).
--   - programa_id: filtros y analytics por programa.
-- Parcial WHERE NOT NULL para no indexar la mayoría de filas (los
-- usuarios no-Estudiante tendrán estos campos NULL).
CREATE INDEX IF NOT EXISTS idx_profiles_codigo
  ON public.profiles(codigo) WHERE codigo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_documento
  ON public.profiles(documento) WHERE documento IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profiles_programa_id
  ON public.profiles(programa_id) WHERE programa_id IS NOT NULL;

-- UNIQUE en código por programa (un programa no puede tener dos
-- estudiantes con el mismo código). NULL queda exento por defecto en
-- UNIQUE de Postgres, pero usamos índice parcial para ser explícitos.
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_codigo_programa_unique
  ON public.profiles(programa_id, LOWER(codigo))
  WHERE codigo IS NOT NULL AND programa_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

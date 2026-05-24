-- ============================================================
-- Programas Académicos (carreras / pregrados / postgrados).
--
-- Una institución típica tiene 5–30 programas (Ingeniería de Sistemas,
-- Ingeniería Industrial, Derecho, etc.). Cada `course` se asocia a UN
-- programa (course.program_id FK). Esa asociación alimenta los headers
-- de los informes institucionales (Acuerdo Pedagógico, Diagnóstico)
-- y eventualmente analytics agregados por programa.
--
-- Modelo mínimo intencionalmente — campos extras (facultad, decano,
-- coordinador) se agregan en migraciones futuras solo cuando una
-- pantalla los necesite. Evitamos crear columnas por especulación.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.academic_programs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nombre completo del programa (ej. "Ingeniería de Sistemas").
  name text NOT NULL,
  -- Código corto / abreviatura (ej. "IS", "ING-SIS"). Opcional.
  code text,
  -- Facultad / Departamento al que pertenece (ej. "Facultad de Ingeniería").
  -- Texto libre por ahora — si más adelante se vuelve fija, se modela como
  -- tabla `faculties` con FK.
  faculty text,
  -- Toggle de visibilidad. Los inactivos no se ofrecen en el dropdown
  -- de creación de curso pero NO se borran (preservan los cursos viejos
  -- que apuntan a ellos).
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL
);

-- Nombre único por institución (1 instancia de plataforma = 1 institución).
CREATE UNIQUE INDEX IF NOT EXISTS idx_academic_programs_name
  ON public.academic_programs(LOWER(name));

DROP TRIGGER IF EXISTS trg_academic_programs_updated_at ON public.academic_programs;
CREATE TRIGGER trg_academic_programs_updated_at
  BEFORE UPDATE ON public.academic_programs
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.academic_programs ENABLE ROW LEVEL SECURITY;

-- SELECT abierto a todos los autenticados (los nombres aparecen en
-- headers de informe y dropdowns de curso visibles por docentes).
DROP POLICY IF EXISTS "academic_programs_read" ON public.academic_programs;
CREATE POLICY "academic_programs_read"
  ON public.academic_programs FOR SELECT TO authenticated
  USING (true);

-- INSERT/UPDATE/DELETE: solo Admin.
DROP POLICY IF EXISTS "academic_programs_admin_write" ON public.academic_programs;
CREATE POLICY "academic_programs_admin_write"
  ON public.academic_programs FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- ── FK desde courses ──
ALTER TABLE public.courses
  ADD COLUMN IF NOT EXISTS program_id uuid NULL
  REFERENCES public.academic_programs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_courses_program_id
  ON public.courses(program_id);

-- ── Seed inicial ──
-- Pre-cargamos "Ingeniería de Sistemas" porque es lo que el usuario
-- mencionó como caso inicial. Los demás los agrega el admin desde la UI.
INSERT INTO public.academic_programs (name, code, faculty)
SELECT 'Ingeniería de Sistemas', 'IS', 'Facultad de Ingeniería'
WHERE NOT EXISTS (
  SELECT 1 FROM public.academic_programs WHERE LOWER(name) = LOWER('Ingeniería de Sistemas')
);

NOTIFY pgrst, 'reload schema';

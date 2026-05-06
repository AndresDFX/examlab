-- Talleres: peso relativo dentro del corte (igual al de exams.weight).
-- Hasta ahora los talleres se promediaban con peso uniforme dentro del
-- bucket de talleres del corte; ahora el docente puede dar más o menos
-- peso a un taller específico (taller largo vs taller corto).
ALTER TABLE public.workshops
  ADD COLUMN IF NOT EXISTS weight numeric NOT NULL DEFAULT 1;

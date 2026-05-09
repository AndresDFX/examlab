-- ============================================================
-- attendance_sessions.cut_id — asociación EXPLÍCITA al corte.
--
-- Antes: el corte de cada sesión se inferiía con un filtro por
-- fecha (`session_date BETWEEN cut.start_date AND cut.end_date`)
-- en cada cliente que computaba la nota de asistencia. Eso ataba
-- la asistencia al rango del corte y obligaba al docente a
-- mantener fechas correctas en cada corte para que la nota
-- saliera bien.
--
-- Ahora: el docente elige el corte AL CREAR la sesión y el cálculo
-- usa ese FK directo. Si se cambia start_date / end_date de un
-- corte, la sesión sigue donde estaba.
--
-- Backfill: para no romper sesiones existentes que se calculaban
-- por fecha, asignamos `cut_id` al primer corte cuyo rango
-- contenga `session_date`. Si la sesión no cae en ningún corte,
-- queda en NULL (el cliente la mostrará como "sin corte" y no
-- aportará a la nota — comportamiento idéntico al previo).
--
-- ON DELETE SET NULL: si el docente borra un corte, las sesiones
-- huérfanas quedan visibles y se pueden re-asignar.
-- ============================================================

ALTER TABLE public.attendance_sessions
  ADD COLUMN IF NOT EXISTS cut_id UUID
  REFERENCES public.grade_cuts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_attendance_sessions_cut
  ON public.attendance_sessions(cut_id);

-- Backfill: para cada sesión sin cut_id, busca el corte del MISMO
-- curso cuyo rango de fechas contenga la session_date. Si hay
-- múltiples cortes solapados (no debería pasar, pero por si acaso)
-- usa el primero por position.
UPDATE public.attendance_sessions s
   SET cut_id = (
     SELECT c.id
       FROM public.grade_cuts c
      WHERE c.course_id = s.course_id
        AND c.start_date IS NOT NULL
        AND c.end_date IS NOT NULL
        AND s.session_date BETWEEN c.start_date AND c.end_date
      ORDER BY c.position
      LIMIT 1
   )
 WHERE s.cut_id IS NULL;

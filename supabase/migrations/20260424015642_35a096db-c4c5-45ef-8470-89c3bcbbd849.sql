-- ============================================================
-- exam_notes: notas de apoyo subidas por el estudiante por examen
-- Flujo: pendiente → aprobada / rechazada (con razón)
-- Si está aprobada, el contenido es visible durante el examen.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.exam_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES public.exams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','aprobada','rechazada')),
  rejection_reason TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exam_notes_exam_user
  ON public.exam_notes(exam_id, user_id);

CREATE INDEX IF NOT EXISTS idx_exam_notes_status
  ON public.exam_notes(exam_id, status);

ALTER TABLE public.exam_notes ENABLE ROW LEVEL SECURITY;

-- Estudiante: gestionar SUS notas
CREATE POLICY "Students manage own exam notes"
  ON public.exam_notes
  FOR ALL
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Docente / Admin: ver todas las notas
CREATE POLICY "Teachers see all exam notes"
  ON public.exam_notes
  FOR SELECT
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
  );

-- Docente / Admin: aprobar / rechazar
CREATE POLICY "Teachers update exam notes"
  ON public.exam_notes
  FOR UPDATE
  TO authenticated
  USING (
    public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
  )
  WITH CHECK (
    public.has_role(auth.uid(), 'Docente'::public.app_role)
    OR public.has_role(auth.uid(), 'Admin'::public.app_role)
  );

-- Trigger updated_at
CREATE TRIGGER exam_notes_set_updated_at
  BEFORE UPDATE ON public.exam_notes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

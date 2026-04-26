
-- 1) Add cut_id to workshops and exams
ALTER TABLE public.workshops
  ADD COLUMN IF NOT EXISTS cut_id uuid REFERENCES public.grade_cuts(id) ON DELETE SET NULL;

ALTER TABLE public.exams
  ADD COLUMN IF NOT EXISTS cut_id uuid REFERENCES public.grade_cuts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_workshops_cut_id ON public.workshops(cut_id);
CREATE INDEX IF NOT EXISTS idx_exams_cut_id ON public.exams(cut_id);

-- 2) Recreate the missing trigger that materialises profiles on auth signup
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

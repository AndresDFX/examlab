ALTER TABLE public.course_enrollments
ADD CONSTRAINT course_enrollments_user_profile_fk
FOREIGN KEY (user_id)
REFERENCES public.profiles(id)
ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_course_enrollments_user_id
ON public.course_enrollments(user_id);
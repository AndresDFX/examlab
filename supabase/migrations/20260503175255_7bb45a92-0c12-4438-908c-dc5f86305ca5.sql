ALTER TABLE public.workshop_questions DROP CONSTRAINT IF EXISTS workshop_questions_type_check;
ALTER TABLE public.workshop_questions ADD CONSTRAINT workshop_questions_type_check
  CHECK (type IN ('abierta','cerrada','codigo','diagrama','java_gui'));

ALTER TABLE public.questions DROP CONSTRAINT IF EXISTS questions_type_check;
ALTER TABLE public.questions ADD CONSTRAINT questions_type_check
  CHECK (type IN ('abierta','cerrada','codigo','diagrama','java_gui'));
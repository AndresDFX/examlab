
CREATE OR REPLACE FUNCTION public.enforce_cut_item_weights_max_100()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(weight), 0) INTO total
  FROM public.grade_cut_items
  WHERE cut_id = COALESCE(NEW.cut_id, OLD.cut_id)
    AND id <> COALESCE(NEW.id, OLD.id);
  total := total + COALESCE(NEW.weight, 0);
  IF total > 100.01 THEN
    RAISE EXCEPTION 'La suma de pesos de items del corte excede 100 (actual: %).', total;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.enforce_cut_weights_max_100()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE total NUMERIC;
BEGIN
  SELECT COALESCE(SUM(weight), 0) INTO total
  FROM public.grade_cuts
  WHERE course_id = COALESCE(NEW.course_id, OLD.course_id)
    AND id <> COALESCE(NEW.id, OLD.id);
  total := total + COALESCE(NEW.weight, 0);
  IF total > 100.01 THEN
    RAISE EXCEPTION 'La suma de pesos de cortes excede 100 (actual: %).', total;
  END IF;
  RETURN NEW;
END $function$;

-- ══════════════════════════════════════════════════════════════════════
-- La ciudad del curso vuelve a quedar VACÍA: hereda la de la institución.
--
-- La migración anterior (20262540000000) escribió 'Cali' en los cursos 2026-2
-- de UNIAJ. Al ver el resultado, la decisión fue otra: el Acuerdo debe seguir
-- diciendo lo que dice la institución —«Santiago de Cali»— y el problema real
-- que se estaba persiguiendo era que en esa casilla apareciera el teléfono del
-- vocero, que ya se corrigió aparte.
--
-- Se deja en NULL en vez de escribir «Santiago de Cali» en cada curso, y la
-- diferencia importa: con NULL el curso HEREDA, así que el día que la
-- institución corrija su ciudad los cursos la siguen solos. Copiar el texto los
-- habría congelado, que es exactamente el problema que tienen los informes.
--
-- La columna y el campo del formulario se quedan: sirven para sobrescribir la
-- ciudad de un curso puntual cuando se dicta en otra sede.
--
-- Solo limpia los que quedaron con el valor que puso aquella migración. Si
-- alguien ya escribió una ciudad a mano, no se toca.
-- ══════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_n int;
BEGIN
  IF to_regclass('public.courses') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'courses' AND column_name = 'ciudad'
  ) THEN RETURN; END IF;

  UPDATE public.courses
     SET ciudad = NULL
   WHERE tenant_id = 'b35d1bd2-8e9b-4ba3-9ede-545262b9520d'
     AND period = '2026-2'
     AND ciudad = 'Cali';

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Cursos que vuelven a heredar la ciudad de la institución: %', v_n;
END $$;

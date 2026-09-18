-- Sube el tope por defecto de una respuesta ABIERTA de 500 a 5.000 caracteres,
-- y levanta a las instituciones que quedaron por debajo.
--
-- ══════════════════════════════════════════════════════════════════════════
-- ── El daño, medido en producción ───────────────────────────────────────
-- `max_open_answer_chars` solo se aplicaba en la pantalla de EXAMEN (el taller
-- y el proyecto iban sin tope), y su default era 500. Una institución lo tenía
-- en 300.
--
-- En un quiz real de 11 entregas con ese tope de 300: **10 estudiantes
-- tocaron el límite en al menos una respuesta**, y uno en 4 de sus 8. La
-- distribución de longitudes lo delata sola — 300, 300, 299, 298, 297, 295 —:
-- eso no es gente que terminó de escribir, es gente que se chocó contra un
-- muro. Esas respuestas cortadas a mitad de frase son las que después califica
-- la IA y las que lee el docente.
--
-- ── Por qué 5.000 y no otro número ──────────────────────────────────────
-- Donde NO hay tope (talleres) se puede ver cuánto escribe la gente de verdad:
-- sobre 91 respuestas, mediana 459 caracteres, percentil 90 en 1.095 y máximo
-- histórico 2.460. **Nadie ha pasado nunca de 3.000.** 5.000 duplica ese
-- máximo, así que no trunca a nadie, y además ya era el valor que 6 de las 7
-- instituciones habían puesto a mano: esto las unifica en vez de inventar una
-- cifra nueva. Sigue acotando el costo de tokens de la IA —5.000 caracteres
-- son ~1.250 tokens—, que es la razón por la que el tope existe.
--
-- ── Por qué se SUBE a las existentes y no solo el default ───────────────
-- Cambiar el DEFAULT de la columna no toca ninguna fila ya creada: las siete
-- instituciones ya tienen su fila (la siembra `tg_provision_tenant_defaults`),
-- así que sin el UPDATE la que está en 300 se quedaba en 300 y el arreglo no
-- llegaba a nadie.
--
-- Solo se SUBE, nunca se baja: si una institución eligió a conciencia un tope
-- más alto que 5.000, es una decisión suya y no corresponde revertirla.
--
-- El CHECK (100..50000) no cambia: 5.000 cae cómodo adentro.
-- ══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_subidas INT := 0;
BEGIN
  IF to_regclass('public.app_settings') IS NULL THEN
    RAISE NOTICE 'app_settings no existe en este entorno; nada que hacer.';
    RETURN;
  END IF;

  -- 1) El default, para las instituciones que se creen de acá en adelante.
  ALTER TABLE public.app_settings
    ALTER COLUMN max_open_answer_chars SET DEFAULT 5000;

  -- 2) Las que ya existen y quedaron por debajo.
  UPDATE public.app_settings
     SET max_open_answer_chars = 5000
   WHERE max_open_answer_chars < 5000;

  GET DIAGNOSTICS v_subidas = ROW_COUNT;
  RAISE NOTICE 'Instituciones con el tope subido a 5000: %', v_subidas;
END $$;

COMMENT ON COLUMN public.app_settings.max_open_answer_chars IS
  'Tope de caracteres de una respuesta abierta (examen, taller y proyecto). '
  'Default 5000: duplica el máximo histórico real observado (2460) y acota el '
  'costo de tokens de la IA. Rango permitido 100..50000.';

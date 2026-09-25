-- ══════════════════════════════════════════════════════════════════════
-- La ciudad del Acuerdo pasa a ser del CURSO.
--
-- Hasta ahora la casilla «Ciudad» del Acuerdo Pedagógico salía de
-- `app_settings.ciudad`, que es un dato POR INSTITUCIÓN. Eso alcanza mientras
-- la institución dicta en un solo lugar, y deja de alcanzar apenas hay sedes:
-- el Acuerdo lo firma un grupo concreto, en una ciudad concreta, y esa ciudad
-- es un atributo del curso, no del tenant.
--
-- La columna es OPCIONAL y sin valor por defecto: un curso que no la tenga
-- sigue tomando la de la institución, así que ningún curso existente cambia de
-- comportamiento hasta que alguien decida escribirla. Es el mismo criterio con
-- el que se agregó `profiles.telefono`.
-- ══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF to_regclass('public.courses') IS NOT NULL THEN
    ALTER TABLE public.courses
      ADD COLUMN IF NOT EXISTS ciudad TEXT;

    -- Tope defensivo: es una casilla de un documento oficial, no un campo
    -- libre. Sin cota, un pegado accidental desmaqueta la tabla del Acuerdo.
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'chk_courses_ciudad_largo'
    ) THEN
      ALTER TABLE public.courses
        ADD CONSTRAINT chk_courses_ciudad_largo
        CHECK (ciudad IS NULL OR char_length(ciudad) <= 80);
    END IF;
  END IF;
END $$;

COMMENT ON COLUMN public.courses.ciudad IS
  'Ciudad donde se dicta el curso. La usa la casilla «Ciudad» del Acuerdo '
  'Pedagógico; si está vacía se toma app_settings.ciudad de la institución.';

-- ── Relleno del semestre en curso ────────────────────────────────────
-- Los cursos 2026-2 de la Universidad Antonio José Camacho se dictan en Cali.
-- Va ACOTADO a esa institución y a ese periodo, con nombre propio, en vez de
-- una regla general: «copiar la ciudad de la institución» le pondría
-- «Santiago de Cali» —que es como está cargada en `app_settings`— y lo que el
-- documento tiene que decir es «Cali». Y una regla por periodo sin acotar el
-- tenant tocaría los cursos de las otras seis instituciones, que no sabemos
-- dónde se dictan.
--
-- Solo escribe donde está NULL: si alguien ya puso una ciudad distinta, gana
-- la suya.
DO $$
DECLARE v_n int;
BEGIN
  IF to_regclass('public.courses') IS NULL THEN RETURN; END IF;

  UPDATE public.courses
     SET ciudad = 'Cali'
   WHERE tenant_id = 'b35d1bd2-8e9b-4ba3-9ede-545262b9520d'
     AND period = '2026-2'
     AND ciudad IS NULL
     AND deleted_at IS NULL;

  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'Cursos 2026-2 con ciudad = Cali: %', v_n;
END $$;

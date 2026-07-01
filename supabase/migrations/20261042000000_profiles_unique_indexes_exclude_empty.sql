-- ══════════════════════════════════════════════════════════════════════
-- Endurecer índices únicos parciales de profiles contra cadena vacía (misma
-- clase que el bug de personal_email arreglado en 20261040).
--
-- Hallazgo (workflow de errores, 2026-07-01): dos índices únicos parciales
-- excluyen NULL pero NO la cadena vacía '', que queda indexada como valor:
--   • idx_profiles_student_code_per_tenant = UNIQUE(tenant_id, lower(student_code))
--       WHERE student_code IS NOT NULL
--   • idx_profiles_codigo_programa_unique   = UNIQUE(programa_id, lower(codigo))
--       WHERE codigo IS NOT NULL AND programa_id IS NOT NULL
-- Si un futuro flujo escribiera student_code='' (dos alumnos del mismo tenant) o
-- codigo='' + programa_id (dos del mismo programa), chocarían con unique_violation
-- — exactamente lo que rompió el import con personal_email. Hoy los escritores
-- normalizan a NULL (edge salta vacío, el form hace `|| null`), así que es
-- LATENTE; se endurece a nivel DB para que sea imposible reintroducirlo.
--
-- Fix: recrear ambos índices excluyendo también '' (AND btrim(col) <> '') +
-- backfill de cualquier '' existente → NULL (hoy 0 filas, idempotente).
-- ══════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    -- Backfill defensivo: '' / whitespace → NULL antes de recrear los índices.
    UPDATE public.profiles SET student_code = NULL WHERE btrim(student_code) = '';
    UPDATE public.profiles SET codigo = NULL WHERE btrim(codigo) = '';

    DROP INDEX IF EXISTS public.idx_profiles_student_code_per_tenant;
    CREATE UNIQUE INDEX idx_profiles_student_code_per_tenant
      ON public.profiles (tenant_id, lower(student_code))
      WHERE student_code IS NOT NULL AND btrim(student_code) <> '';

    DROP INDEX IF EXISTS public.idx_profiles_codigo_programa_unique;
    CREATE UNIQUE INDEX idx_profiles_codigo_programa_unique
      ON public.profiles (programa_id, lower(codigo))
      WHERE codigo IS NOT NULL AND programa_id IS NOT NULL AND btrim(codigo) <> '';
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

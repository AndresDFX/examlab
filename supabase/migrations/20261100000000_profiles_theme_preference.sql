-- Preferencia de tema por usuario, persistida en el perfil (sigue al usuario entre dispositivos).
-- El default de la app YA es claro (use-theme.ts nunca lee prefers-color-scheme), así que el modo
-- claro se fuerza aunque el SO esté en oscuro. Esta columna solo permite que el usuario que
-- prefiere oscuro guarde su elección y la reencuentre en cualquier equipo.
DO $$ BEGIN
  IF to_regclass('public.profiles') IS NOT NULL THEN
    ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS theme_preference text;
    ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_theme_preference_check;
    ALTER TABLE public.profiles ADD CONSTRAINT profiles_theme_preference_check
      CHECK (theme_preference IS NULL OR theme_preference IN ('light', 'dark'));
    COMMENT ON COLUMN public.profiles.theme_preference IS
      'Preferencia de tema (light|dark). NULL = default claro. Persiste entre dispositivos; localStorage examlab-theme es el cache/pre-paint por equipo.';
  END IF;
END $$;

-- El usuario guarda SU propia preferencia sin depender de la RLS de UPDATE de profiles
-- (que puede estar acotada a Admin). SECURITY DEFINER escribe solo la fila del caller.
CREATE OR REPLACE FUNCTION public.set_theme_preference(_theme text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF _theme IS NOT NULL AND _theme NOT IN ('light', 'dark') THEN
    RAISE EXCEPTION 'Tema inválido: %', _theme;
  END IF;
  UPDATE public.profiles SET theme_preference = _theme WHERE id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.set_theme_preference(text) FROM PUBLIC;
-- Supabase concede EXECUTE a anon por default privileges al crear la función;
-- lo quitamos explícitamente (el guard auth.uid() ya lo bloquearía, pero
-- menor-privilegio: solo usuarios autenticados guardan su preferencia).
REVOKE ALL ON FUNCTION public.set_theme_preference(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_theme_preference(text) TO authenticated;

NOTIFY pgrst, 'reload schema';

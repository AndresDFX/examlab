-- ──────────────────────────────────────────────────────────────────────
-- Onboarding tour: registrar qué roles del usuario ya completaron el
-- tour guiado de bienvenida.
--
-- Diseño:
--   - Array TEXT[] en profiles, no tabla separada. Cada elemento es uno
--     de los nombres de rol ('Admin', 'Docente', 'Estudiante') —
--     NUNCA 'SuperAdmin' (no tiene tour por decisión de producto).
--   - Default '{}' (sin completar nada) para que usuarios existentes
--     vean el tour de su rol activo al próximo login. Si la institución
--     prefiere que los usuarios viejos no se vean interrumpidos, basta
--     correr un UPDATE one-shot que pre-marca a todos como completos.
--   - El cliente decide cuándo mostrar el tour: lee este array y compara
--     contra el activeRole actual. Si el rol activo NO está en el array,
--     dispara el tour. Al finalizarlo, agrega el rol al array.
--
-- Por qué array y no JSONB:
--   - El use case es "set membership" — array nativo lo expresa mejor
--     y permite GIN index si después se necesita búsqueda.
--   - Las RPCs y queries son más simples (`ANY()` vs `?` operator).
-- ──────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed_roles TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.profiles.onboarding_completed_roles IS
  'Roles para los cuales este usuario ya completó (o saltó) el tour guiado de bienvenida. Cuando el activeRole NO está en este array, el cliente dispara el tour. Valores válidos: Admin, Docente, Estudiante. SuperAdmin nunca aparece (no tiene tour).';

-- RPC: marcar un rol como completado. Idempotente — si ya está, no hace
-- nada. La definimos como SECURITY DEFINER para que el cliente la llame
-- sin necesidad de tener UPDATE permiso explícito sobre profiles
-- (la RLS existente solo permite UPDATE sobre id=auth.uid(), lo cual
-- ya basta, pero esta RPC además limpia/normaliza el valor).
CREATE OR REPLACE FUNCTION public.mark_onboarding_complete(_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  -- Validación: solo roles humanos con tour configurado.
  IF _role NOT IN ('Admin', 'Docente', 'Estudiante') THEN
    RAISE EXCEPTION 'Rol inválido para onboarding: %', _role;
  END IF;

  UPDATE public.profiles
     SET onboarding_completed_roles =
           CASE
             WHEN _role = ANY(onboarding_completed_roles) THEN onboarding_completed_roles
             ELSE onboarding_completed_roles || _role
           END
   WHERE id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_onboarding_complete(TEXT) TO authenticated;

-- RPC simétrica para RE-disparar el tour. Quita un rol del array, de
-- modo que el próximo render del cliente vuelva a mostrar el tour. El
-- botón "Ver tour" del menú del avatar puede usar esto, aunque el
-- cliente también puede simplemente abrir el componente en modo manual
-- sin tocar la DB. La dejamos por completitud.
CREATE OR REPLACE FUNCTION public.reset_onboarding(_role TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF _role NOT IN ('Admin', 'Docente', 'Estudiante') THEN
    RAISE EXCEPTION 'Rol inválido para onboarding: %', _role;
  END IF;

  UPDATE public.profiles
     SET onboarding_completed_roles = array_remove(onboarding_completed_roles, _role)
   WHERE id = auth.uid();
END;
$$;

GRANT EXECUTE ON FUNCTION public.reset_onboarding(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

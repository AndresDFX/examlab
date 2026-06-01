-- ──────────────────────────────────────────────────────────────────────
-- tg_check_profile_tenant_change: eximir SuperAdmin.
--
-- El trigger original (mig 20260623) bloquea cambiar `profiles.tenant_id`
-- cuando el usuario tiene cursos activos en el tenant viejo — protección
-- para Admin/Docente/Estudiante que perderían acceso a sus cursos por
-- el aislamiento de RLS si se mudan de institución sin limpiar.
--
-- Pero el SuperAdmin es cross-tenant: `is_super_admin()` bypassa la RLS
-- de todas las tablas con tenant scope. Para él, "tenant_id" del profile
-- es solo branding/contexto del role-switcher, no un gate de acceso.
-- Querer "desasociarlo" del tenant (tenant_id = NULL) para que opere en
-- modo cross-tenant puro es legítimo, aunque tenga matrículas/cursos en
-- el tenant viejo — esas relaciones siguen funcionando porque RLS lo
-- exime.
--
-- Cambio: agregar una rama temprana que retorna NEW si el usuario tiene
-- el rol SuperAdmin, antes de los checks de cursos.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.tg_check_profile_tenant_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_enrollments INT;
  v_teaching    INT;
BEGIN
  -- Solo nos importa cuando tenant_id realmente cambia.
  IF OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id THEN
    RETURN NEW;
  END IF;

  -- Caso "viejo = NULL" (ventana transitoria pre-Fase 6 — profile creado
  -- sin tenant + completado al aceptar invitación).
  IF OLD.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- ── NUEVO: el SuperAdmin opera cross-tenant. Cambiarle el tenant (o
  --    desligarlo a NULL) no le bloquea acceso a nada porque
  --    `is_super_admin()` bypassa la RLS de tablas con tenant scope.
  --    No exigimos limpiar matrículas/cursos del tenant viejo.
  IF EXISTS (
    SELECT 1 FROM public.user_roles
     WHERE user_id = NEW.id AND role = 'SuperAdmin'
  ) THEN
    RETURN NEW;
  END IF;

  -- Para no-SuperAdmin: si tiene cursos activos en el tenant viejo,
  -- rechazamos — sino perdería acceso a ellos por aislamiento de RLS.
  SELECT COUNT(*) INTO v_enrollments
    FROM public.course_enrollments e
    JOIN public.courses c ON c.id = e.course_id
   WHERE e.user_id = NEW.id AND c.tenant_id = OLD.tenant_id;

  SELECT COUNT(*) INTO v_teaching
    FROM public.course_teachers t
    JOIN public.courses c ON c.id = t.course_id
   WHERE t.user_id = NEW.id AND c.tenant_id = OLD.tenant_id;

  IF v_enrollments > 0 OR v_teaching > 0 THEN
    RAISE EXCEPTION 'No se puede cambiar la institución del usuario: tiene cursos activos en la institución actual (% como estudiante, % como docente)',
      v_enrollments, v_teaching
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

NOTIFY pgrst, 'reload schema';

-- ──────────────────────────────────────────────────────────────────────
-- Multi-tenancy Fase 3: scoping del contenido y la actividad.
--
-- Las tablas exams, workshops, projects, attendance_sessions,
-- course_actas, course_schedules YA tienen `course_id` apuntando a
-- courses. Como `courses.tenant_id` existe desde la Fase 2, NO
-- agregamos tenant_id duplicado a cada tabla — heredamos via FK.
--
-- La pieza crítica de seguridad es bloquear las MEMBRESÍAS cross-tenant:
--   - course_teachers.user_id debe pertenecer al mismo tenant que el
--     course.tenant_id.
--   - course_enrollments.user_id debe pertenecer al mismo tenant que el
--     course.tenant_id.
--
-- Si esas dos tablas se mantienen "same-tenant only", las RLS existentes
-- de exams/workshops/projects/attendance/actas (que filtran por teacher
-- assignment o enrollment) heredan el aislamiento de tenant
-- automáticamente. No tocamos sus policies.
--
-- Adicionalmente bloqueamos el caso de "cambiar el tenant_id de un
-- course existente" — eso dejaría enrollments huérfanos.
-- ──────────────────────────────────────────────────────────────────────

-- ════════════════════════════════════════════════════════════════════
-- 1) Trigger anti cross-tenant en course_teachers
-- ════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.tg_check_course_membership_tenant()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_course_tenant UUID;
  v_user_tenant   UUID;
BEGIN
  -- Tenant del curso. Si el curso no existe, el FK ya tira error —
  -- llegamos acá solo con un curso válido.
  SELECT tenant_id INTO v_course_tenant
    FROM public.courses WHERE id = NEW.course_id;

  -- Tenant del usuario.
  SELECT tenant_id INTO v_user_tenant
    FROM public.profiles WHERE id = NEW.user_id;

  IF v_course_tenant IS NULL THEN
    RAISE EXCEPTION 'El curso % no tiene tenant asignado', NEW.course_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Si el profile aún no tiene tenant (ventana de invitación transitoria
  -- de Fase 1), también rechazamos. Forzar invariante: solo usuarios
  -- con tenant pueden ser miembros de cursos.
  IF v_user_tenant IS NULL THEN
    RAISE EXCEPTION 'El usuario % no tiene institución asignada', NEW.user_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_course_tenant <> v_user_tenant THEN
    RAISE EXCEPTION 'No se puede asignar un usuario de otra institución a este curso'
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_course_teachers_tenant_check ON public.course_teachers;
CREATE TRIGGER trg_course_teachers_tenant_check
  BEFORE INSERT OR UPDATE OF user_id, course_id ON public.course_teachers
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_course_membership_tenant();

-- ════════════════════════════════════════════════════════════════════
-- 2) Trigger anti cross-tenant en course_enrollments
-- ════════════════════════════════════════════════════════════════════
-- Reutilizamos la misma función — la firma de course_id / user_id es
-- idéntica entre course_teachers y course_enrollments.

DROP TRIGGER IF EXISTS trg_course_enrollments_tenant_check ON public.course_enrollments;
CREATE TRIGGER trg_course_enrollments_tenant_check
  BEFORE INSERT OR UPDATE OF user_id, course_id ON public.course_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_course_membership_tenant();

-- ════════════════════════════════════════════════════════════════════
-- 3) Bloquear cambio de tenant_id en courses post-creación
-- ════════════════════════════════════════════════════════════════════
-- Una vez que un curso tiene enrollments/teachers/exams/etc., cambiarle
-- el tenant deja huérfanas todas esas filas (apuntan a un curso que ya
-- no es de "su" tenant). Política: tenant_id de un curso es inmutable.
-- Si SuperAdmin necesita mover un curso, debe migrar manualmente
-- (script ad-hoc), no via UPDATE accidental.

CREATE OR REPLACE FUNCTION public.tg_forbid_course_tenant_change()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id THEN
    RAISE EXCEPTION 'No se puede cambiar la institución (tenant) de un curso existente'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_courses_forbid_tenant_change ON public.courses;
CREATE TRIGGER trg_courses_forbid_tenant_change
  BEFORE UPDATE OF tenant_id ON public.courses
  FOR EACH ROW EXECUTE FUNCTION public.tg_forbid_course_tenant_change();

-- ════════════════════════════════════════════════════════════════════
-- 4) Bloquear cambio de tenant_id en profiles
-- ════════════════════════════════════════════════════════════════════
-- Mismo razonamiento que con courses: cambiar el tenant de un user con
-- enrollments activos deja huérfanas filas. Si un usuario realmente
-- cambia de institución, hay que (a) sacarlo de todos los cursos del
-- tenant viejo, (b) recién entonces moverlo al nuevo. Lo bloqueamos
-- excepto si los triggers de course_* ya están vacíos para ese user.

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

  -- Permitir el caso "viejo = NULL" (ventana transitoria de invitación
  -- pre-Fase 6 — profile se crea sin tenant y la app lo completa al
  -- aceptar la invitación).
  IF OLD.tenant_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Si el usuario tiene cursos activos en el tenant viejo, rechazamos.
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

DROP TRIGGER IF EXISTS trg_profiles_check_tenant_change ON public.profiles;
CREATE TRIGGER trg_profiles_check_tenant_change
  BEFORE UPDATE OF tenant_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.tg_check_profile_tenant_change();

NOTIFY pgrst, 'reload schema';

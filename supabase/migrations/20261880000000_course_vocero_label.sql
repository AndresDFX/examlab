-- ══════════════════════════════════════════════════════════════════════
-- Vocero del curso — ETIQUETA INFORMATIVA. NO es un rol y NO da permisos.
--
-- Pedido: el docente o el Admin marca al representante del curso; se ve como
-- etiqueta, se puede filtrar, y los COMPAÑEROS lo ven al entrar al curso junto
-- con su correo. Nada más: no habilita acciones, no cambia notas.
--
-- ── Por qué acá y no en `user_roles` ──────────────────────────────────
-- `has_role()` es GLOBAL —no tiene `course_id` ni `tenant_id`— y es el predicado
-- con el que branchean cientos de policies de este proyecto. Un 'Vocero' en
-- `user_roles` quedaría a UN solo `OR has_role(uid,'Vocero')` de convertirse en
-- permiso, y además entraría al role-switcher y a `ALL_ROLES`. La designación es
-- de UNA matrícula (este alumno, en este curso, en este periodo), así que la
-- fila de `course_enrollments` es el lugar exacto: hace verdadera POR
-- CONSTRUCCIÓN la invariante "vocero ⇒ matriculado", y hereda el scope de curso
-- y de institución que esa tabla ya tiene bien.
--
-- ── Por qué `vocero_marcado_at` y no `is_vocero` ──────────────────────
-- Un booleano con ese nombre invita a escribir `if (is_vocero) puedeX`. Un
-- timestamp de designación se lee como el registro que es, y regala la
-- procedencia (quién y cuándo), que es lo único que después permite auditarlo.
--
-- ── Por qué las RPC son SECURITY INVOKER ──────────────────────────────
-- Las tres policies de escritura de `course_enrollments` YA son exactamente los
-- actores autorizados y YA tienen scope:
--   · `enrollments_docente_manage`  → `_teaches_course(course_id) AND has_role('Docente')`
--   · `enrollments_admin_manage`    → `course_in_my_tenant(course_id) AND has_role('Admin')`
--   · `enrollments_super_admin_manage` → `is_super_admin()`
-- Con INVOKER esas policies SON la autorización: no hay nada que re-derivar. Con
-- DEFINER habría que reimplementarlas, que es de donde salió el bug de
-- `mark_forum_reply_official` (un `has_role('Admin')` sin tenant y sin rama de
-- SuperAdmin).
--
-- ── Qué ve el estudiante, y qué NO ────────────────────────────────────
-- `enrollments_select_in_tenant` le da hoy al alumno SOLO su propia fila: esa
-- migración (20261071000000) cerró el roster a propósito, porque antes un
-- estudiante veía las 195 matrículas de la institución. Acá se agrega UNA rama
-- quirúrgica: la fila que ES la del vocero, solo para quien está matriculado en
-- ese curso, y solo si el curso no está en la papelera. Nada más del roster se
-- abre — jamás una rama tipo "todo matriculado ve las matrículas de su curso",
-- que filtraría la lista completa.
--
-- El CORREO del vocero no es una exposición nueva: `profiles_select_same_tenant`
-- ya deja a cualquier autenticado leer los perfiles de su institución (existe
-- para que los nombres de compañeros se puedan mostrar en cursos y grupos). Lo
-- único que faltaba era saber QUIÉN es el vocero.
--
-- El helper `_is_enrolled_in_course` es `STABLE SECURITY DEFINER`, así que no
-- re-entra a la RLS de la tabla → sin la recursión de policy que ya quemó al
-- proyecto (20260915000000).
-- ══════════════════════════════════════════════════════════════════════

DO $mig$
BEGIN
  IF to_regclass('public.course_enrollments') IS NULL THEN
    RAISE NOTICE 'public.course_enrollments no existe — se omite la migración del vocero.';
    RETURN;
  END IF;

  -- Dos columnas nullable: ADD COLUMN sin DEFAULT no reescribe la tabla.
  ALTER TABLE public.course_enrollments
    ADD COLUMN IF NOT EXISTS vocero_marcado_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS vocero_marcado_por UUID
      REFERENCES auth.users(id) ON DELETE SET NULL;

  -- ON DELETE SET NULL (misma convención que `deleted_by` de la papelera): así
  -- esta FK NO bloquea el `DELETE FROM auth.users` de `hard_delete_tenant` y no
  -- hay que actualizar esa RPC.

  -- UNO por curso. Índice PARCIAL (mismo patrón que `ai_model_settings.is_active`):
  -- un UNIQUE duro sobre (course_id) sería absurdo, y sin constraint nada impide
  -- 30 "voceros" — con lo que la etiqueta deja de informar y el filtro se vuelve
  -- ruido. El Acuerdo Pedagógico tiene UNA fila "Nombre del vocero" y UNA celda
  -- de firma: con N, el acta elegiría uno arbitrariamente.
  -- Sirve además de índice de lookup "¿quién es el vocero del curso X?".
  CREATE UNIQUE INDEX IF NOT EXISTS course_enrollments_one_vocero_uidx
    ON public.course_enrollments (course_id)
    WHERE vocero_marcado_at IS NOT NULL;
END $mig$;

COMMENT ON COLUMN public.course_enrollments.vocero_marcado_at IS
  'Etiqueta INFORMATIVA: designacion del vocero (representante) del curso. NO otorga permisos. PROHIBIDO usarla en policies RLS, en RPCs de autorizacion o en gates de UI/ruta: el vocero se MUESTRA, no habilita nada. Escritura exclusiva del docente del curso / Admin del tenant / SuperAdmin (RLS + tg_course_enrollments_guard_vocero).';
COMMENT ON COLUMN public.course_enrollments.vocero_marcado_por IS
  'Quien designo. La fija el trigger con auth.uid(); lo que manda el cliente se ignora.';

-- ─── Guard de columna ───────────────────────────────────────────────────
-- La RLS de hoy no tiene rama escribible por el dueño, así que un estudiante NO
-- puede auto-marcarse. Pero esa es la ÚNICA barrera: `authenticated` (y `anon`)
-- tienen INSERT/UPDATE sobre toda la tabla y una columna nueva hereda ese GRANT.
-- Y el roadmap la abre solo: el día que exista auto-matrícula (`self_signup`),
-- `course_enrollments` gana una rama owner-writable y esta marca se vuelve
-- auto-asignable en esa misma migración, sin que nadie relacione las dos cosas.
-- El trigger hace que la autorización de ESTA columna no dependa de la forma de
-- la policy.
--
-- Congela a OLD en vez de RAISE (patrón de tg_support_tickets_guard_admin_columns):
-- un UPDATE legítimo que de paso toque la columna no debe fallar, solo no debe
-- lograr el cambio.
CREATE OR REPLACE FUNCTION public.tg_course_enrollments_guard_vocero()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
AS $fn$
DECLARE
  v_autorizado boolean;
BEGIN
  -- Sin sesión = service_role (que bypassa RLS de todos modos) o anon (al que
  -- ninguna policy de escritura deja pasar). Congelar acá solo crearía un fallo
  -- MUDO en un edge legítimo.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- `is_admin_of_course_tenant` = is_super_admin() OR (Admin AND mismo tenant):
  -- cubre Admin y SuperAdmin en un solo helper.
  v_autorizado := public._teaches_course(NEW.course_id)
               OR public.is_admin_of_course_tenant(NEW.course_id);

  IF TG_OP = 'INSERT' THEN
    IF NEW.vocero_marcado_at IS NOT NULL AND NOT v_autorizado THEN
      NEW.vocero_marcado_at  := NULL;
      NEW.vocero_marcado_por := NULL;
    ELSIF NEW.vocero_marcado_at IS NOT NULL THEN
      NEW.vocero_marcado_por := auth.uid();   -- procedencia no falsificable
    END IF;
    RETURN NEW;
  END IF;

  IF NOT v_autorizado THEN
    NEW.vocero_marcado_at  := OLD.vocero_marcado_at;
    NEW.vocero_marcado_por := OLD.vocero_marcado_por;
    RETURN NEW;
  END IF;

  -- `por` es DERIVADO de `at`: no se acepta del payload.
  IF NEW.vocero_marcado_at IS DISTINCT FROM OLD.vocero_marcado_at THEN
    NEW.vocero_marcado_por :=
      CASE WHEN NEW.vocero_marcado_at IS NULL THEN NULL ELSE auth.uid() END;
  ELSE
    NEW.vocero_marcado_por := OLD.vocero_marcado_por;
  END IF;
  RETURN NEW;
END
$fn$;

DO $mig$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS tg_course_enrollments_guard_vocero
      ON public.course_enrollments;
    -- No choca con los dos triggers vivos: `trg_course_enrollments_tenant_check`
    -- es BEFORE INSERT OR UPDATE **OF user_id, course_id** (un UPDATE de solo
    -- estas columnas no lo dispara) y `trg_course_enrollment_welcome` es AFTER
    -- **INSERT** (marcar vocero NO re-manda el correo de bienvenida).
    CREATE TRIGGER tg_course_enrollments_guard_vocero
      BEFORE INSERT OR UPDATE ON public.course_enrollments
      FOR EACH ROW EXECUTE FUNCTION public.tg_course_enrollments_guard_vocero();
  END IF;
END $mig$;

-- ─── RPC: el swap atómico ───────────────────────────────────────────────
-- Existe por el índice parcial: "cambiar de vocero" tiene que ser UNA operación.
-- Si el cliente hiciera el UPDATE crudo para marcar a B mientras A sigue
-- marcado, PostgREST devolvería 23505.
-- `_user_id => NULL` = dejar el curso sin vocero.
CREATE OR REPLACE FUNCTION public.set_course_vocero(
  _course_id uuid,
  _user_id   uuid DEFAULT NULL
)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY INVOKER             -- ← A PROPÓSITO. No convertir a DEFINER: la RLS
  SET search_path TO 'public'  --   del caller ES la autorización (ver cabecera).
AS $fn$
DECLARE
  v_filas int;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Debes iniciar sesión para designar al vocero.';
  END IF;
  IF _course_id IS NULL THEN
    RAISE EXCEPTION 'Falta el curso.';
  END IF;
  -- REGLA UNIVERSAL de papelera: un curso eliminado no es usable en NINGÚN
  -- flujo. `course_enrollments` no tiene `deleted_at` ni mira `courses.deleted_at`,
  -- así que el guard va acá.
  IF public._course_in_papelera(_course_id) THEN
    RAISE EXCEPTION 'Ese curso está en la papelera. Restauralo antes de designar al vocero.';
  END IF;

  -- 1) Liberar la marca vigente (deja el índice parcial libre para el paso 2).
  UPDATE public.course_enrollments
     SET vocero_marcado_at = NULL, vocero_marcado_por = NULL
   WHERE course_id = _course_id
     AND vocero_marcado_at IS NOT NULL
     AND (_user_id IS NULL OR user_id <> _user_id);

  IF _user_id IS NULL THEN
    RETURN;
  END IF;

  -- 2) Marcar al nuevo. Con SECURITY INVOKER, un caller no autorizado no ve la
  --    fila (RLS) → 0 filas → el RAISE de abajo. La autorización es gratis.
  UPDATE public.course_enrollments
     SET vocero_marcado_at = now(), vocero_marcado_por = auth.uid()
   WHERE course_id = _course_id AND user_id = _user_id;

  GET DIAGNOSTICS v_filas = ROW_COUNT;
  IF v_filas = 0 THEN
    -- Mensaje que cubre honestamente los dos casos posibles (no matriculado /
    -- sin permiso) sin filtrar cuál fue.
    RAISE EXCEPTION 'No pudimos designar al vocero: verificá que el estudiante esté matriculado en el curso y que tengas permiso para gestionarlo.';
  END IF;
END
$fn$;

-- El `REVOKE ... FROM PUBLIC` NO saca a `anon` en este proyecto (Supabase otorga
-- EXECUTE por ALTER DEFAULT PRIVILEGES, así que la entrada de anon queda en el
-- ACL). Hay que nombrarlo.
REVOKE ALL ON FUNCTION public.set_course_vocero(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_course_vocero(uuid, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.set_course_vocero(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.set_course_vocero(uuid, uuid) IS
  'Designa (o quita, con _user_id NULL) al vocero de un curso — ETIQUETA INFORMATIVA, no otorga permisos. Swap atomico: libera la marca vigente y marca al nuevo. SECURITY INVOKER: autoriza la RLS de course_enrollments (docente del curso / Admin del tenant / SuperAdmin).';

-- ─── Que los COMPAÑEROS vean al vocero ──────────────────────────────────
-- Rama quirúrgica, agregada a lo que ya había. Solo la fila que ES la del
-- vocero, solo para quien está matriculado en ese curso, solo si el curso no
-- está en la papelera. El resto del roster sigue cerrado.
DO $mig$
BEGIN
  IF to_regclass('public.course_enrollments') IS NOT NULL THEN
    DROP POLICY IF EXISTS enrollments_select_in_tenant ON public.course_enrollments;
    CREATE POLICY enrollments_select_in_tenant ON public.course_enrollments
      FOR SELECT USING (
        (user_id = auth.uid())
        OR public.is_super_admin()
        OR (public.has_role(auth.uid(), 'Admin') AND public.course_in_my_tenant(course_id))
        OR public._teaches_course(course_id)
        -- El vocero es público PARA EL CURSO: su compañero necesita saber a
        -- quién dirigirse. `_is_enrolled_in_course` es SECURITY DEFINER, así que
        -- no re-entra a esta misma policy.
        OR (
          vocero_marcado_at IS NOT NULL
          AND public._is_enrolled_in_course(course_id)
          AND NOT public._course_in_papelera(course_id)
        )
      );
  END IF;
END $mig$;

NOTIFY pgrst, 'reload schema';

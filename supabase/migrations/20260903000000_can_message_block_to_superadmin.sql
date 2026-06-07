-- ──────────────────────────────────────────────────────────────────────
-- can_message: bloquear Docente/Estudiante → SuperAdmin.
--
-- Antes: `can_message` permitía cualquier user ↔ Admin global. Si un
-- SuperAdmin tenía ADEMÁS el rol Admin (caso típico en deploys que
-- usan SA como Admin del tenant principal), entonces Docentes y
-- Estudiantes podían iniciar chat con él. El SuperAdmin se llenaba de
-- mensajes operativos que NO le corresponden — debería recibir solo
-- comunicación de Admins de tenants (cuestiones cross-tenant), no de
-- usuarios finales del producto.
--
-- Después: si recipient ES SuperAdmin (sin importar otros roles),
-- el sender debe ser Admin o SuperAdmin. Resto de reglas iguales:
-- Admin ↔ cualquiera por curso, curso compartido, etc.
--
-- Aplica simétrico (chequeamos ambos lados): no importa quién inicia.
-- ──────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.can_message(_a UUID, _b UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    _a IS NOT NULL
    AND _b IS NOT NULL
    AND _a <> _b
    -- Gate SuperAdmin: si CUALQUIERA de los dos es SA, el otro debe ser
    -- Admin o SuperAdmin. Bloquea Docente/Estudiante → SA en ambos
    -- sentidos. El SuperAdmin que ADEMÁS sea Admin sigue protegido
    -- (queremos restringir SU buzón, no liberarlo).
    AND CASE
      WHEN public.has_role(_a, 'SuperAdmin'::public.app_role) THEN
        public.has_role(_b, 'Admin'::public.app_role)
        OR public.has_role(_b, 'SuperAdmin'::public.app_role)
      WHEN public.has_role(_b, 'SuperAdmin'::public.app_role) THEN
        public.has_role(_a, 'Admin'::public.app_role)
        OR public.has_role(_a, 'SuperAdmin'::public.app_role)
      ELSE
        -- Reglas originales: Admin global o curso compartido.
        public.has_role(_a, 'Admin'::public.app_role)
        OR public.has_role(_b, 'Admin'::public.app_role)
        OR EXISTS (
          SELECT 1
          FROM (
            SELECT course_id FROM public.course_teachers WHERE user_id = _a
            UNION
            SELECT course_id FROM public.course_enrollments WHERE user_id = _a
          ) a
          INNER JOIN (
            SELECT course_id FROM public.course_teachers WHERE user_id = _b
            UNION
            SELECT course_id FROM public.course_enrollments WHERE user_id = _b
          ) b ON a.course_id = b.course_id
        )
    END;
$$;

COMMENT ON FUNCTION public.can_message(UUID, UUID) IS
  'True si A y B pueden mensajearse. Reglas: si alguno es SuperAdmin, el otro debe ser Admin/SuperAdmin (bloquea ruido de Docente/Estudiante en el buzón del SA). Resto: Admin global o curso compartido.';

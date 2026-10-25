-- ═══════════════════════════════════════════════════════════════════════
-- Asistente IA (Tutor IA): contador PERSISTENTE del uso diario
-- ═══════════════════════════════════════════════════════════════════════
--
-- Reemplaza el conteo por mensajes (mig 20262890000000) por un contador que NO
-- se borra al limpiar la conversación. Contar los mensajes de tutor_chat_messages
-- dejaba un hueco: «Limpiar conversación» los borra y el conteo del día volvía a
-- 0, anulando el límite con un clic.
--
-- `tutor_uso_diario(user_id, course_id, dia)` lleva cuántas preguntas hizo el
-- estudiante en ese curso ese día calendario de Bogotá. El edge lo incrementa
-- ATÓMICAMENTE con `tutor_consumir_pregunta` ANTES de llamar a la IA (upsert +
-- incremento condicionado al límite) — eso cierra también la carrera de dos
-- envíos simultáneos. Si la llamada a la IA falla después, el edge devuelve la
-- pregunta con `tutor_devolver_pregunta` para no cobrar un error.
--
-- RLS: el estudiante SOLO LEE sus propias filas (para mostrar el restante). No
-- hay INSERT/UPDATE/DELETE por RLS — la tabla la escribe el edge con service_role
-- (bypassa RLS) vía las funciones SECURITY DEFINER, revocadas de anon/authenticated.
--
-- Defensiva: todo dentro de guards por si las tablas no existen en el entorno.

DO $$
BEGIN
  IF to_regclass('public.courses') IS NULL OR to_regclass('public.tenants') IS NULL THEN
    RAISE NOTICE 'courses/tenants no existen; se omite tutor_uso_diario';
    RETURN;
  END IF;

  IF to_regclass('public.tutor_uso_diario') IS NULL THEN
    CREATE TABLE public.tutor_uso_diario (
      user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      course_id  UUID NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
      dia        DATE NOT NULL,
      tenant_id  UUID REFERENCES public.tenants(id) ON DELETE CASCADE,
      preguntas  INT NOT NULL DEFAULT 0 CHECK (preguntas >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, course_id, dia)
    );
    -- Lectura por tenant del estudiante (la RLS filtra por user_id + tenant).
    CREATE INDEX idx_tutor_uso_diario_tenant ON public.tutor_uso_diario(tenant_id);
  END IF;

  ALTER TABLE public.tutor_uso_diario ENABLE ROW LEVEL SECURITY;

  -- Estudiante: SOLO lee sus filas de su tenant. Sin políticas de escritura
  -- (authenticated no puede escribir; el edge usa service_role, que bypassa RLS).
  DROP POLICY IF EXISTS tutor_uso_diario_select ON public.tutor_uso_diario;
  CREATE POLICY tutor_uso_diario_select
    ON public.tutor_uso_diario FOR SELECT TO authenticated
    USING (user_id = auth.uid() AND tenant_id = public.current_tenant_id());

  COMMENT ON TABLE public.tutor_uso_diario IS
    'Contador persistente de preguntas al Tutor IA por estudiante, curso y día (Bogotá). Lo escribe el edge con service_role; el estudiante solo lee sus filas.';
END $$;

-- ── Consumir una pregunta: incremento ATÓMICO condicionado al límite ──
-- Devuelve (paso, usadas): paso=true si se pudo incrementar (quedaba cupo),
-- usadas = cuántas lleva hoy. El upsert con WHERE en el DO UPDATE hace que dos
-- envíos simultáneos no puedan pasarse del tope (la carrera la resuelve Postgres).
CREATE OR REPLACE FUNCTION public.tutor_consumir_pregunta(
  _user UUID, _course UUID, _limite INT
)
RETURNS TABLE(paso BOOLEAN, usadas INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dia DATE := (now() AT TIME ZONE 'America/Bogota')::date;
  v_tenant UUID;
  v_pregs INT;
BEGIN
  IF _limite < 1 THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  SELECT tenant_id INTO v_tenant FROM public.courses WHERE id = _course;

  INSERT INTO public.tutor_uso_diario (user_id, course_id, dia, tenant_id, preguntas)
  VALUES (_user, _course, v_dia, v_tenant, 1)
  ON CONFLICT (user_id, course_id, dia)
  DO UPDATE SET preguntas = public.tutor_uso_diario.preguntas + 1, updated_at = now()
  WHERE public.tutor_uso_diario.preguntas < _limite
  RETURNING preguntas INTO v_pregs;

  IF v_pregs IS NOT NULL THEN
    RETURN QUERY SELECT true, v_pregs;
    RETURN;
  END IF;

  -- No se incrementó: la fila existía y ya estaba en el tope.
  SELECT preguntas INTO v_pregs
    FROM public.tutor_uso_diario
   WHERE user_id = _user AND course_id = _course AND dia = v_dia;
  RETURN QUERY SELECT false, COALESCE(v_pregs, _limite);
END $$;

-- ── Devolver una pregunta (la IA falló): decremento best-effort ──
CREATE OR REPLACE FUNCTION public.tutor_devolver_pregunta(
  _user UUID, _course UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_dia DATE := (now() AT TIME ZONE 'America/Bogota')::date;
BEGIN
  UPDATE public.tutor_uso_diario
     SET preguntas = GREATEST(0, preguntas - 1), updated_at = now()
   WHERE user_id = _user AND course_id = _course AND dia = v_dia;
END $$;

-- Solo el service_role (el edge) ejecuta estas funciones. El estudiante NO.
REVOKE ALL ON FUNCTION public.tutor_consumir_pregunta(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tutor_devolver_pregunta(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tutor_consumir_pregunta(UUID, UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.tutor_devolver_pregunta(UUID, UUID) TO service_role;

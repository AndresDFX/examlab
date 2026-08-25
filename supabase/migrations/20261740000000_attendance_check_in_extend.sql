-- ══════════════════════════════════════════════════════════════════════
-- Darle MÁS TIEMPO a un check-in de asistencia que ya está abierto, sin
-- invalidar el QR que está proyectado.
--
-- ── El problema ───────────────────────────────────────────────────────
-- El docente abre el check-in con una ventana (10 minutos por defecto) y lo
-- proyecta. Cuando se queda corta —llegó un grupo tarde, la fila del salón
-- avanza lento, alguien no tenía la app— no había forma de estirarla: la única
-- salida era volver a abrirlo, y `teacher_open_attendance_check_in` hace UPSERT
-- **regenerando la semilla**. Eso cambia TODOS los códigos: el QR proyectado y
-- el que los alumnos tienen a medio escanear dejan de servir en el mismo
-- instante, y los que estaban tecleando el código de 6 dígitos reciben un
-- rechazo sin entender por qué. Estirar la ventana pasaba a costar más caos que
-- el que resolvía.
--
-- ── Lo que esta función NO toca, a propósito ──────────────────────────
-- `seed`, `rotation_seconds` y `opened_at` quedan intactos. Ese es el punto
-- entero: el QR de la pantalla sigue siendo válido, la rotación sigue su ritmo
-- y quien esté escaneando en ese segundo no se entera de nada. Lo único que se
-- mueve es `closes_at`.
--
-- ── Alcance (y una diferencia con la función de abrir) ────────────────
-- `teacher_open_attendance_check_in` valida solo `has_role(Docente|Admin)`, sin
-- acotar por institución — el anti-patrón que CLAUDE.md documenta: como los
-- roles son GLOBALES, un docente de CUALQUIER institución pasa esa validación.
-- No se corrige acá para no cambiar el comportamiento de una función que ya
-- está en producción con otro alcance, pero la NUEVA sí se acota con
-- `attendance_session_in_my_tenant`, que es la regla vigente para todo lo que
-- se agregue. Queda anotado como deuda de la función de abrir.
-- ══════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF to_regclass('public.attendance_check_in_state') IS NULL THEN
    RAISE NOTICE 'attendance_check_in_state ausente — se omite la extensión de check-in';
    RETURN;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.teacher_extend_attendance_check_in(
  p_session_id uuid,
  p_extra_minutes int DEFAULT 5
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_state public.attendance_check_in_state%ROWTYPE;
  v_base timestamptz;
  v_nuevo timestamptz;
  v_tope timestamptz;
BEGIN
  -- Los guards van en el CUERPO, en orden: el GRANT no es la frontera. Supabase
  -- otorga EXECUTE a `anon` por ALTER DEFAULT PRIVILEGES, así que abajo se
  -- revoca explícito, pero lo que de verdad frena a un anónimo es este RAISE.
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_auth');
  END IF;
  IF NOT (public.has_role(v_uid, 'Admin') OR public.has_role(v_uid, 'Docente')) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;
  IF NOT public.attendance_session_in_my_tenant(p_session_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unauthorized');
  END IF;

  -- 1..60 por llamada: el botón ofrece +5/+10/+15. Un tope por llamada evita
  -- que un typo de tres dígitos deje el check-in abierto toda la tarde.
  IF p_extra_minutes < 1 OR p_extra_minutes > 60 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_extra');
  END IF;

  SELECT * INTO v_state
    FROM public.attendance_check_in_state
   WHERE session_id = p_session_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_open');
  END IF;

  -- Si la ventana YA venció, se extiende desde ahora y no desde el vencimiento:
  -- sumarle 5 minutos a algo que expiró hace 20 daría una ventana que nace
  -- cerrada, y el docente vería el botón "no hacer nada".
  v_base := GREATEST(now(), v_state.closes_at);
  v_nuevo := v_base + (p_extra_minutes || ' minutes')::interval;

  -- Mismo techo total que al abrir (240 min desde que se abrió), para que
  -- extender no sea una forma de saltarse el límite de la otra función.
  v_tope := v_state.opened_at + interval '240 minutes';
  IF v_nuevo > v_tope THEN
    IF v_state.closes_at >= v_tope THEN
      RETURN jsonb_build_object('ok', false, 'error', 'max_window');
    END IF;
    v_nuevo := v_tope;
  END IF;

  -- OJO: solo `closes_at`. Tocar `seed` acá reintroduciría exactamente el bug
  -- que esta función existe para evitar.
  UPDATE public.attendance_check_in_state
     SET closes_at = v_nuevo
   WHERE session_id = p_session_id;

  -- Si había expirado, la sesión pudo quedar con check_in_open=false; se
  -- reabre para que el alumno pueda volver a marcar.
  UPDATE public.attendance_sessions
     SET check_in_open = true
   WHERE id = p_session_id;

  RETURN jsonb_build_object(
    'ok', true,
    'closes_at', v_nuevo,
    'added_minutes', EXTRACT(EPOCH FROM (v_nuevo - v_base)) / 60
  );
END;
$$;

REVOKE ALL ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) FROM anon;
GRANT EXECUTE ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) TO authenticated;

COMMENT ON FUNCTION public.teacher_extend_attendance_check_in(uuid, int) IS
  'Extiende closes_at de un check-in abierto SIN regenerar la semilla: el QR proyectado sigue siendo válido. Acotada al tenant de la sesión.';

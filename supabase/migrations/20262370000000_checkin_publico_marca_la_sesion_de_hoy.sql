-- ═══════════════════════════════════════════════════════════════════════
-- La lista pública marca CUÁL es la clase de hoy
-- ═══════════════════════════════════════════════════════════════════════
-- La lista de sesiones que cubre el código ya sale, pero la sesión desde la que
-- se abrió aparecía dos veces —arriba como encabezado y otra vez dentro de la
-- lista— y sin nada que la distinguiera de las que se están recuperando. Con el
-- encabezado unificado en la lista hace falta saber cuál es, y esa decisión es
-- del servidor.
--
-- Va en una migración NUEVA y no editando `20262350000000`: esa ya figura como
-- aplicada, así que un cambio dentro de su archivo no volvería a correr y el
-- despliegue saldría verde igual — el modo de falla que el propio CLAUDE.md
-- documenta.
--
-- Todo lo demás del cuerpo queda idéntico; se reproduce entero porque la
-- función se reemplaza completa.
CREATE OR REPLACE FUNCTION public.attendance_check_in_public_info(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_r        record;
  v_abierto  boolean := false;
  v_grupo    uuid;
  v_sesiones jsonb := '[]'::jsonb;
BEGIN
  SELECT s.title, s.session_date, s.session_type, c.name AS curso, c.grupo,
         st.email_only, st.opened_at, st.closes_at, s.check_in_open,
         s.deleted_at AS s_del, c.deleted_at AS c_del, st.group_id
    INTO v_r
    FROM public.attendance_sessions s
    JOIN public.courses c ON c.id = s.course_id
    LEFT JOIN public.attendance_check_in_state st ON st.session_id = s.id
   WHERE s.id = p_session_id;

  -- Un id inexistente, de otra institución, en papelera o con el check-in
  -- cerrado devuelven TODOS lo mismo. Sin esto la función sería un oráculo:
  -- probando ids se podría averiguar cuáles existen.
  IF NOT FOUND THEN
    RETURN jsonb_build_object('open', false, 'email_only', false);
  END IF;

  v_abierto := COALESCE(v_r.check_in_open, false)
    AND v_r.s_del IS NULL
    AND v_r.c_del IS NULL
    AND v_r.opened_at IS NOT NULL
    AND v_r.closes_at IS NOT NULL
    AND now() >= v_r.opened_at
    AND now() <= v_r.closes_at;

  IF NOT v_abierto THEN
    -- `not_started` se distingue de "cerrado" SOLO cuando la ventana existe y
    -- todavía no empezó: al estudiante que llegó temprano hay que decirle a qué
    -- hora vuelva, no "está cerrado". No se filtra nada más.
    IF v_r.s_del IS NULL AND v_r.c_del IS NULL AND v_r.opened_at IS NOT NULL
       AND now() < v_r.opened_at THEN
      RETURN jsonb_build_object(
        'open', false, 'email_only', COALESCE(v_r.email_only, false),
        'not_started', true, 'opens_at', v_r.opened_at
      );
    END IF;
    RETURN jsonb_build_object('open', false, 'email_only', false);
  END IF;

  -- Las demás sesiones que este mismo código cubre. Se aplican los mismos
  -- candados que a la ancla (abierta, en ventana, fuera de papelera) para no
  -- anunciar una clase que en realidad no se va a poder marcar.
  v_grupo := v_r.group_id;
  IF v_grupo IS NOT NULL THEN
    SELECT COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'title', s2.title,
                 'session_date', s2.session_date,
                 -- Cuál de todas es la clase DESDE LA QUE se abrió el código, o
                 -- sea la de hoy. Lo decide el servidor: hacerlo en el cliente
                 -- comparando título y fecha fallaría con dos sesiones que los
                 -- compartan, y devolver los ids de las hermanas le daría a una
                 -- pantalla pública más superficie de la que necesita.
                 'is_anchor', s2.id = p_session_id
               )
               ORDER BY s2.session_date, s2.title
             ),
             '[]'::jsonb)
      INTO v_sesiones
      FROM public.attendance_check_in_state st2
      JOIN public.attendance_sessions s2 ON s2.id = st2.session_id
      JOIN public.courses c2 ON c2.id = s2.course_id
     WHERE st2.group_id = v_grupo
       AND s2.check_in_open IS TRUE
       AND s2.deleted_at IS NULL
       AND c2.deleted_at IS NULL
       AND st2.opened_at IS NOT NULL
       AND st2.closes_at IS NOT NULL
       AND now() BETWEEN st2.opened_at AND st2.closes_at;
  END IF;

  -- Abierto de verdad: recién acá se dice de qué es. Nombre del curso, título y
  -- fecha de la sesión. Nada de la institución, nada de ningún alumno.
  RETURN jsonb_build_object(
    'open', true,
    'email_only', COALESCE(v_r.email_only, false),
    'course_name', v_r.curso,
    'course_group', v_r.grupo,
    'session_title', v_r.title,
    'session_date', v_r.session_date,
    'session_type', v_r.session_type,
    'closes_at', v_r.closes_at,
    -- Vacío cuando el check-in es de UNA sesión: la pantalla no muestra la
    -- lista y se ve exactamente como antes.
    'group_sessions', v_sesiones
  );
END;
$$;

REVOKE ALL ON FUNCTION public.attendance_check_in_public_info(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.attendance_check_in_public_info(uuid) TO anon, authenticated;

COMMENT ON FUNCTION public.attendance_check_in_public_info(uuid) IS
  'Contexto minimo para la pagina publica de asistencia: si esta abierto, si pide solo correo, de que curso y sesion es, y —cuando el check-in cubre varias sesiones— cuales son. Solo con el check-in efectivamente abierto (flag + ventana + papelera de sesion y de curso). Un id inexistente, ajeno, en papelera o cerrado devuelven lo mismo.';

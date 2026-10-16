-- ══════════════════════════════════════════════════════════════════════
-- Grupos que arman los propios estudiantes (talleres y proyectos)
--
-- Hasta acá los grupos de una entrega los armaba SOLO el docente (el editor de
-- arrastrar y soltar). Con un curso de 35 y un proyecto por equipos, eso es
-- trabajo del docente que los estudiantes pueden hacer solos, y mientras no lo
-- hace nadie, el estudiante ve «no tengo grupo» y no sabe qué hacer.
--
-- Qué agrega:
--   * `students_form_groups` en `projects` y `workshops`: el docente decide
--     QUIÉN arma los grupos. Es ortogonal al modo de trabajo (`group_mode`):
--     grupal estricto (`group_required`) o mixto (`teacher_assigned`) siguen
--     significando lo mismo; esto solo cambia quién forma los grupos.
--     `self_signup` (el valor viejo del CHECK, nunca expuesto) NO se usa: un
--     valor de `group_mode` no podría expresar «estricto Y los arman ellos».
--   * Cinco RPC para el estudiante: el resumen de sus grupos (para las
--     tarjetas), el estado detallado de uno (para la ventana), crear un grupo
--     eligiendo compañeros, agregar compañeros y salirse.
--
-- Las reglas viven ACÁ y no en la pantalla, porque las tablas de grupos solo
-- las escribe el staff (RLS `*_group*_staff_manage`) y este es el único camino
-- del estudiante:
--   1. Una persona, un grupo por actividad (ya lo garantizaba el trigger
--      `assert_one_*_group_per_user`; acá además se pre-chequea para dar el
--      nombre de quién ya tiene grupo).
--   2. Solo compañeros de SU curso (un curso de la actividad en el que estén
--      matriculados los dos), con la actividad asignada, y que no la dicten:
--      el dueño de UNIAJ está matriculado como estudiante en todos sus cursos.
--   3. Tope `group_size_max` siempre; `group_size_min` al CREAR (un grupo de
--      uno es una entrega individual con otro nombre). Salirse puede dejar al
--      grupo por debajo del mínimo: la pantalla lo avisa, no lo impide.
--   4. Mientras la actividad esté publicada y en plazo, y el grupo NO haya
--      entregado: la entrega y la nota son del grupo, así que sumar a alguien
--      después de entregar le regalaría la nota, y salirse se llevaría la
--      nota de alguien que sí trabajó. Después de entregar, solo el docente.
--   5. Modo mixto e individual: quien ya ENTREGÓ de forma individual no entra
--      a un grupo (mismo motivo que el trigger de la mig 20261068000000). Si
--      solo tiene un borrador individual sin entregar y CREA un grupo, ese
--      borrador pasa a ser el del grupo (no se pierde trabajo); a un compañero
--      con borrador individual no se lo puede sumar, porque su borrador y el
--      del grupo no se pueden combinar sin descartar uno.
--   6. Salirse: si quien se va era el «último editor» de la entrega del grupo
--      (`user_id`), la fila pasa a otro integrante — si no, el que se fue
--      seguiría editándola (la RLS de la entrega lo deja por ser `user_id`).
--      Si era el último integrante, el grupo se borra y su borrador vuelve a
--      ser individual de quien se fue.
--
--   7. Sumar a alguien es unilateral (así lo pidió el docente: «seleccionar a
--      otros estudiantes»), así que el agregado RECIBE UN AVISO (campanita, kind
--      `group_membership`, sin correo; el panel de avisos lo puede apagar) y
--      cada alta, agregado y salida queda en la bitácora (`log_audit_event`):
--      si alguien reclama que lo metieron en un grupo, el docente ve quién fue
--      y lo corrige desde «Grupos».
--
-- EXCEPCIÓN deliberada al roster cerrado: las migs 20261071000000 y
-- 20261880000000 le quitaron al estudiante la lista de matriculados de su curso.
-- `grupo_estudiante_estado` le devuelve sus compañeros, pero acotado: solo
-- cuando el docente dejó que los estudiantes armen los grupos, la actividad
-- está abierta y él puede cambiar su grupo, y solo compañeros de un curso en
-- común que tengan la actividad asignada. Por compañero va el nombre (ya
-- visible por `profiles_select_same_tenant`), el grupo en que está (los grupos
-- ya son legibles en la institución) y si trabaja por su cuenta, SIN decir si
-- entregó o solo empezó: eso sería mostrar el avance de otro.
--
-- Concurrencia: cada cambio toma un advisory lock por actividad, así dos
-- estudiantes que suman a la misma persona a la vez no la dejan en dos grupos
-- ni pasan el tope entre los dos.
--
-- Defensiva: guardas `to_regclass`, idempotente. Sin NOTIFY pgrst (lo hace el
-- event trigger de Supabase).
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Quién arma los grupos ─────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.projects') IS NOT NULL THEN
    ALTER TABLE public.projects
      ADD COLUMN IF NOT EXISTS students_form_groups boolean NOT NULL DEFAULT false;
  END IF;
  IF to_regclass('public.workshops') IS NOT NULL THEN
    ALTER TABLE public.workshops
      ADD COLUMN IF NOT EXISTS students_form_groups boolean NOT NULL DEFAULT false;
  END IF;
END $$;

-- ── 2) Tablas por tipo de actividad ──────────────────────────────────
-- El `_tipo` del cliente NUNCA llega a un identificador sin pasar por este
-- mapa fijo: las funciones de abajo arman SQL dinámico solo con estos nombres.
CREATE OR REPLACE FUNCTION public._grupo_est_tablas(_tipo text)
RETURNS TABLE(act text, fk text, grp text, mem text, sub text, asg text, cur text)
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT v.act, v.fk, v.grp, v.mem, v.sub, v.asg, v.cur
  FROM (VALUES
    ('proyecto', 'projects',  'project_id',  'project_groups',  'project_group_members',
     'project_submissions',  'project_assignments',  'project_courses'),
    ('taller',   'workshops', 'workshop_id', 'workshop_groups', 'workshop_group_members',
     'workshop_submissions', 'workshop_assignments', 'workshop_courses')
  ) AS v(tipo, act, fk, grp, mem, sub, asg, cur)
  WHERE v.tipo = _tipo;
$fn$;

-- ── 3) La situación de un estudiante frente a una actividad ──────────
-- No lanza (salvo tipo inválido): la usan tanto el resumen —que no debe
-- romper por una actividad ajena— como las RPC que cambian algo, que deciden
-- qué error dar a partir de lo que devuelve.
--
--   motivo (NULL = puede armar/cambiar su grupo ahora):
--     no_encontrada · no_asignada · no_publicada · externa · individual ·
--     los_arma_el_docente · plazo_vencido · grupo_entregado
CREATE OR REPLACE FUNCTION public._grupo_est_situacion(_tipo text, _actividad uuid, _uid uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE
  t record;
  v_course uuid;
  v_status text;
  v_deleted timestamptz;
  v_externa boolean;
  v_modo text;
  v_arman boolean;
  v_min int;
  v_max int;
  v_due timestamptz;
  v_cursos uuid[];
  v_mis uuid[];
  v_asignado boolean;
  v_gid uuid;
  v_gname text;
  v_gcount int;
  v_sid uuid;
  v_suid uuid;
  v_sstatus text;
  v_gentregado boolean := false;
  v_iid uuid;
  v_istatus text;
  v_motivo text;
BEGIN
  SELECT * INTO t FROM public._grupo_est_tablas(_tipo);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tipo de actividad no válido: %', _tipo USING ERRCODE = 'P0001';
  END IF;

  EXECUTE format(
    'SELECT a.course_id, a.status, a.deleted_at, COALESCE(a.is_external, false), a.group_mode,
            COALESCE(a.students_form_groups, false), a.group_size_min, a.group_size_max, a.due_date
       FROM public.%I a WHERE a.id = $1', t.act)
    INTO v_course, v_status, v_deleted, v_externa, v_modo, v_arman, v_min, v_max, v_due
    USING _actividad;

  -- Con el curso ancla en la papelera la actividad no se ve (RLS
  -- `*_select_in_tenant`), aunque esté compartida con otro curso vivo.
  IF v_status IS NULL OR v_deleted IS NOT NULL OR public._course_in_papelera(v_course) THEN
    RETURN jsonb_build_object('motivo', 'no_encontrada', 'elegible', false);
  END IF;

  v_min := GREATEST(COALESCE(v_min, 2), 1);
  v_max := GREATEST(COALESCE(v_max, 5), v_min);

  -- Cursos de la actividad: el ancla + los de la tabla de unión, sin papelera.
  EXECUTE format(
    'SELECT COALESCE(array_agg(DISTINCT c.id), ''{}''::uuid[])
       FROM public.courses c
      WHERE c.deleted_at IS NULL
        AND (c.id = $2 OR c.id IN (SELECT j.course_id FROM public.%I j WHERE j.%I = $1))',
    t.cur, t.fk)
    INTO v_cursos USING _actividad, v_course;

  SELECT COALESCE(array_agg(DISTINCT e.course_id), '{}'::uuid[])
    INTO v_mis
    FROM public.course_enrollments e
   WHERE e.user_id = _uid AND e.course_id = ANY (v_cursos);

  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I x WHERE x.%I = $1 AND x.user_id = $2)',
                 t.asg, t.fk)
    INTO v_asignado USING _actividad, _uid;

  IF NOT v_asignado OR cardinality(v_mis) = 0 THEN
    RETURN jsonb_build_object('motivo', 'no_asignada', 'elegible', false);
  END IF;

  -- Su grupo (a lo sumo uno: lo garantiza el trigger de membresía).
  EXECUTE format(
    'SELECT g.id, g.name FROM public.%I g JOIN public.%I m ON m.group_id = g.id
      WHERE g.%I = $1 AND m.user_id = $2 LIMIT 1', t.grp, t.mem, t.fk)
    INTO v_gid, v_gname USING _actividad, _uid;

  IF v_gid IS NOT NULL THEN
    EXECUTE format('SELECT count(*) FROM public.%I m WHERE m.group_id = $1', t.mem)
      INTO v_gcount USING v_gid;
    EXECUTE format(
      'SELECT s.id, s.user_id, s.status FROM public.%I s WHERE s.%I = $1 AND s.group_id = $2 LIMIT 1',
      t.sub, t.fk)
      INTO v_sid, v_suid, v_sstatus USING _actividad, v_gid;
    v_gentregado := v_sid IS NOT NULL AND public.estado_es_entrega(v_sstatus);
  END IF;

  -- Su entrega individual (fila sin grupo), si existe.
  EXECUTE format(
    'SELECT s.id, s.status FROM public.%I s WHERE s.%I = $1 AND s.user_id = $2 AND s.group_id IS NULL LIMIT 1',
    t.sub, t.fk)
    INTO v_iid, v_istatus USING _actividad, _uid;

  v_motivo := CASE
    WHEN v_status <> 'published' THEN 'no_publicada'
    WHEN v_externa THEN 'externa'
    WHEN v_modo NOT IN ('group_required', 'teacher_assigned') THEN 'individual'
    WHEN NOT v_arman THEN 'los_arma_el_docente'
    WHEN v_due IS NOT NULL AND v_due <= now() THEN 'plazo_vencido'
    WHEN v_gentregado THEN 'grupo_entregado'
    ELSE NULL
  END;

  RETURN jsonb_build_object(
    'elegible', true,
    'motivo', v_motivo,
    'curso', v_course,
    'modo', v_modo,
    'arman_estudiantes', v_arman,
    'externa', v_externa,
    'minimo', v_min,
    'maximo', v_max,
    'cursos', to_jsonb(v_cursos),
    'mis_cursos', to_jsonb(v_mis),
    'grupo', CASE WHEN v_gid IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_gid,
      'nombre', v_gname,
      'integrantes', v_gcount,
      'entregado', v_gentregado,
      'entrega_id', v_sid,
      'entrega_user_id', v_suid
    ) END,
    'individual', CASE WHEN v_iid IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_iid,
      'entregada', public.estado_es_entrega(v_istatus)
    ) END
  );
END
$fn$;

-- ── 4) ¿Se puede sumar a este compañero? (NULL = sí; si no, el motivo) ──
CREATE OR REPLACE FUNCTION public._grupo_est_validar_companero(
  _tipo text, _actividad uuid, _cursos uuid[], _mis_cursos uuid[], _companero uuid
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $fn$
DECLARE
  t record;
  v_nombre text;
  v_activo boolean;
  v_ok boolean;
  v_gname text;
  v_iexiste boolean;
BEGIN
  SELECT * INTO t FROM public._grupo_est_tablas(_tipo);

  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.institutional_email, 'Un compañero'),
         p.deleted_at IS NULL AND COALESCE(p.is_active, true)
    INTO v_nombre, v_activo FROM public.profiles p WHERE p.id = _companero;
  IF v_nombre IS NULL THEN
    RETURN 'Uno de los compañeros elegidos no existe.';
  END IF;
  -- Una cuenta desactivada o eliminada no cuenta para el grupo (el editor del
  -- docente ya la excluye): con ella, un grupo estricto llegaría al mínimo con
  -- alguien que no va a trabajar.
  IF NOT v_activo THEN
    RETURN format('%s no tiene la cuenta activa.', v_nombre);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.course_enrollments e
     WHERE e.user_id = _companero AND e.course_id = ANY (_mis_cursos)
  ) THEN
    RETURN format('%s no está en tu curso.', v_nombre);
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.course_teachers ct
     WHERE ct.user_id = _companero AND ct.course_id = ANY (_cursos)
  ) THEN
    RETURN format('%s dicta el curso; no se puede sumar a un grupo.', v_nombre);
  END IF;

  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I x WHERE x.%I = $1 AND x.user_id = $2)',
                 t.asg, t.fk)
    INTO v_ok USING _actividad, _companero;
  IF NOT v_ok THEN
    RETURN format('%s no tiene asignada esta actividad.', v_nombre);
  END IF;

  EXECUTE format(
    'SELECT g.name FROM public.%I g JOIN public.%I m ON m.group_id = g.id
      WHERE g.%I = $1 AND m.user_id = $2 LIMIT 1', t.grp, t.mem, t.fk)
    INTO v_gname USING _actividad, _companero;
  IF v_gname IS NOT NULL THEN
    RETURN format('%s ya está en el grupo «%s».', v_nombre, v_gname);
  END IF;

  -- Entregó o empezó por su cuenta: no se dice cuál de las dos (sería mostrar
  -- el avance de otro); para el que arma el grupo da lo mismo.
  EXECUTE format(
    'SELECT true FROM public.%I s WHERE s.%I = $1 AND s.user_id = $2 AND s.group_id IS NULL LIMIT 1',
    t.sub, t.fk)
    INTO v_iexiste USING _actividad, _companero;
  IF COALESCE(v_iexiste, false) THEN
    RETURN format('%s ya trabaja por su cuenta en esta actividad, así que no se puede sumar a un grupo.', v_nombre);
  END IF;

  RETURN NULL;
END
$fn$;

-- Texto del motivo para los errores de las RPC (el cliente traduce los códigos
-- por su cuenta; esto es lo que ve quien llama por REST o si falla la pantalla).
CREATE OR REPLACE FUNCTION public._grupo_est_motivo_texto(_motivo text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $fn$
  SELECT CASE _motivo
    WHEN 'no_encontrada' THEN 'No se encontró la actividad.'
    WHEN 'no_asignada' THEN 'No tienes asignada esta actividad.'
    WHEN 'no_publicada' THEN 'La actividad no está abierta.'
    WHEN 'externa' THEN 'Los grupos de esta actividad los arma el docente.'
    WHEN 'individual' THEN 'Esta actividad es individual.'
    WHEN 'los_arma_el_docente' THEN 'Los grupos de esta actividad los arma el docente.'
    WHEN 'plazo_vencido' THEN 'El plazo de la actividad ya terminó; los grupos ya no cambian.'
    WHEN 'grupo_entregado' THEN 'Tu grupo ya entregó; ya no se puede cambiar. Si hace falta, pídeselo al docente.'
    ELSE 'No se puede cambiar el grupo ahora.'
  END;
$fn$;

-- Bitácora de cada cambio y aviso a quien sumaron (lo metió otro: ver la regla
-- 7 del encabezado). Ninguna de las dos cosas puede tumbar el cambio de grupo:
-- `log_audit_event` no lanza y el aviso va en su propio bloque.
CREATE OR REPLACE FUNCTION public._grupo_est_avisar(
  _tipo text, _actividad uuid, _grupo uuid, _grupo_nombre text, _curso uuid,
  _accion text, _quien uuid, _agregados uuid[]
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  t record;
  v_titulo text;
  v_quien text;
  v_link text;
BEGIN
  SELECT * INTO t FROM public._grupo_est_tablas(_tipo);
  EXECUTE format('SELECT a.title FROM public.%I a WHERE a.id = $1', t.act)
    INTO v_titulo USING _actividad;
  SELECT COALESCE(NULLIF(btrim(p.full_name), ''), p.institutional_email, 'Un compañero')
    INTO v_quien FROM public.profiles p WHERE p.id = _quien;
  v_link := CASE _tipo WHEN 'proyecto' THEN '/app/student/projects' ELSE '/app/student/workshops' END;

  PERFORM public.log_audit_event(
    'group.student_' || _accion,
    CASE _tipo WHEN 'proyecto' THEN 'project' ELSE 'workshop' END,
    'info',
    CASE _tipo WHEN 'proyecto' THEN 'project_group' ELSE 'workshop_group' END,
    _grupo::text,
    _grupo_nombre,
    _curso,
    NULL::text,
    jsonb_build_object(
      'actividad_id', _actividad,
      'actividad', v_titulo,
      'agregados', to_jsonb(COALESCE(_agregados, '{}'::uuid[]))
    )
  );

  IF cardinality(COALESCE(_agregados, '{}'::uuid[])) > 0 THEN
    BEGIN
      -- Sin `source_role`: la campanita oculta los avisos cuyo origen es el
      -- mismo rol de quien mira, y acá un estudiante le avisa a otro.
      INSERT INTO public.notifications (user_id, title, body, kind, link)
      SELECT a,
             '👥 Te agregaron a un grupo',
             format('%s te agregó al grupo «%s» en «%s». Si no es tu grupo, puedes salirte desde la actividad mientras el grupo no haya entregado.',
                    v_quien, _grupo_nombre, v_titulo),
             'group_membership',
             v_link
        FROM unnest(_agregados) a;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END IF;
END
$fn$;

-- ── 5) Resumen para las tarjetas de la lista ─────────────────────────
-- Un objeto por actividad grupal asignada al estudiante:
--   { "<id>": { motivo, modo, arman_estudiantes, minimo, maximo,
--               grupo: {id, nombre, integrantes, entregado} | null,
--               individual: {entregada} | null } }
-- Las actividades individuales o ajenas no aparecen.
CREATE OR REPLACE FUNCTION public.grupos_estudiante_resumen(_tipo text, _actividades uuid[])
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid;
  s jsonb;
  v_out jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  IF _actividades IS NULL OR cardinality(_actividades) = 0 THEN
    RETURN v_out;
  END IF;
  IF cardinality(_actividades) > 200 THEN
    RAISE EXCEPTION 'Demasiadas actividades en una consulta' USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_id IN ARRAY _actividades LOOP
    s := public._grupo_est_situacion(_tipo, v_id, v_uid);
    CONTINUE WHEN NOT COALESCE((s->>'elegible')::boolean, false);
    CONTINUE WHEN s->>'modo' IS NULL OR s->>'modo' = 'individual';
    v_out := v_out || jsonb_build_object(v_id::text, jsonb_build_object(
      'motivo', s->'motivo',
      'modo', s->'modo',
      'arman_estudiantes', s->'arman_estudiantes',
      'externa', s->'externa',
      'minimo', s->'minimo',
      'maximo', s->'maximo',
      'grupo', CASE WHEN s->'grupo' = 'null'::jsonb THEN NULL ELSE jsonb_build_object(
        'id', s->'grupo'->'id',
        'nombre', s->'grupo'->'nombre',
        'integrantes', s->'grupo'->'integrantes',
        'entregado', s->'grupo'->'entregado'
      ) END,
      'individual', CASE WHEN s->'individual' = 'null'::jsonb THEN NULL ELSE jsonb_build_object(
        'entregada', s->'individual'->'entregada'
      ) END
    ));
  END LOOP;
  RETURN v_out;
END
$fn$;

-- ── 6) Estado detallado de una actividad (la ventana «Mi grupo») ─────
-- Lo del resumen + los nombres de los integrantes + los compañeros del curso
-- con su disponibilidad (solo si el estudiante puede armar/cambiar su grupo:
-- si no, no tiene para qué ver la lista).
CREATE OR REPLACE FUNCTION public.grupo_estudiante_estado(_tipo text, _actividad uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  t record;
  s jsonb;
  v_cursos uuid[];
  v_mis uuid[];
  v_integrantes jsonb := '[]'::jsonb;
  v_companeros jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;

  s := public._grupo_est_situacion(_tipo, _actividad, v_uid);
  IF NOT COALESCE((s->>'elegible')::boolean, false) THEN
    RAISE EXCEPTION '%', public._grupo_est_motivo_texto(s->>'motivo') USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO t FROM public._grupo_est_tablas(_tipo);

  v_cursos := ARRAY(SELECT jsonb_array_elements_text(s->'cursos')::uuid);
  v_mis := ARRAY(SELECT jsonb_array_elements_text(s->'mis_cursos')::uuid);

  IF s->'grupo' <> 'null'::jsonb THEN
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(jsonb_build_object(
                ''id'', m.user_id,
                ''nombre'', COALESCE(NULLIF(btrim(p.full_name), ''''), p.institutional_email, ''—'')
              ) ORDER BY m.joined_at, p.full_name), ''[]''::jsonb)
         FROM public.%I m LEFT JOIN public.profiles p ON p.id = m.user_id
        WHERE m.group_id = $1', t.mem)
      INTO v_integrantes USING (s->'grupo'->>'id')::uuid;
  END IF;

  IF s->>'motivo' IS NULL THEN
    -- Compañeros de SU curso con la actividad asignada, cuenta activa y sin quien
    -- la dicta. `estado`: disponible · en_grupo · por_su_cuenta (entregó o
    -- empezó solo: no se distingue, ver el encabezado).
    EXECUTE format(
      'SELECT COALESCE(jsonb_agg(x.fila ORDER BY x.nombre), ''[]''::jsonb) FROM (
         SELECT COALESCE(NULLIF(btrim(p.full_name), ''''), p.institutional_email, ''—'') AS nombre,
                jsonb_build_object(
                  ''id'', u.user_id,
                  ''nombre'', COALESCE(NULLIF(btrim(p.full_name), ''''), p.institutional_email, ''—''),
                  ''grupo'', g.name,
                  ''estado'', CASE
                    WHEN g.id IS NOT NULL THEN ''en_grupo''
                    WHEN s.id IS NOT NULL THEN ''por_su_cuenta''
                    ELSE ''disponible'' END
                ) AS fila
           FROM (SELECT DISTINCT e.user_id FROM public.course_enrollments e
                  WHERE e.course_id = ANY ($2)) u
           JOIN public.profiles p
             ON p.id = u.user_id AND p.deleted_at IS NULL AND COALESCE(p.is_active, true)
           JOIN public.%1$I a ON a.%2$I = $1 AND a.user_id = u.user_id
           LEFT JOIN LATERAL (
             SELECT gg.id, gg.name FROM public.%3$I gg
               JOIN public.%4$I mm ON mm.group_id = gg.id
              WHERE gg.%2$I = $1 AND mm.user_id = u.user_id
              LIMIT 1
           ) g ON true
           LEFT JOIN LATERAL (
             SELECT ss.id FROM public.%5$I ss
              WHERE ss.%2$I = $1 AND ss.user_id = u.user_id AND ss.group_id IS NULL
              LIMIT 1
           ) s ON true
          WHERE u.user_id <> $3
            AND NOT EXISTS (SELECT 1 FROM public.course_teachers ct
                             WHERE ct.user_id = u.user_id AND ct.course_id = ANY ($4))
       ) x',
      t.asg, t.fk, t.grp, t.mem, t.sub)
      INTO v_companeros USING _actividad, v_mis, v_uid, v_cursos;
  END IF;

  RETURN jsonb_build_object(
    'motivo', s->'motivo',
    'modo', s->'modo',
    'arman_estudiantes', s->'arman_estudiantes',
    'externa', s->'externa',
    'minimo', s->'minimo',
    'maximo', s->'maximo',
    'grupo', CASE WHEN s->'grupo' = 'null'::jsonb THEN NULL ELSE jsonb_build_object(
      'id', s->'grupo'->'id',
      'nombre', s->'grupo'->'nombre',
      'entregado', s->'grupo'->'entregado',
      'integrantes', v_integrantes
    ) END,
    'individual', s->'individual',
    'companeros', v_companeros
  );
END
$fn$;

-- ── 7) Crear un grupo eligiendo compañeros ───────────────────────────
CREATE OR REPLACE FUNCTION public.grupo_estudiante_crear(
  _tipo text, _actividad uuid, _nombre text, _companeros uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  t record;
  s jsonb;
  v_cursos uuid[];
  v_mis uuid[];
  v_comp uuid[];
  v_c uuid;
  v_err text;
  v_total int;
  v_nombre text;
  v_n int;
  v_existe boolean;
  v_gid uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM public._grupo_est_tablas(_tipo);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tipo de actividad no válido: %', _tipo USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('grupos_estudiantes:' || _tipo || ':' || _actividad::text));

  s := public._grupo_est_situacion(_tipo, _actividad, v_uid);
  IF NOT COALESCE((s->>'elegible')::boolean, false) OR s->>'motivo' IS NOT NULL THEN
    RAISE EXCEPTION '%', public._grupo_est_motivo_texto(s->>'motivo') USING ERRCODE = 'P0001';
  END IF;
  IF s->'grupo' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'Ya estás en el grupo «%». Para armar otro, primero sal de ese.', s->'grupo'->>'nombre'
      USING ERRCODE = 'P0001';
  END IF;
  IF s->'individual' <> 'null'::jsonb AND (s->'individual'->>'entregada')::boolean THEN
    RAISE EXCEPTION 'Ya entregaste de forma individual, así que no puedes armar un grupo en esta actividad.'
      USING ERRCODE = 'P0001';
  END IF;

  v_cursos := ARRAY(SELECT jsonb_array_elements_text(s->'cursos')::uuid);
  v_mis := ARRAY(SELECT jsonb_array_elements_text(s->'mis_cursos')::uuid);
  v_comp := ARRAY(
    SELECT DISTINCT c FROM unnest(COALESCE(_companeros, '{}'::uuid[])) c
     WHERE c IS NOT NULL AND c <> v_uid
  );

  v_total := 1 + cardinality(v_comp);
  IF v_total < (s->>'minimo')::int THEN
    RAISE EXCEPTION 'El grupo debe tener al menos % integrantes (contándote a ti).', s->>'minimo'
      USING ERRCODE = 'P0001';
  END IF;
  IF v_total > (s->>'maximo')::int THEN
    RAISE EXCEPTION 'El grupo puede tener como máximo % integrantes (contándote a ti).', s->>'maximo'
      USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_c IN ARRAY v_comp LOOP
    v_err := public._grupo_est_validar_companero(_tipo, _actividad, v_cursos, v_mis, v_c);
    IF v_err IS NOT NULL THEN
      RAISE EXCEPTION '%', v_err USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  -- Nombre: el que eligió (recortado), o «Grupo N» con el primer N libre.
  v_nombre := left(regexp_replace(btrim(COALESCE(_nombre, '')), '\s+', ' ', 'g'), 60);
  IF v_nombre = '' THEN
    EXECUTE format('SELECT count(*) FROM public.%I g WHERE g.%I = $1', t.grp, t.fk)
      INTO v_n USING _actividad;
    LOOP
      v_n := v_n + 1;
      v_nombre := 'Grupo ' || v_n;
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I g WHERE g.%I = $1 AND lower(g.name) = lower($2))',
                     t.grp, t.fk)
        INTO v_existe USING _actividad, v_nombre;
      EXIT WHEN NOT v_existe;
    END LOOP;
  ELSE
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I g WHERE g.%I = $1 AND lower(g.name) = lower($2))',
                   t.grp, t.fk)
      INTO v_existe USING _actividad, v_nombre;
    IF v_existe THEN
      RAISE EXCEPTION 'Ya hay un grupo llamado «%» en esta actividad. Elige otro nombre.', v_nombre
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  EXECUTE format('INSERT INTO public.%I (%I, name, created_by) VALUES ($1, $2, $3) RETURNING id',
                 t.grp, t.fk)
    INTO v_gid USING _actividad, v_nombre, v_uid;

  -- Su borrador individual sin entregar pasa a ser el del grupo, ANTES de
  -- insertar la membresía (el trigger de la mig 20261068000000 rechaza sumar
  -- a quien tiene una fila individual).
  IF s->'individual' <> 'null'::jsonb THEN
    EXECUTE format('UPDATE public.%I SET group_id = $1 WHERE id = $2', t.sub)
      USING v_gid, (s->'individual'->>'id')::uuid;
  END IF;

  EXECUTE format('INSERT INTO public.%I (group_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) u',
                 t.mem)
    USING v_gid, array_prepend(v_uid, v_comp);

  PERFORM public._grupo_est_avisar(_tipo, _actividad, v_gid, v_nombre, (s->>'curso')::uuid,
                                   'created', v_uid, v_comp);

  RETURN v_gid;
END
$fn$;

-- ── 8) Agregar compañeros al grupo propio ────────────────────────────
CREATE OR REPLACE FUNCTION public.grupo_estudiante_agregar(
  _tipo text, _grupo uuid, _companeros uuid[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  t record;
  s jsonb;
  v_actividad uuid;
  v_cursos uuid[];
  v_mis uuid[];
  v_comp uuid[];
  v_c uuid;
  v_err text;
  v_actual int;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM public._grupo_est_tablas(_tipo);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tipo de actividad no válido: %', _tipo USING ERRCODE = 'P0001';
  END IF;

  EXECUTE format('SELECT g.%I FROM public.%I g WHERE g.id = $1', t.fk, t.grp)
    INTO v_actividad USING _grupo;
  IF v_actividad IS NULL THEN
    RAISE EXCEPTION 'No se encontró el grupo.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('grupos_estudiantes:' || _tipo || ':' || v_actividad::text));

  s := public._grupo_est_situacion(_tipo, v_actividad, v_uid);
  IF NOT COALESCE((s->>'elegible')::boolean, false) OR s->>'motivo' IS NOT NULL THEN
    RAISE EXCEPTION '%', public._grupo_est_motivo_texto(s->>'motivo') USING ERRCODE = 'P0001';
  END IF;
  IF s->'grupo' = 'null'::jsonb OR (s->'grupo'->>'id')::uuid <> _grupo THEN
    RAISE EXCEPTION 'Solo puedes agregar compañeros a tu propio grupo.' USING ERRCODE = 'P0001';
  END IF;

  v_cursos := ARRAY(SELECT jsonb_array_elements_text(s->'cursos')::uuid);
  v_mis := ARRAY(SELECT jsonb_array_elements_text(s->'mis_cursos')::uuid);
  v_comp := ARRAY(
    SELECT DISTINCT c FROM unnest(COALESCE(_companeros, '{}'::uuid[])) c
     WHERE c IS NOT NULL AND c <> v_uid
  );
  IF cardinality(v_comp) = 0 THEN
    RETURN 0;
  END IF;

  v_actual := (s->'grupo'->>'integrantes')::int;
  IF v_actual + cardinality(v_comp) > (s->>'maximo')::int THEN
    RAISE EXCEPTION 'El grupo puede tener como máximo % integrantes; ya tiene %.', s->>'maximo', v_actual
      USING ERRCODE = 'P0001';
  END IF;

  FOREACH v_c IN ARRAY v_comp LOOP
    v_err := public._grupo_est_validar_companero(_tipo, v_actividad, v_cursos, v_mis, v_c);
    IF v_err IS NOT NULL THEN
      RAISE EXCEPTION '%', v_err USING ERRCODE = 'P0001';
    END IF;
  END LOOP;

  EXECUTE format('INSERT INTO public.%I (group_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) u',
                 t.mem)
    USING _grupo, v_comp;

  PERFORM public._grupo_est_avisar(_tipo, v_actividad, _grupo, s->'grupo'->>'nombre',
                                   (s->>'curso')::uuid, 'added', v_uid, v_comp);

  RETURN cardinality(v_comp);
END
$fn$;

-- ── 9) Salirse del grupo propio ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.grupo_estudiante_salir(_tipo text, _grupo uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  t record;
  s jsonb;
  v_actividad uuid;
  v_quedan int;
  v_sid uuid;
  v_suid uuid;
  v_sucesor uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO t FROM public._grupo_est_tablas(_tipo);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tipo de actividad no válido: %', _tipo USING ERRCODE = 'P0001';
  END IF;

  EXECUTE format('SELECT g.%I FROM public.%I g WHERE g.id = $1', t.fk, t.grp)
    INTO v_actividad USING _grupo;
  IF v_actividad IS NULL THEN
    RAISE EXCEPTION 'No se encontró el grupo.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('grupos_estudiantes:' || _tipo || ':' || v_actividad::text));

  s := public._grupo_est_situacion(_tipo, v_actividad, v_uid);
  IF NOT COALESCE((s->>'elegible')::boolean, false) OR s->>'motivo' IS NOT NULL THEN
    RAISE EXCEPTION '%', public._grupo_est_motivo_texto(s->>'motivo') USING ERRCODE = 'P0001';
  END IF;
  IF s->'grupo' = 'null'::jsonb OR (s->'grupo'->>'id')::uuid <> _grupo THEN
    RAISE EXCEPTION 'No estás en ese grupo.' USING ERRCODE = 'P0001';
  END IF;

  EXECUTE format('DELETE FROM public.%I WHERE group_id = $1 AND user_id = $2', t.mem)
    USING _grupo, v_uid;

  EXECUTE format('SELECT count(*) FROM public.%I m WHERE m.group_id = $1', t.mem)
    INTO v_quedan USING _grupo;

  v_sid := NULLIF(s->'grupo'->>'entrega_id', '')::uuid;
  v_suid := NULLIF(s->'grupo'->>'entrega_user_id', '')::uuid;

  IF v_quedan = 0 THEN
    -- Era el último: su borrador vuelve a ser individual y el grupo se borra.
    IF v_sid IS NOT NULL THEN
      EXECUTE format('UPDATE public.%I SET group_id = NULL, user_id = $1 WHERE id = $2', t.sub)
        USING v_uid, v_sid;
    END IF;
    EXECUTE format('DELETE FROM public.%I WHERE id = $1', t.grp) USING _grupo;
  ELSIF v_sid IS NOT NULL AND v_suid = v_uid THEN
    -- Era el «último editor» de la entrega del grupo: la fila pasa al
    -- integrante más antiguo que queda, o el que se fue la seguiría editando.
    -- `joined_at` empata entre los fundadores (mismo INSERT, mismo `now()`):
    -- `user_id` desempata para que el sucesor no dependa del plan.
    EXECUTE format(
      'SELECT m.user_id FROM public.%I m WHERE m.group_id = $1 ORDER BY m.joined_at, m.user_id LIMIT 1',
      t.mem)
      INTO v_sucesor USING _grupo;
    EXECUTE format('UPDATE public.%I SET user_id = $1 WHERE id = $2', t.sub)
      USING v_sucesor, v_sid;
  END IF;

  PERFORM public._grupo_est_avisar(_tipo, v_actividad, _grupo, s->'grupo'->>'nombre',
                                   (s->>'curso')::uuid, 'left', v_uid, '{}'::uuid[]);
END
$fn$;

-- ── 10) Permisos ─────────────────────────────────────────────────────
-- Los helpers solo se llaman desde las RPC (que corren como su dueño). El
-- REVOKE explícito a `anon`: Supabase otorga EXECUTE por default privileges y
-- el `FROM PUBLIC` solo no lo quita (ver CLAUDE.md, encuestas públicas).
REVOKE ALL ON FUNCTION public._grupo_est_tablas(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._grupo_est_situacion(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._grupo_est_validar_companero(text, uuid, uuid[], uuid[], uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._grupo_est_motivo_texto(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._grupo_est_avisar(text, uuid, uuid, text, uuid, text, uuid, uuid[]) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.grupos_estudiante_resumen(text, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.grupo_estudiante_estado(text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.grupo_estudiante_crear(text, uuid, text, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.grupo_estudiante_agregar(text, uuid, uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.grupo_estudiante_salir(text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.grupos_estudiante_resumen(text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grupo_estudiante_estado(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grupo_estudiante_crear(text, uuid, text, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grupo_estudiante_agregar(text, uuid, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.grupo_estudiante_salir(text, uuid) TO authenticated;

-- ── 11) Duplicar conserva quién arma los grupos ─────────────────────
-- Cuerpos de 20262670000000 (clone_workshop) y 20262820000000 (clone_project)
-- con dos cambios: copian `students_form_groups`, y sin «copiar grupos» los
-- topes caen al default de la columna (2 y 5) en vez de NULL. Con NULL, el
-- INSERT violaba el NOT NULL de `group_size_min` (23502): desmarcar «Grupos»
-- en el diálogo de Duplicar fallaba siempre.
DO $$
BEGIN
  IF to_regclass('public.workshops') IS NULL OR to_regclass('public.workshop_courses') IS NULL THEN
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.clone_workshop(
    _source_id        UUID,
    _target_course_id UUID,
    _new_title        TEXT DEFAULT NULL,
    _new_start_date   TIMESTAMPTZ DEFAULT NULL,
    _new_due_date     TIMESTAMPTZ DEFAULT NULL,
    _copy_questions   BOOLEAN DEFAULT true,
    _copy_groups      BOOLEAN DEFAULT true
  ) RETURNS UUID
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path TO 'public'
  AS $function$
  DECLARE
    _new_id UUID;
    _final_title TEXT;
  BEGIN
    IF NOT (
      (
        public.is_admin_of_course_tenant((SELECT w.course_id FROM public.workshops w WHERE w.id = _source_id))
        AND public.is_admin_of_course_tenant(_target_course_id)
      )
      OR (
        EXISTS (
          SELECT 1 FROM public.workshops w
          JOIN public.course_teachers ct ON ct.course_id = w.course_id
          WHERE w.id = _source_id AND ct.user_id = auth.uid()
        )
        AND EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
        )
      )
    ) THEN
      RAISE EXCEPTION 'No autorizado para clonar este taller al curso destino';
    END IF;

    -- Papelera: no se puede clonar un taller origen en la papelera.
    IF (SELECT w.deleted_at FROM public.workshops w WHERE w.id = _source_id) IS NOT NULL THEN
      RAISE EXCEPTION 'No se puede clonar: el taller origen está en la papelera';
    END IF;

    SELECT COALESCE(_new_title, 'Copia de ' || w.title)
      INTO _final_title
      FROM public.workshops w WHERE w.id = _source_id;

    INSERT INTO public.workshops (
      course_id, created_by, title, description, instructions, start_date, due_date,
      status, weight, is_external, group_mode, group_size_min, group_size_max,
      max_score, cut_id, requires_defense, students_form_groups
    )
    SELECT
      _target_course_id, auth.uid(), _final_title, w.description, w.instructions,
      COALESCE(_new_start_date, w.start_date),
      COALESCE(_new_due_date, w.due_date),
      'draft', w.weight, w.is_external,
      CASE WHEN _copy_groups THEN w.group_mode ELSE 'individual' END,
      CASE WHEN _copy_groups THEN w.group_size_min ELSE 2 END,
      CASE WHEN _copy_groups THEN w.group_size_max ELSE 5 END,
      w.max_score,
      CASE WHEN _target_course_id = w.course_id THEN w.cut_id ELSE NULL END,
      w.requires_defense,
      CASE WHEN _copy_groups THEN COALESCE(w.students_form_groups, false) ELSE false END
    FROM public.workshops w WHERE w.id = _source_id
    RETURNING id INTO _new_id;

    -- Fila M:N para el curso destino (fuente de verdad de peso/corte en notas).
    INSERT INTO public.workshop_courses (workshop_id, course_id, weight, cut_id)
    SELECT
      _new_id,
      _target_course_id,
      COALESCE(wc.weight, w.weight),
      CASE WHEN _target_course_id = w.course_id THEN COALESCE(wc.cut_id, w.cut_id) ELSE NULL END
    FROM public.workshops w
    LEFT JOIN public.workshop_courses wc
      ON wc.workshop_id = w.id AND wc.course_id = w.course_id
    WHERE w.id = _source_id
    ON CONFLICT (workshop_id, course_id) DO NOTHING;

    IF _copy_questions THEN
      INSERT INTO public.workshop_questions (
        workshop_id, type, content, options, expected_rubric, language, starter_code,
        points, position
      )
      SELECT
        _new_id, q.type, q.content, q.options, q.expected_rubric, q.language, q.starter_code,
        q.points, q.position
      FROM public.workshop_questions q
      WHERE q.workshop_id = _source_id;
    END IF;

    RETURN _new_id;
  END
  $function$;
END $$;

DO $$
BEGIN
  IF to_regclass('public.projects') IS NULL OR to_regclass('public.project_courses') IS NULL THEN
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION public.clone_project(
    _source_id uuid,
    _target_course_id uuid,
    _new_title text DEFAULT NULL::text,
    _new_start_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
    _new_due_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
    _copy_files boolean DEFAULT true,
    _copy_groups boolean DEFAULT true
  )
   RETURNS uuid
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public'
  AS $function$
  DECLARE
    _new_id UUID;
    _final_title TEXT;
  BEGIN
    IF NOT (
      (
        public.is_admin_of_course_tenant((SELECT p.course_id FROM public.projects p WHERE p.id = _source_id))
        AND public.is_admin_of_course_tenant(_target_course_id)
      )
      OR (
        EXISTS (
          SELECT 1 FROM public.projects p
          JOIN public.course_teachers ct ON ct.course_id = p.course_id
          WHERE p.id = _source_id AND ct.user_id = auth.uid()
        )
        AND EXISTS (
          SELECT 1 FROM public.course_teachers ct
          WHERE ct.course_id = _target_course_id AND ct.user_id = auth.uid()
        )
      )
    ) THEN
      RAISE EXCEPTION 'No autorizado para clonar este proyecto al curso destino';
    END IF;

    -- Papelera: no se puede clonar un proyecto origen en la papelera.
    IF (SELECT p.deleted_at FROM public.projects p WHERE p.id = _source_id) IS NOT NULL THEN
      RAISE EXCEPTION 'No se puede clonar: el proyecto origen está en la papelera';
    END IF;

    SELECT COALESCE(_new_title, 'Copia de ' || p.title)
      INTO _final_title
      FROM public.projects p WHERE p.id = _source_id;

    INSERT INTO public.projects (
      course_id, created_by, title, description, instructions, external_link,
      start_date, due_date, status, max_score, weight, is_external,
      group_mode, group_size_min, group_size_max, requires_repository, students_form_groups
    )
    SELECT
      _target_course_id, auth.uid(), _final_title, p.description, p.instructions, p.external_link,
      COALESCE(_new_start_date, p.start_date),
      COALESCE(_new_due_date, p.due_date),
      'draft', p.max_score, p.weight, p.is_external,
      CASE WHEN _copy_groups THEN p.group_mode ELSE 'individual' END,
      CASE WHEN _copy_groups THEN p.group_size_min ELSE 2 END,
      CASE WHEN _copy_groups THEN p.group_size_max ELSE 5 END,
      p.requires_repository,
      CASE WHEN _copy_groups THEN COALESCE(p.students_form_groups, false) ELSE false END
    FROM public.projects p WHERE p.id = _source_id
    RETURNING id INTO _new_id;

    -- Fila M:N para el curso destino. En proyectos el peso/corte vive SOLO en
    -- project_courses (projects no tiene cut_id legacy). weight es NOT NULL → 1.
    INSERT INTO public.project_courses (project_id, course_id, weight, cut_id)
    SELECT
      _new_id,
      _target_course_id,
      COALESCE(pc.weight, p.weight, 1),
      CASE WHEN _target_course_id = p.course_id THEN pc.cut_id ELSE NULL END
    FROM public.projects p
    LEFT JOIN public.project_courses pc
      ON pc.project_id = p.id AND pc.course_id = p.course_id
    WHERE p.id = _source_id
    ON CONFLICT (project_id, course_id) DO NOTHING;

    IF _copy_files THEN
      INSERT INTO public.project_files (
        project_id, type, title, description, expected_rubric, language,
        starter_code, points, position, options
      )
      SELECT
        _new_id, f.type, f.title, f.description, f.expected_rubric, f.language,
        f.starter_code, f.points, f.position, f.options
      FROM public.project_files f
      WHERE f.project_id = _source_id;
    END IF;

    RETURN _new_id;
  END
  $function$;
END $$;

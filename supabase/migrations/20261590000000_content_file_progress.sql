-- ═══════════════════════════════════════════════════════════════════════
-- Progreso de consumo de material + continuidad ("Seguías en…")
-- ═══════════════════════════════════════════════════════════════════════
--
-- Registra qué archivos del material del tablero abrió/descargó cada alumno,
-- para (a) mostrarle cuánto material lleva abierto y (b) ofrecerle retomar
-- donde iba.
--
-- ── La clave estable: `file_path` ──────────────────────────────────────
-- Los archivos viven en `generated_contents.files[]` (JSONB). La identidad
-- del archivo es su `path`, con formato `<owner_uid>/<content_id>/<slug>`,
-- construido en los ÚNICOS 3 sitios que suben material (el dialog de subida
-- del docente, la subida desde el tablero y la generación con IA). Se eligió
-- `path` porque:
--   · SOBREVIVE las ediciones in-place: "nueva versión" es un upsert al MISMO
--     path en todos los flujos (visor de media, editor md, editor pptx), y
--     ningún código reescribe el path de una entrada existente.
--   · El ÍNDICE del array NO sirve: borrar un archivo filtra `files[]` y el
--     regen parcial de IA lo reordena.
--   · El `name` NO sirve: colisiona por slugificación ("Calculo.pdf" y
--     "Cálculo.pdf" caen al mismo slug).
--   · El `kind` NO sirve como discriminador: el tipo TS declara
--     "pptx-source"|"md"|"txt" pero TODO el material subido tiene
--     kind="uploaded" (por eso el cliente discrimina por EXTENSIÓN).
-- Precedente idéntico en el repo: `content_slide_annotations`
-- (20261570000000) keyea por "<file_path>#<slide_index>".
--
-- TRADE-OFF ACEPTADO: el regen COMPLETO con IA reescribe `files[]` entero con
-- nombres nuevos → las filas viejas quedan huérfanas. NO se pone FK al path
-- (imposible) y NO se borran: el conteo se calcula por INTERSECCIÓN contra el
-- `files[]` actual, así que las huérfanas se ignoran sin inflar el número.
--
-- ── Por qué NO se extiende `video_views` ───────────────────────────────
-- Esa tabla está muerta (0 referencias fuera de types.ts) y sería barato
-- reciclarla, pero es estructuralmente incapaz: su clave es `video_id` con FK
-- a `public.videos` y no hay dónde poner un `file_path`. Son entidades
-- distintas (video de biblioteca vs archivo de material). Cuando llegue
-- "continuar viendo el video" (v2), `video_views` SÍ es el lugar correcto.
--
-- ── Modelo de escritura: SOLO por RPC ──────────────────────────────────
-- La tabla NO tiene policy de INSERT/UPDATE/DELETE a propósito. Si se
-- abriera una policy owner-writable, un alumno podría POSTear `opened_at` sin
-- haber abierto nada (clase de vulnerabilidad self-tamper ya vista en este
-- repo). El único camino de escritura es `mark_content_file_viewed()`, que
-- valida server-side. Precedente: `workshop_submission_video_views`
-- (20260603190000) tiene solo SELECT y escribe por su RPC.

DO $mig$
BEGIN
  -- Defensivo: en Lovable una migración que falla ABORTA EL DEPLOY COMPLETO,
  -- y a veces se marcan migraciones como aplicadas sin que el CREATE TABLE
  -- del padre haya corrido. Si falta cualquier dependencia, se omite todo y
  -- el deploy sigue.
  IF to_regclass('public.generated_contents') IS NULL
     OR to_regclass('public.courses') IS NULL
     OR to_regclass('public.course_enrollments') IS NULL
     OR to_regclass('public.attendance_sessions') IS NULL
     OR to_regclass('public.content_course_assignments') IS NULL THEN
    RAISE NOTICE 'content_file_progress: falta una tabla padre — se omite';
    RETURN;
  END IF;

  IF to_regprocedure('public.content_released_for_student(uuid)') IS NULL
     OR to_regprocedure('public.course_in_my_tenant(uuid)') IS NULL
     OR to_regprocedure('public.is_admin_of_course_tenant(uuid)') IS NULL THEN
    RAISE NOTICE 'content_file_progress: faltan helpers de tenant/release — se omite';
    RETURN;
  END IF;

  -- ── 1. Tabla ────────────────────────────────────────────────────────
  --
  -- `course_id` VA en la PK y es NOT NULL: el mismo contenido puede estar
  -- asignado a 2 cursos del mismo alumno y cada curso lleva su propio avance;
  -- y da el scope de tenant SIN joins, que es imprescindible porque
  -- `generated_contents.course_id` es NULLABLE y esa tabla no tiene
  -- `tenant_id` — el tenant NO se puede derivar del contenido.
  --
  -- `session_id` NO va en la PK: el mismo (content_id, file_path) se renderiza
  -- bajo N sesiones por varios caminos, y meterlo en la clave duplicaría filas
  -- e inflaría el numerador.
  EXECUTE $ddl$
    CREATE TABLE IF NOT EXISTS public.content_file_progress (
      user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
      course_id       uuid NOT NULL REFERENCES public.courses(id) ON DELETE CASCADE,
      content_id      uuid NOT NULL REFERENCES public.generated_contents(id) ON DELETE CASCADE,
      file_path       text NOT NULL,
      last_session_id uuid REFERENCES public.attendance_sessions(id) ON DELETE SET NULL,
      first_seen_at   timestamptz NOT NULL DEFAULT now(),
      last_seen_at    timestamptz NOT NULL DEFAULT now(),
      opened_at       timestamptz,
      downloaded_at   timestamptz,
      interactions    int NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, course_id, content_id, file_path)
    )
  $ddl$;

  EXECUTE $ddl$
    CREATE INDEX IF NOT EXISTS idx_cfp_user_course_recent
      ON public.content_file_progress (user_id, course_id, last_seen_at DESC)
  $ddl$;

  EXECUTE $ddl$
    CREATE INDEX IF NOT EXISTS idx_cfp_content
      ON public.content_file_progress (content_id)
  $ddl$;

  EXECUTE $ddl$
    COMMENT ON TABLE public.content_file_progress IS
      'Material del tablero que cada alumno abrio/descargo. Una fila por (alumno, curso, contenido, file_path). Se escribe SOLO por mark_content_file_viewed(): no hay policy de INSERT/UPDATE a proposito (evita fabricar opened_at).'
  $ddl$;

  -- ── 2. RLS ──────────────────────────────────────────────────────────
  --
  -- El progreso académico es dato sensible del alumno: NINGUNA rama permite
  -- que un alumno lea el de otro. Todo se scopea por el `course_id` de la
  -- fila, así que no hay `USING (true)` ni ramas `has_role()` sin tenant —
  -- los dos anti-patrones de leak cross-tenant del repo.
  EXECUTE 'ALTER TABLE public.content_file_progress ENABLE ROW LEVEL SECURITY';

  EXECUTE 'DROP POLICY IF EXISTS cfp_select ON public.content_file_progress';
  EXECUTE $ddl$
    CREATE POLICY cfp_select
      ON public.content_file_progress FOR SELECT TO authenticated
      USING (
        user_id = auth.uid()
        OR public.is_super_admin()
        OR (
          public.course_in_my_tenant(course_id)
          AND EXISTS (
            SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = content_file_progress.course_id
               AND ct.user_id = auth.uid()
          )
        )
        OR public.is_admin_of_course_tenant(course_id)
      )
  $ddl$;

  -- ── 3. Predicado de visibilidad COMPARTIDO ──────────────────────────
  --
  -- UN solo helper para los dos RPCs. Tenerlo duplicado fue el defecto que
  -- encontró la revisión del diseño: el RPC de lectura no re-verificaba nada,
  -- así que seguía ofreciendo "Seguías en: X" después de que el docente
  -- despublicó o desasignó el material, contradiciendo al conteo del tablero.
  --
  -- Nota honesta sobre su alcance: valida matrícula, vínculo al curso,
  -- publicación, papelera, ventana de liberación y existencia del path. NO
  -- replica el filtro cliente de archivos solo-docente (GUIA_DOCENTE /
  -- SOLUCION / EXAMEN) porque eso exigiría duplicar en SQL dos regex de JS
  -- con casos borde ya documentados como frágiles, creando un invariante
  -- cross-file nuevo. Consecuencia acotada y aceptada: por REST un alumno
  -- podría marcar como abierto un archivo que su UI no le muestra, inflando
  -- SU PROPIO conteo. No es un leak (no lee nada ajeno) ni afecta a nadie más.
  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.content_file_visible_to_student(
      _user uuid, _course uuid, _content uuid, _file_path text
    ) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $fn$
      SELECT EXISTS (
        SELECT 1
          FROM public.generated_contents gc
         WHERE gc.id = _content
           AND gc.deleted_at IS NULL
           AND COALESCE(gc.is_published, true)
           -- Vínculo al curso: directo o por asignación
           AND (
             gc.course_id = _course
             OR EXISTS (
               SELECT 1 FROM public.content_course_assignments a
                WHERE a.content_id = gc.id AND a.course_id = _course
             )
           )
           -- Ventana de liberación (helper ya existente)
           AND public.content_released_for_student(gc.id)
           -- El alumno está matriculado en ESE curso
           AND EXISTS (
             SELECT 1 FROM public.course_enrollments e
              WHERE e.course_id = _course AND e.user_id = _user
           )
           -- El curso no está en la papelera
           AND EXISTS (
             SELECT 1 FROM public.courses c
              WHERE c.id = _course AND c.deleted_at IS NULL
           )
           -- El archivo existe HOY en files[] (la columna es NOT NULL
           -- DEFAULT '[]', así que jsonb_array_elements es seguro)
           AND EXISTS (
             SELECT 1 FROM jsonb_array_elements(gc.files) f
              WHERE f->>'path' = _file_path
           )
      );
    $fn$
  $ddl$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.content_file_visible_to_student(uuid,uuid,uuid,text) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.content_file_visible_to_student(uuid,uuid,uuid,text) TO authenticated';

  -- ── 4. RPC de escritura ─────────────────────────────────────────────
  --
  -- `_action` se valida acá y NO como CHECK de columna, para poder sumar
  -- acciones nuevas sin otra migración.
  EXECUTE $ddl$
    CREATE OR REPLACE FUNCTION public.mark_content_file_viewed(
      _course uuid, _content uuid, _file_path text,
      _action text DEFAULT 'open', _session uuid DEFAULT NULL
    ) RETURNS void
    LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
    AS $fn$
    DECLARE
      _uid uuid := auth.uid();
      _sess uuid;
    BEGIN
      IF _uid IS NULL THEN
        RAISE EXCEPTION 'No hay sesión activa.';
      END IF;
      IF _action IS NULL OR _action NOT IN ('open', 'download') THEN
        RAISE EXCEPTION 'Acción inválida: %', _action;
      END IF;
      IF NOT public.content_file_visible_to_student(_uid, _course, _content, _file_path) THEN
        RAISE EXCEPTION 'Ese material no está disponible para vos.';
      END IF;

      -- Solo se guarda la sesión si sigue viva y pertenece al curso: sin esto
      -- quedaría apuntando a una sesión en papelera.
      SELECT s.id INTO _sess
        FROM public.attendance_sessions s
       WHERE s.id = _session
         AND s.course_id = _course
         AND s.deleted_at IS NULL;

      INSERT INTO public.content_file_progress AS p (
        user_id, course_id, content_id, file_path, last_session_id,
        opened_at, downloaded_at
      ) VALUES (
        _uid, _course, _content, _file_path, _sess,
        CASE WHEN _action = 'open' THEN now() END,
        CASE WHEN _action = 'download' THEN now() END
      )
      ON CONFLICT (user_id, course_id, content_id, file_path) DO UPDATE
        SET last_seen_at    = now(),
            interactions    = p.interactions + 1,
            last_session_id = COALESCE(_sess, p.last_session_id),
            -- Se preserva la PRIMERA vez de cada acción: saber que además
            -- descargó no debe borrar que había abierto.
            opened_at       = CASE WHEN _action = 'open'
                                   THEN COALESCE(p.opened_at, now())
                                   ELSE p.opened_at END,
            downloaded_at   = CASE WHEN _action = 'download'
                                   THEN COALESCE(p.downloaded_at, now())
                                   ELSE p.downloaded_at END;
    END;
    $fn$
  $ddl$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.mark_content_file_viewed(uuid,uuid,text,text,uuid) FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.mark_content_file_viewed(uuid,uuid,text,text,uuid) TO authenticated';

  -- ── 5. RPC de continuidad ───────────────────────────────────────────
  --
  -- Devuelve, por curso, el último material que el alumno tocó. Re-verifica
  -- la visibilidad con el MISMO predicado que la escritura: si el docente
  -- despublicó, desasignó o mandó a la papelera el material, deja de
  -- ofrecerse — que era el defecto principal del diseño original.
  --
  -- La sesión se proyecta desde el JOIN filtrado (`s.id`), NO desde la
  -- columna cruda: proyectar `p.last_session_id` hacía que el filtro de
  -- papelera fuera código muerto.
  EXECUTE 'DROP FUNCTION IF EXISTS public.get_my_course_continuity()';
  EXECUTE $ddl$
    CREATE FUNCTION public.get_my_course_continuity()
    RETURNS TABLE (
      course_id uuid,
      content_id uuid,
      file_path text,
      content_label text,
      session_id uuid,
      last_seen_at timestamptz
    )
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
    AS $fn$
      SELECT DISTINCT ON (p.course_id)
             p.course_id,
             p.content_id,
             p.file_path,
             COALESCE(gc.display_name, gc.topic) AS content_label,
             s.id AS session_id,
             p.last_seen_at
        FROM public.content_file_progress p
        JOIN public.generated_contents gc ON gc.id = p.content_id
        LEFT JOIN public.attendance_sessions s
               ON s.id = p.last_session_id
              AND s.deleted_at IS NULL
       WHERE p.user_id = auth.uid()
         AND public.content_file_visible_to_student(
               auth.uid(), p.course_id, p.content_id, p.file_path)
       ORDER BY p.course_id, p.last_seen_at DESC;
    $fn$
  $ddl$;

  EXECUTE 'REVOKE ALL ON FUNCTION public.get_my_course_continuity() FROM anon';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.get_my_course_continuity() TO authenticated';
END $mig$;

-- Refrescar el cache de esquema de PostgREST para que los RPCs queden
-- invocables sin esperar el reload periódico.
NOTIFY pgrst, 'reload schema';

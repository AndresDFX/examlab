-- ══════════════════════════════════════════════════════════════════════════
-- 1) El SuperAdmin no podía tocar los controles de tiempo de un examen.
-- 2) Reapertura DIRIGIDA de la Prueba diagnóstica de SB141B para un estudiante
--    que se matriculó después de que la ventana cerrara.
--
-- ── El hueco (1) ──────────────────────────────────────────────────────────
-- `exam_timer_controls_write` (mig 20260994000000) exige
-- `exam_in_my_tenant(exam_id) AND (has_role('Docente') OR has_role('Admin'))`.
-- La primera mitad YA cubre al SuperAdmin —`exam_in_my_tenant` delega en
-- `course_in_my_tenant`, que arranca con `is_super_admin()`—, pero la segunda
-- no: el SuperAdmin tiene el rol `SuperAdmin`, no `Docente` ni `Admin`. O sea
-- que pasaba el scope de institución y lo frenaba el rol, con un 42501 que no
-- dice cuál de las dos mitades falló.
--
-- Es el patrón que CLAUDE.md ya describe para los módulos anteriores al rol
-- SuperAdmin (db_backups lo pagó en la mig 20260903100000): la rama de rol se
-- escribió cuando ese rol no existía. Se suma `is_super_admin()` como TERCERA
-- alternativa del rol, NO como bypass del tenant — el `AND exam_in_my_tenant`
-- se conserva, así que esto no afloja el aislamiento entre instituciones (y
-- para el SuperAdmin ese helper ya devolvía true de todos modos).
--
-- ── El caso (2), y por qué va en una migración y no a mano ────────────────
-- El estudiante `c2a0eb42…` quedó matriculado en SB141B el 2026-09-23, seis
-- días después de que la Prueba diagnóstica cerrara (fin 2026-09-17 21:30 UTC).
-- Está asignado al examen, pero el gate de la ventana lo saca.
--
-- Lo que NO se hace: mover `exams.end_time`. Esa columna es del EXAMEN, no del
-- estudiante: correrla reabre el examen para los 34, incluidos los 29 que ya
-- entregaron — y una entrega `completado` es REANUDABLE desde la pantalla del
-- alumno (ver `tg_block_reopen_closed_attempt`, mig 20261960000000: solo frena
-- lo que cerró el docente, no lo que se entregó normalmente). Reabrir la
-- ventana sería, literalmente, devolverle el examen calificado a 29 personas.
--
-- Lo que sí: una fila de `exam_timer_controls` con `target_user_id`. Los dos
-- lados que deciden el plazo la filtran por ese campo —el cliente en
-- `app.student.take.$examId.tsx` (`target_user_id.is.null,target_user_id.eq.<yo>`)
-- y el servidor en `exam_attempt_deadline` (`c.target_user_id IS NULL OR
-- c.target_user_id = v_sub.user_id`)—, así que el extra existe SOLO para él.
-- Nadie más ve un segundo de diferencia.
--
-- Va en una migración, y no como un INSERT suelto por el SQL Editor, por el
-- precedente de la mig 20262220000000: un parche puntual de datos que no queda
-- en el repo es un cambio de producción que después nadie puede explicar.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1 · La policy, con el SuperAdmin ──────────────────────────────────────
DO $mig$
BEGIN
  IF to_regclass('public.exam_timer_controls') IS NULL THEN
    RAISE NOTICE 'exam_timer_controls ausente; nada que hacer.';
    RETURN;
  END IF;

  EXECUTE 'DROP POLICY IF EXISTS "exam_timer_controls_write" ON public.exam_timer_controls';

  EXECUTE $POLICY$
    CREATE POLICY "exam_timer_controls_write"
      ON public.exam_timer_controls FOR ALL TO authenticated
      USING (
        public.exam_in_my_tenant(exam_id)
        AND (
          public.has_role(auth.uid(), 'Docente')
          OR public.has_role(auth.uid(), 'Admin')
          OR public.is_super_admin()
        )
      )
      WITH CHECK (
        public.exam_in_my_tenant(exam_id)
        AND (
          public.has_role(auth.uid(), 'Docente')
          OR public.has_role(auth.uid(), 'Admin')
          OR public.is_super_admin()
        )
      )
  $POLICY$;
END $mig$;

-- ── 2 · La reapertura dirigida ────────────────────────────────────────────
-- 804.540 s desde el fin original (2026-09-17 21:30 UTC) ⇒ 2026-09-27 04:59 UTC,
-- que son las 23:59 del viernes 26 de septiembre en Colombia. Acotado a
-- propósito: el examen dura 120 min y `schedule_type='normal'`, así que el
-- cronómetro del alumno cuenta hasta el fin de la ventana — una prórroga larga
-- le mostraría un reloj de semanas.
--
-- Idempotente (`NOT EXISTS`): la migración no vuelve a correr, pero un `add_time`
-- duplicado correría el plazo al doble y eso no se ve hasta que alguien lo mide.
--
-- `created_by` es NOT NULL y se atribuye al DOCENTE del curso, que es quien lo
-- habría concedido desde el monitor. El primer intento lo dejó en NULL y la
-- migración se cayó en el deploy con un 23502 — porque el arnés de verificación
-- declaró esa columna como nullable en vez de leerla del esquema real. Es
-- exactamente la trampa que el CHANGELOG ya documenta: un arnés se construye
-- leyendo el esquema, nunca inventando el CREATE TABLE. Ahora el arnés lo
-- declara NOT NULL y habría fallado localmente.
DO $mig$
DECLARE
  v_examen  uuid := 'd4e093f9-2690-4b49-aa5a-f277dc6191de';  -- Prueba diagnóstica · SB141B
  v_alumno  uuid := 'c2a0eb42-d114-4603-9760-d098d36c4422';
  v_extra   int  := 804540;
  v_docente uuid;
BEGIN
  IF to_regclass('public.exam_timer_controls') IS NULL
     OR to_regclass('public.exams') IS NULL
     OR to_regclass('public.exam_assignments') IS NULL THEN
    RAISE NOTICE 'tablas de examen ausentes; nada que hacer.';
    RETURN;
  END IF;

  -- Solo si el examen y la asignación existen en ESTE entorno. Sin esto, una
  -- base de desarrollo sin esos datos no falla pero deja una fila colgada
  -- apuntando a un examen inexistente.
  IF NOT EXISTS (SELECT 1 FROM public.exams WHERE id = v_examen)
     OR NOT EXISTS (
       SELECT 1 FROM public.exam_assignments
        WHERE exam_id = v_examen AND user_id = v_alumno
     ) THEN
    RAISE NOTICE 'examen o asignacion ausentes en este entorno; se omite la reapertura.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.exam_timer_controls
     WHERE exam_id = v_examen
       AND target_user_id = v_alumno
       AND action = 'add_time'
  ) THEN
    RAISE NOTICE 'ya tiene tiempo extra concedido; se omite.';
    RETURN;
  END IF;

  SELECT ct.user_id INTO v_docente
    FROM public.course_teachers ct
    JOIN public.exams e ON e.id = v_examen
   WHERE ct.course_id = e.course_id
   ORDER BY ct.user_id
   LIMIT 1;

  IF v_docente IS NULL THEN
    -- Sin docente no hay a quién atribuirlo, y `created_by` no acepta NULL.
    -- Se omite en vez de inventar un autor.
    RAISE NOTICE 'el curso no tiene docente; se omite la reapertura.';
    RETURN;
  END IF;

  INSERT INTO public.exam_timer_controls (exam_id, target_user_id, action, extra_seconds, created_by)
  VALUES (v_examen, v_alumno, 'add_time', v_extra, v_docente);
END $mig$;

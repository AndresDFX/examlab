# Borrar advertencias en vivo desde el monitor — plan de diseño

> Producido por el workflow `monitor-borrar-advertencias` (mapeo + frente de ataque + síntesis).
> **NO implementado todavía.** Las afirmaciones están verificadas por los agentes contra
> el código; las que sostienen decisiones grandes conviene re-verificarlas antes de
> ejecutar.

Everything in the three mappings checks out against the source. 52 tests green, `submissions` already in the realtime publication, `20261730000000` (the newest migration) already bumped UNIAJ diagnostics to `max_warnings=5` — which makes the hardcoded `/3` in the monitor wrong *in production today*.

---

# Plan: borrar advertencias en vivo desde el monitor

## 0. El encuadre (leer antes de las decisiones)

La feature **ya está escrita** (`clearAllWarnings` monitor:1085, `clearOneWarning` monitor:1164, helpers puros con 52 tests). No hay que construirla: hay que **hacerla alcanzable en vivo y hacer que el efecto sobreviva**. Hoy fallan tres cosas, en este orden de gravedad:

1. **Inalcanzable**: el panel vive dentro del modal "Respuestas", cuya única puerta práctica es el `Eye` gateado por `isFinal` (monitor:2675, `isFinalStatus = completado|sospechoso`). Un intento `en_progreso` no tiene puerta.
2. **Se deshace en ≤5s**: `saveAnswersNow` (take:1022) reescribe `focus_warnings` + `answers.__warning_events` con el valor LOCAL. La limitación está escrita en el propio código (take:1003-1010) con el fix propuesto.
3. **Resta strikes que no existieron**: `applyClearOneWarning` decrementa para CUALQUIER índice, pero `copiar/pegar/cortar/screenshot_attempt` se registran **sin sumar strike** (take:1543, 1597).

Si se agrega el botón sin (2) y (3), la feature **miente**: el docente perdona, ve el 0, y el strike vuelve — habiendo tomado una decisión académica sobre un estado falso. Eso es peor que no tener el botón.

---

## 1. Decisiones

| # | Decisión | Por qué |
|---|---|---|
| D1 | **Las dos: una y todas.** Ya existen ambas; el punto de entrada nuevo expone las dos. | "Limpiar todas" es el martillo (y el único camino para strikes sin evento — ver D6); borrar una es la operación real del caso en vivo. |
| D2 | **RPC `SECURITY DEFINER`**, no UPDATE de cliente ni DELETE. | Un solo lugar de autorización, read-modify-write atómico bajo `FOR UPDATE`, y audit en la MISMA transacción. |
| D3 | **El cliente deja de escribir el blob `answers`.** La RPC toca solo la clave `__warning_events` con `jsonb_set`. | Hoy el docente escribe `answers` COMPLETO desde un snapshot de 800ms–60s → perdonar una advertencia puede **borrar respuestas del examen** escritas en el intervalo. Es el riesgo más caro de todo el frente y nadie lo había reportado. |
| D4 | **Sí se recalcula el status derivado**, con la semántica EXACTA de `finalizeResult` (exam-session.ts:124), pero computada server-side con `now()`. | La lógica ya está bien resuelta y testeada. Moverla al servidor la hace inmune al reloj del cliente (precedente: el desfase del Reto en vivo). |
| D5 | **El decremento solo aplica si el evento borrado suma strike**, por **allowlist** (`pestaña, blur, visibility_hidden, fullscreen_exit, menu, context_menu, retroceso`). | Un tipo desconocido cae a "no suma" → el contador no baja: falla **visible y segura** (el docente usa "Limpiar todas"). Con denylist, un tipo blando nuevo caería a "suma" → sobre-perdón **invisible**. |
| D6 | **`focus_warnings` puede exceder `events.length` legítimamente y NO se clampea.** | `onBeforeUnload` (take:1678) incrementa el contador **sin** agregar evento. Un strike sin evento solo se perdona con "Limpiar todas". Clampear al array sería sobre-perdonar. |
| D7 | **Las advertencias son SERVER-authoritative; las respuestas son CLIENT-authoritative.** | Invariante única que resuelve de un golpe el clobber del autosave, el del `performSubmit` y la resurrección desde IndexedDB, sin arriesgar nunca el trabajo del alumno. |
| D8 | **Borrar por índice + compare-and-swap** (`_expected_type` + `_expected_at`). | El array se mueve (el alumno agrega eventos concurrentes). Sin el CAS se borra el evento equivocado en silencio. |
| D9 | **NO se revierte**: nota (`ai_grade`, `final_override_grade`), veredicto de IA (`ai_detected*`), `similarity_pairs`, `teacher_feedback`. Una entrega `calificado` se **rechaza**. | Un perdón de proctoring no es un perdón de copia ni una re-nota. El plagio es evidencia separada. |
| D10 | **Audit por INSERT directo en `audit_logs` dentro de la RPC**, severity `critical`. NO vía `log_audit_event`. | Esa RPC tiene `EXCEPTION WHEN OTHERS THEN NULL` (audit_logs:136) → tragaría el fallo. Con INSERT directo: si no se audita, no se borra. `critical` cae en el bucket `error_days` de `purge_audit_logs`, no en `warning_days` — un reclamo académico dura más de lo que un Admin suele dejar los warnings. |
| D11 | **La escritura del alumno se vuelve MONOTÓNICA** por trigger: un caller no-staff no puede bajar `focus_warnings` ni acortar `__warning_events`. | Hoy el alumno puede borrar sus propios strikes por REST (la RLS es por fila y el guard 20261034 excluye `focus_warnings` **a propósito**). Sin esto, la feature gobierna un dato que el alumno ya borra solo. |
| D12 | **`_reason TEXT DEFAULT NULL` opcional, siempre auditado.** | ← **Decisión del dueño.** Default conservador = opcional: en medio de un examen un campo obligatorio se llena con ".". Volverlo obligatorio es UNA línea de guard en la RPC (`IF btrim(coalesce(_reason,'')) = '' THEN RAISE`). |

---

## 2. Migración

Un solo archivo: **`supabase/migrations/20261740000000_teacher_clear_exam_warnings.sql`** (sigue a `20261730000000`, que es la última).

Familia de nombres: espeja la de encuestas (`teacher_clear_poll_question_response_for_user` / `..._responses_for_user`) → **`teacher_clear_exam_warning`** (una) y **`teacher_clear_exam_warnings`** (todas).

```sql
-- ══════════════════════════════════════════════════════════════════════
-- El docente borra advertencias de proctoring de una entrega de examen,
-- desde el monitor, con el examen EN CURSO.
--
-- Hasta ahora esto lo hacía el CLIENTE con un UPDATE directo a
-- `submissions` (monitor:1085 y 1164). Se mueve a RPC por tres razones
-- que el UPDATE de cliente no puede resolver:
--
--   · CLOBBER DE RESPUESTAS. El cliente escribía `answers` COMPLETO desde
--     un snapshot con 800ms–60s de antigüedad (el refresco del monitor es
--     debounce 800ms + fallback de 60s). Si el alumno escribió en ese
--     intervalo, perdonar una advertencia le BORRA las respuestas del
--     parcial. Acá el read-modify-write es atómico bajo FOR UPDATE y solo
--     toca la clave `__warning_events`.
--   · AUDITORÍA NO EVADIBLE. El audit era un `logEvent` de cliente,
--     fire-and-forget en un round-trip aparte: quien tira esa request
--     borra evidencia sin rastro. Acá va en la MISMA transacción.
--   · UN SOLO LUGAR DE AUTORIZACIÓN, con el scope de tenant explícito.
--
-- No valida que el examen esté abierto: el docente tiene que poder
-- perdonar después de que la ventana cerró (es cuando aparecen los
-- reclamos). Lo que SÍ cambia según la ventana es el status derivado.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) ¿Este tipo de evento SUMA strike? ──
-- INVARIANTE CROSS-FILE con `isStrikeEvent` en src/modules/exams/proctoring.ts.
-- El array `__warning_events` mezcla DOS clases de evento: los que suman
-- strike (recordWarning) y las señales blandas que solo se registran para
-- que el docente las vea (recordCopyAlert, recordScreenshotAttempt — el
-- comentario en take:1543 dice literal "NO suma strike"). El borrado viejo
-- decrementaba para CUALQUIER índice, así que borrar un "Intento de copiar"
-- regalaba un strike que nunca existió y podía DESUSPENDER a un alumno.
--
-- Es ALLOWLIST, no denylist, a propósito: un tipo nuevo o desconocido cae a
-- "no suma" → el contador no baja y el docente lo VE (y usa "Limpiar
-- todas"). Con denylist, un tipo blando nuevo caería a "suma" y el
-- sobre-perdón sería invisible. Los históricos en inglés `copy`/`paste`
-- quedan fuera aunque en su momento pudieron sumar: errar por no-perdonar.
CREATE OR REPLACE FUNCTION public._exam_warning_is_strike(_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT lower(btrim(coalesce(_type, ''))) IN (
    'pestaña', 'blur', 'visibility_hidden', 'fullscreen_exit',
    'menu', 'context_menu', 'retroceso'
  );
$$;

-- ── 2) ¿El UPDATE acortó el array de advertencias? ──
CREATE OR REPLACE FUNCTION public._exam_warning_events_shrank(_old JSONB, _new JSONB)
RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    jsonb_array_length(
      CASE WHEN jsonb_typeof(_new -> '__warning_events') = 'array'
           THEN _new -> '__warning_events' ELSE '[]'::jsonb END
    ) < jsonb_array_length(
      CASE WHEN jsonb_typeof(_old -> '__warning_events') = 'array'
           THEN _old -> '__warning_events' ELSE '[]'::jsonb END
    ),
  FALSE);
$$;

-- ── 3) Borrar UNA advertencia ──
CREATE OR REPLACE FUNCTION public.teacher_clear_exam_warning(
  _submission_id UUID,
  _event_idx     INT,
  _expected_type TEXT DEFAULT NULL,
  _expected_at   TEXT DEFAULT NULL,
  _reason        TEXT DEFAULT NULL
)
RETURNS TABLE (
  out_status                  TEXT,
  out_focus_warnings          INT,
  out_restored_to_in_progress BOOLEAN,
  out_closed_as_completado    BOOLEAN,
  out_remaining               INT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller     UUID := auth.uid();
  v_sub        public.submissions;
  v_exam       public.exams;
  v_events     JSONB;
  v_event      JSONB;
  v_new_events JSONB;
  v_is_strike  BOOLEAN;
  v_next_warn  INT;
  v_next_stat  TEXT;
  v_clear_sub  BOOLEAN := FALSE;
  v_restored   BOOLEAN := FALSE;
  v_closed     BOOLEAN := FALSE;
  v_open       BOOLEAN;
BEGIN
  -- Guard 1: autenticado. (El GRANT no es la frontera; el cuerpo lo es.)
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;

  -- Guard 2: la entrega existe, y queda BLOQUEADA hasta el commit. Este
  -- FOR UPDATE es lo que serializa contra el autosave del alumno.
  SELECT * INTO v_sub FROM public.submissions
   WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La entrega no existe' USING ERRCODE = '22023';
  END IF;

  -- Guard 3: el examen existe y NO está en la papelera (regla universal de
  -- soft-delete: lo que está en papelera no es usable en ningún flujo).
  SELECT * INTO v_exam FROM public.exams
   WHERE id = v_sub.exam_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El examen no existe o está en la papelera' USING ERRCODE = '22023';
  END IF;

  -- Guard 4: autorización CON scope. Nunca `has_role('Docente')` suelto:
  -- los roles son globales y esa rama deja pasar a cualquier institución.
  IF NOT (
    EXISTS (
      SELECT 1 FROM public.course_teachers ct
       WHERE ct.course_id = v_exam.course_id AND ct.user_id = v_caller
    )
    OR public.is_admin_of_course_tenant(v_exam.course_id)
  ) THEN
    RAISE EXCEPTION 'No tienes permiso para modificar las advertencias de esta entrega'
      USING ERRCODE = '42501';
  END IF;

  -- Guard 5: nunca sobre una entrega ya calificada. Reabrirla cruzaría el
  -- borrado de evidencia con la integridad de notas (que protege el trigger
  -- 20261034) y con certificados ya emitidos que leen esas notas.
  IF v_sub.status = 'calificado' THEN
    RAISE EXCEPTION 'La entrega ya está calificada: no se pueden borrar sus advertencias'
      USING ERRCODE = '42501';
  END IF;

  -- Guard 6: el índice existe.
  v_events := COALESCE(v_sub.answers -> '__warning_events', '[]'::jsonb);
  IF jsonb_typeof(v_events) <> 'array' THEN v_events := '[]'::jsonb; END IF;
  IF _event_idx < 0 OR _event_idx >= jsonb_array_length(v_events) THEN
    RAISE EXCEPTION 'Esa advertencia ya no está en la lista. Actualizá el monitor.'
      USING ERRCODE = '22023';
  END IF;
  v_event := v_events -> _event_idx;

  -- Guard 7: compare-and-swap. El alumno puede haber agregado eventos entre
  -- que el monitor pintó la lista y el docente hizo clic: sin esto se borra
  -- el evento equivocado, en silencio.
  IF _expected_type IS NOT NULL
     AND COALESCE(v_event ->> 'type', '') <> _expected_type THEN
    RAISE EXCEPTION 'La lista de advertencias cambió. Actualizá el monitor.'
      USING ERRCODE = '22023';
  END IF;
  IF _expected_at IS NOT NULL
     AND COALESCE(v_event ->> 'at', '') <> _expected_at THEN
    RAISE EXCEPTION 'La lista de advertencias cambió. Actualizá el monitor.'
      USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(jsonb_agg(e ORDER BY ord), '[]'::jsonb)
    INTO v_new_events
    FROM jsonb_array_elements(v_events) WITH ORDINALITY AS t(e, ord)
   WHERE ord - 1 <> _event_idx;

  v_is_strike := public._exam_warning_is_strike(v_event ->> 'type');
  v_next_warn := GREATEST(
    0,
    COALESCE(v_sub.focus_warnings, 0) - CASE WHEN v_is_strike THEN 1 ELSE 0 END
  );

  -- Status derivado: misma semántica que `finalizeResult` (exam-session.ts:124),
  -- pero con el reloj del SERVIDOR. `start_time`/`end_time` NULL ⇒ cerrado,
  -- igual que `isExamOpen` ante fechas inválidas (exam-time.ts:67).
  v_open := (v_exam.start_time IS NOT NULL
             AND v_exam.end_time IS NOT NULL
             AND now() >= v_exam.start_time
             AND now() <= v_exam.end_time);
  v_next_stat := v_sub.status;
  IF v_sub.status = 'sospechoso'
     AND v_next_warn < GREATEST(1, COALESCE(v_exam.max_warnings, 3)) THEN
    IF v_open THEN
      v_next_stat := 'en_progreso'; v_clear_sub := TRUE; v_restored := TRUE;
    ELSE
      v_next_stat := 'completado'; v_closed := TRUE;
    END IF;
  END IF;

  -- Solo estas cuatro cosas. NUNCA el blob `answers` completo, nunca la
  -- nota, nunca el veredicto de IA, nunca `similarity_pairs`.
  UPDATE public.submissions s
     SET focus_warnings = v_next_warn,
         answers        = jsonb_set(
                            COALESCE(s.answers, '{}'::jsonb),
                            '{__warning_events}', v_new_events, true
                          ),
         status         = v_next_stat,
         submitted_at   = CASE WHEN v_clear_sub THEN NULL ELSE s.submitted_at END
   WHERE s.id = _submission_id;

  -- Auditoría en la MISMA transacción, por INSERT directo. NO por
  -- `log_audit_event`: esa función tiene `EXCEPTION WHEN OTHERS THEN NULL`
  -- (20260509150000:136) y se tragaría el fallo. Acá, si no se audita, no
  -- se borra. severity 'critical' para que caiga en el bucket `error_days`
  -- de `purge_audit_logs` y no en `warning_days`: un reclamo académico dura
  -- más que la retención típica de los warnings.
  INSERT INTO public.audit_logs (
    actor_id, actor_email, actor_role, action, category, severity,
    entity_type, entity_id, course_id, metadata
  )
  SELECT
    v_caller,
    (SELECT email FROM auth.users WHERE id = v_caller),
    (SELECT role::text FROM public.user_roles WHERE user_id = v_caller LIMIT 1),
    'fraud.warning_cleared_one', 'fraud', 'critical',
    'submission', _submission_id::text, v_exam.course_id,
    jsonb_build_object(
      'exam_id',           v_exam.id,
      'student_id',        v_sub.user_id,
      'event_idx',         _event_idx,
      'event',             v_event,
      'was_strike',        v_is_strike,
      'previous_warnings', COALESCE(v_sub.focus_warnings, 0),
      'new_warnings',      v_next_warn,
      'previous_status',   v_sub.status,
      'new_status',        v_next_stat,
      'exam_was_open',     v_open,
      'reason',            _reason
    );

  RETURN QUERY SELECT v_next_stat, v_next_warn, v_restored, v_closed,
                      jsonb_array_length(v_new_events);
END;
$$;

-- ── 4) Borrar TODAS ── (mismos 5 primeros guards; sin índice ni CAS)
CREATE OR REPLACE FUNCTION public.teacher_clear_exam_warnings(
  _submission_id UUID,
  _reason        TEXT DEFAULT NULL
)
RETURNS TABLE (
  out_status                  TEXT,
  out_focus_warnings          INT,
  out_restored_to_in_progress BOOLEAN,
  out_closed_as_completado    BOOLEAN,
  out_cleared                 INT
)
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_caller    UUID := auth.uid();
  v_sub       public.submissions;
  v_exam      public.exams;
  v_events    JSONB;
  v_next_stat TEXT;
  v_clear_sub BOOLEAN := FALSE;
  v_restored  BOOLEAN := FALSE;
  v_closed    BOOLEAN := FALSE;
  v_open      BOOLEAN;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'No autenticado' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_sub FROM public.submissions WHERE id = _submission_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La entrega no existe' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_exam FROM public.exams
   WHERE id = v_sub.exam_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'El examen no existe o está en la papelera' USING ERRCODE = '22023';
  END IF;

  IF NOT (
    EXISTS (SELECT 1 FROM public.course_teachers ct
             WHERE ct.course_id = v_exam.course_id AND ct.user_id = v_caller)
    OR public.is_admin_of_course_tenant(v_exam.course_id)
  ) THEN
    RAISE EXCEPTION 'No tienes permiso para modificar las advertencias de esta entrega'
      USING ERRCODE = '42501';
  END IF;

  IF v_sub.status = 'calificado' THEN
    RAISE EXCEPTION 'La entrega ya está calificada: no se pueden borrar sus advertencias'
      USING ERRCODE = '42501';
  END IF;

  v_events := COALESCE(v_sub.answers -> '__warning_events', '[]'::jsonb);
  IF jsonb_typeof(v_events) <> 'array' THEN v_events := '[]'::jsonb; END IF;

  v_open := (v_exam.start_time IS NOT NULL AND v_exam.end_time IS NOT NULL
             AND now() BETWEEN v_exam.start_time AND v_exam.end_time);
  v_next_stat := v_sub.status;
  IF v_sub.status = 'sospechoso' THEN
    IF v_open THEN
      v_next_stat := 'en_progreso'; v_clear_sub := TRUE; v_restored := TRUE;
    ELSE
      v_next_stat := 'completado'; v_closed := TRUE;
    END IF;
  END IF;

  -- `- '__warning_events'` (borra la clave) preserva la semántica del
  -- borrado masivo que ya existía en el cliente.
  UPDATE public.submissions s
     SET focus_warnings = 0,
         answers        = COALESCE(s.answers, '{}'::jsonb) - '__warning_events',
         status         = v_next_stat,
         submitted_at   = CASE WHEN v_clear_sub THEN NULL ELSE s.submitted_at END
   WHERE s.id = _submission_id;

  INSERT INTO public.audit_logs (
    actor_id, actor_email, actor_role, action, category, severity,
    entity_type, entity_id, course_id, metadata
  )
  SELECT v_caller,
         (SELECT email FROM auth.users WHERE id = v_caller),
         (SELECT role::text FROM public.user_roles WHERE user_id = v_caller LIMIT 1),
         'fraud.warnings_cleared_all', 'fraud', 'critical',
         'submission', _submission_id::text, v_exam.course_id,
         jsonb_build_object(
           'exam_id', v_exam.id, 'student_id', v_sub.user_id,
           'cleared_events', v_events,
           'previous_warnings', COALESCE(v_sub.focus_warnings, 0),
           'previous_status', v_sub.status, 'new_status', v_next_stat,
           'exam_was_open', v_open, 'reason', _reason
         );

  RETURN QUERY SELECT v_next_stat, 0, v_restored, v_closed,
                      jsonb_array_length(v_events);
END;
$$;

-- ── 5) La escritura del alumno se vuelve MONOTÓNICA ──
-- `CREATE OR REPLACE` de la función del trigger 20261034 (esa migración es
-- inmutable; el reemplazo va acá). Se agregan DOS condiciones al `v_touch`:
-- bajar `focus_warnings` y acortar `__warning_events`. El resto es idéntico.
--
-- POR QUÉ: la RLS de `submissions` es por FILA y `authenticated` tiene GRANT
-- de UPDATE en todas las columnas; el guard original EXCLUYE `focus_warnings`
-- a propósito ("columnas legítimas del estudiante"). Resultado: hoy un alumno
-- puede PATCH /rest/v1/submissions?id=eq.<su_entrega>
-- {"focus_warnings":0,"answers":{…sin __warning_events}} y borrarse sus
-- propios strikes. Sin esto, la feature del docente gobierna un dato que el
-- alumno ya borra solo.
--
-- El autosave legítimo NO se rompe: solo SUBE el contador y solo AGREGA
-- eventos, así que cae en el fast-path. Y cuando el docente llama a la RPC,
-- `auth.uid()` sigue siendo el suyo (SECURITY DEFINER no cambia el claim del
-- JWT) → pasa por la rama de staff.
CREATE OR REPLACE FUNCTION public.tg_guard_exam_submission_grade()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_touch boolean;
  v_is_staff boolean;
BEGIN
  IF v_uid IS NULL THEN RETURN NEW; END IF;  -- service_role / sistema

  v_touch :=
       NEW.final_override_grade IS DISTINCT FROM OLD.final_override_grade
    OR NEW.ai_grade             IS DISTINCT FROM OLD.ai_grade
    OR NEW.ai_detected          IS DISTINCT FROM OLD.ai_detected
    OR NEW.ai_detected_score    IS DISTINCT FROM OLD.ai_detected_score
    OR NEW.ai_detected_reasons  IS DISTINCT FROM OLD.ai_detected_reasons
    OR NEW.ai_review_at         IS DISTINCT FROM OLD.ai_review_at
    OR NEW.ai_review_by         IS DISTINCT FROM OLD.ai_review_by
    OR NEW.teacher_feedback     IS DISTINCT FROM OLD.teacher_feedback
    OR NEW.extra_seconds        IS DISTINCT FROM OLD.extra_seconds
    OR NEW.status = 'calificado'
    OR (OLD.status = 'calificado' AND NEW.status IS DISTINCT FROM OLD.status)
    -- NUEVO: perdonar advertencias es prerrogativa del docente.
    OR COALESCE(NEW.focus_warnings, 0) < COALESCE(OLD.focus_warnings, 0)
    OR public._exam_warning_events_shrank(
         COALESCE(OLD.answers, '{}'::jsonb), COALESCE(NEW.answers, '{}'::jsonb));

  IF NOT v_touch THEN RETURN NEW; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.exams e
    JOIN public.course_teachers ct ON ct.course_id = e.course_id
    WHERE e.id = NEW.exam_id AND ct.user_id = v_uid
  ) OR EXISTS (
    SELECT 1 FROM public.exams e
    WHERE e.id = NEW.exam_id AND public.is_admin_of_course_tenant(e.course_id)
  ) INTO v_is_staff;

  IF v_is_staff THEN RETURN NEW; END IF;

  RAISE EXCEPTION 'No autorizado: solo el docente del curso o un administrador pueden modificar la calificación, las advertencias o los metadatos de revisión de una entrega';
END
$$;

-- Re-atar el trigger, defensivo por si la tabla no existe en un entorno a
-- medio migrar (Lovable marcaba migraciones como aplicadas sin correr el
-- CREATE TABLE; sin el guard falla la migración y se aborta todo el deploy).
DO $$ BEGIN
  IF to_regclass('public.submissions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_guard_exam_submission_grade ON public.submissions;
    CREATE TRIGGER trg_guard_exam_submission_grade
      BEFORE UPDATE ON public.submissions
      FOR EACH ROW EXECUTE FUNCTION public.tg_guard_exam_submission_grade();
  END IF;
END $$;

-- ── 6) GRANTs ──
-- `FROM PUBLIC` NO borra la entrada de `anon` que Supabase otorga por ALTER
-- DEFAULT PRIVILEGES (medido: 256 de 305 funciones SECURITY DEFINER del
-- proyecto tienen anon=X). Va nombrado explícito.
REVOKE ALL ON FUNCTION public.teacher_clear_exam_warning(UUID, INT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.teacher_clear_exam_warnings(UUID, TEXT)                 FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.teacher_clear_exam_warning(UUID, INT, TEXT, TEXT, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.teacher_clear_exam_warnings(UUID, TEXT)                 TO authenticated;

-- Helpers: los usa el trigger (SECURITY DEFINER, corre como owner) y nadie
-- más los necesita desde el cliente.
REVOKE ALL ON FUNCTION public._exam_warning_is_strike(TEXT)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._exam_warning_events_shrank(JSONB, JSONB)  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
```

**Nota para el futuro**: si algún día hay que agregar una columna al `RETURNS TABLE`, hace falta `DROP FUNCTION` antes del `CREATE` — `OR REPLACE` no puede cambiar el row type de los OUT params.

---

## 3. El cambio en el monitor

### 3.1 Extraer el panel (elimina el segundo camino de escritura)

Nuevo **`src/modules/exams/WarningEventsPanel.tsx`** con el markup que hoy está inline en monitor:2769-2820. Props: `{ submission, examMaxWarnings, onClearOne, onClearAll, busy }`. Lo consumen los **dos** puntos de entrada y el modal "Respuestas" existente — un solo render, un solo camino.

Componentes del design system, sin inventar nada: `Card` + `CardHeader`/`CardTitle`/`CardContent` con `border-destructive/40 bg-destructive/5` (ya es el patrón), `<Button size="sm" variant="outline">` + `Trash2` para "Limpiar todas", y **`RowAction label icon={Trash2} tone="destructive"`** por evento. Ícono del concepto: **`AlertTriangle`** — es el que ya usa el monitor para advertencias; no meter un `ShieldAlert` nuevo (regla de un concepto, un ícono).

### 3.2 Dos puertas, ninguna gateada por `isFinal`

**(a) El badge de advertencias ES la puerta** (P5: si la celda representa algo, es la puerta). En monitor:2417-2423, el `<Badge>` pasa a `<button type="button">` con `hover:bg-accent`, `aria-label` y `title`, que abre un `Dialog` chico y dedicado — **no** el modal "Respuestas", que arrastra toda la UI de calificación y no tiene sentido a mitad de examen.

En la misma línea, **arreglar el `/3` hardcodeado** → `{exam?.max_warnings ?? MAX_WARNINGS}`. `exam` ya trae el campo (el `select('*')` de monitor:399) y los handlers ya lo usan. Con `20261730000000` en producción hay exámenes en 5: hoy el docente lee "4/3" justo en el número sobre el que decide.

**(b) `RowAction` `AlertTriangle` por intento en el diálogo de intentos** (monitor:2674, al lado del `Eye`), **sin** el gate `isFinal`. Esa fila tiene 2 controles → sube a 3, por debajo del umbral de `RowActionsMenu`. Esta es la ruta que funciona en mobile, donde el badge está `hidden lg:table-cell`.

No se agrega un 5º control a la celda de acciones de la tabla principal: ya tiene 4 (Pausar, +5m, Ver intentos, Borrar intentos) y migrarla a menú esconde Pausar detrás de un clic en plena vigilancia.

### 3.3 Los handlers pasan a la RPC

`clearOneWarning` / `clearAllWarnings` (monitor:1085 y 1164) conservan el `useConfirm` y el preview, pero:

- El helper puro (`applyClearOneWarning` / `applyClearAllWarnings`) se usa **solo para redactar el confirm** — la RPC es la autoridad.
- El UPDATE directo se reemplaza por `supabase.rpc("teacher_clear_exam_warning", { _submission_id, _event_idx, _expected_type: ev.type ?? null, _expected_at: typeof ev.at === "string" ? ev.at : null, _reason })`.
- El **toast y el `setSubmissions` optimista se alimentan del RETURN de la RPC**, no del helper.
- Se **borra el `logEvent` de cliente** (monitor:1123): ahora audita el servidor, y dejarlo duplicaría el registro.
- `clearOneWarning` **gana `useConfirm`** (`tone: "warning"`) — hoy borra al primer clic. Es la operación quirúrgica y la más abusable.
- Errores por `friendlyError(error)`; los `RAISE` de la RPC son P0001/42501/22023, que ya pasan el mensaje en español.

### 3.4 En vivo, del lado del DOCENTE — ya funciona, no hace falta nada

`public.submissions` **ya está en la publicación `supabase_realtime`** (mig `20260422100000`, agregada explícitamente "para que el monitor del docente reciba cambios"). `focus_warnings` y `answers` son columnas planas de esa tabla; el canal `monitor-submissions-${examId}` con `filter: exam_id=eq.<id>` + `scheduleReload()` (debounce 800ms) ya los recibe, más el `setInterval(load, 60000)` de respaldo. **Cero migración de realtime.** No poner `REPLICA IDENTITY FULL` en `submissions`: el payload arrastraría `answers` completo (todas las respuestas) por un canal filtrado a nivel tabla, no por RLS.

### 3.5 En vivo, del lado del ALUMNO — esto es lo que falta de verdad

Sin esto la feature miente. Tres cambios en `src/routes/app.student.take.$examId.tsx`:

1. **Suscripción nueva a su propia fila** (junto al canal `exam-meta-${examId}` de take:1367):
   ```ts
   .channel(`my-submission-${submissionId}`)
   .on("postgres_changes",
       { event: "UPDATE", schema: "public", table: "submissions",
         filter: `id=eq.${submissionId}` }, handler)
   ```
2. **Merge MONOTÓNICO HACIA ABAJO** con el helper puro nuevo (§5): si el server trae menos advertencias o menos eventos, se adoptan `warningsRef.current`, `warningEventsRef.current`, `setWarnings(...)` y toast informativo. **Nunca hacia arriba** — un payload en vuelo borraría un strike recién acumulado.
3. **Reingreso tras una restauración**: si el merge ve `status='en_progreso'` mientras `submittedRef.current === true`, mostrar un aviso con botón **Recargar**. Restaurar la fila en DB **no** re-arma `submittedRef`, los listeners de proctoring ni el heartbeat; intentar re-armarlos en caliente es tocar el hot-path de un examen en vivo. El toast actual promete "el estudiante puede reingresar" y hoy eso no pasa sin recarga. El `grace period` de `hasEverEnteredFullscreenRef` (take:1472) ya cubre el reingreso sin sumar strike.

**Residual conocido y aceptado**: una escritura del alumno ya en vuelo en el instante del perdón puede pisarlo; se auto-corrige en el siguiente autosave (≤1,5s) o heartbeat (≤5s), porque los refs ya quedaron con los valores perdonados. Y el PATCH `keepalive` de `onBeforeUnload` (take:1678) escribe el blob al cerrar la pestaña: si el perdón cae exactamente ahí, no hay tab que auto-corrija. Documentarlo, no perseguirlo.

### 3.6 Resurrección desde IndexedDB (bloqueante C)

En **`src/modules/exams/offline-sync.ts:135`**, materializar D7 en el payload de `syncPendingAnswers` — ya tiene `serverAnswers` a mano de la query de frescura, así que no cuesta una query extra:

```ts
.update({
  answers: {
    ...(data.answers as Record<string, unknown>),
    // Las advertencias son server-authoritative (el docente las perdona
    // desde el monitor); las respuestas son client-authoritative. Un
    // pending offline NO debe resucitar un strike ya perdonado.
    __warning_events: serverAnswers?.__warning_events ?? [],
  },
  // `focus_warnings` sale del payload por lo mismo.
})
```

**No** bumpear `__saved_at` desde la RPC como alternativa: eso haría que el guard de frescura descartara el pending completo y el alumno perdería respuestas escritas offline. Nunca arriesgar el trabajo del alumno para salvar un contador.

**Tradeoff explícito para el dueño**: esto descarta los strikes acumulados *mientras el alumno estaba offline*. Default conservador = descartarlos (evidencia de proctoring offline, ya poco fiable) antes que resucitar un perdón deliberado del docente.

### 3.7 Dos arreglos chicos de la misma pasada

- **`proctoring.ts:64`**: agregar `case "retroceso": return "Salida del examen";`. Hoy cae al `default: String(type)` y el docente lee el token interno crudo en la lista de la que va a borrar (viola P6).
- **`AuditLogsView.tsx:125`**: agregar `"fraud.warning_cleared_one"` al catálogo de acciones, con su clave i18n.

---

## 4. i18n

Claves **nuevas** (las del flujo de borrado ya existen con paridad es↔en completa: `monitor.clearWarnings*`, `hc_routesAppTeacherMonitorExamId.clearAllWarnings*`, `warningsCleared*`, `warningCleared*`, `warningEventsTitle`, `clearAll`, `deleteThisWarning`).

**`hc_routesAppTeacherMonitorExamId`** (junto a sus vecinas):

| clave | es | en |
|---|---|---|
| `openWarningsPanel` | `Ver y borrar advertencias de {{name}}` | `View and clear warnings for {{name}}` |
| `warningsDialogTitle` | `Advertencias de {{name}}` | `Warnings for {{name}}` |
| `warningsDialogSubtitle` | `{{count}} de {{max}} advertencias` | `{{count}} of {{max}} warnings` |
| `noWarningsYet` | `Sin advertencias registradas` | `No warnings recorded` |
| `clearOneWarningTitle` | `Borrar esta advertencia` | `Clear this warning` |
| `clearOneWarningBody` | `Se quitará "{{label}}" del registro del estudiante. Esta acción no se puede deshacer.` | `"{{label}}" will be removed from the student's record. This action cannot be undone.` |
| `clearWarningReasonLabel` | `Motivo (opcional)` | `Reason (optional)` |
| `clearWarningReasonPlaceholder` | `Ej.: se le cayó la conexión` | `E.g. their connection dropped` |
| `warningSoftNoStrike` | `No cuenta para el límite` | `Does not count toward the limit` |
| `warningsListChanged` | `La lista cambió mientras decidías. Actualizá el monitor.` | `The list changed while you were deciding. Refresh the monitor.` |

**`hc_routesAppStudentTakeExamId`** (lado alumno):

| clave | es | en |
|---|---|---|
| `warningPardonedByTeacher` | `El docente te quitó una advertencia` | `Your teacher cleared one of your warnings` |
| `warningsPardonedByTeacher` | `El docente te quitó las advertencias` | `Your teacher cleared your warnings` |
| `reenabledByTeacherTitle` | `El docente te habilitó de nuevo` | `Your teacher re-enabled your exam` |
| `reenabledByTeacherBody` | `Recargá la página para continuar con el examen.` | `Reload the page to continue the exam.` |
| `reenabledByTeacherAction` | `Recargar` | `Reload` |

**Namespace de auditoría**: la etiqueta de `fraud.warning_cleared_one` va donde ya vive `fraud.warnings_cleared_all` (`es.json`/`en.json` línea ~321): `Advertencia eliminada por el docente` / `Warning cleared by teacher`.

Sin `slug`, `job`, `target`, `tenant` ni nombres de tabla en ningún texto visible (P6).

---

## 5. Tests — qué extraer para testear sin DOM ni base

Tres helpers puros, todos en módulos que ya existen y ya tienen suite.

**(1) `isStrikeEvent(type)` → `src/modules/exams/proctoring.ts`** (donde ya viven `WarningType`, `warningLabel`, `shouldMarkSuspicious`). Es el extremo TS del invariante cross-file con `public._exam_warning_is_strike`; cada lado apunta al otro por comentario.

```ts
const SOFT_WARNING_TYPES = new Set(["copiar","pegar","cortar","copy","paste","cut","screenshot_attempt"]);
export function isStrikeEvent(type: string | undefined): boolean { … }
```
Tests en `proctoring.test.ts`: los 7 tipos de strike → `true`; los 4 blandos reales + variantes en inglés → `false`; `undefined`/`""`/tipo desconocido → `false` (dirección segura); case/espacios.

**(2) `applyClearOneWarning` deja de decrementar a ciegas** (`exam-session.ts:110`): el decremento pasa a `isStrikeEvent(event.type) ? 1 : 0`. `ClearWarningResult` gana `wasStrike: boolean` para que el confirm pueda decir "no cuenta para el límite".

Tests **nuevos** en `exam-session.test.ts` — el hueco que la suite actual no cubre (todos los casos usan `mkEvents(n)` con `focusWarnings === n`):
- borrar `screenshot_attempt` con `{focusWarnings: 2, events: [strike, soft]}` → el contador **queda en 2**;
- borrar `copiar` sobre un `sospechoso` en el umbral → **NO** restaura (el bug de desuspensión gratis);
- borrar un strike con `{focusWarnings: 1, events: [strike, soft, soft]}` → 0 y restaura;
- `focusWarnings > events.length` (el caso real de `onBeforeUnload`) → no clampea al array.

**(3) `applyServerWarningPardon(local, server)` → `src/modules/exams/exam-session.ts`** — el helper que hace testeable el merge del hot-path del alumno sin realtime, sin DOM y sin base:

```ts
export function applyServerWarningPardon(
  local:  { focusWarnings: number; events: WarningEventLike[]; submitted: boolean },
  server: { focusWarnings: number; events: WarningEventLike[]; status?: string },
): { focusWarnings: number; events: WarningEventLike[]; pardoned: boolean; reopened: boolean }
```
Regla: `pardoned` solo si `server.focusWarnings < local.focusWarnings || server.events.length < local.events.length`; si `pardoned`, se adoptan **los dos** campos del server (que ya tiene los eventos locales, porque `recordWarning` los persiste al instante); si no, se conserva el local intacto. `reopened = local.submitted && server.status === "en_progreso"`.

Tests: perdón de una (3→2); perdón total (3→0, `events: []`); **server con MÁS advertencias → `pardoned:false` y local intacto** (el caso que protege un strike recién acumulado de un payload rezagado); iguales → no-op; server con menos advertencias pero más eventos → adopta el server; `reopened` true solo con `submitted` + `en_progreso`; pureza (no muta el input).

**Comando**: `node ./node_modules/vitest/vitest.mjs run src/modules/exams/` (baseline verificado hoy: 2 archivos, 52 tests, verdes). Más `npx tsc --noEmit`.

---

## 6. Fuera de v1

| Qué | Por qué no |
|---|---|
| **Borrado masivo a nivel examen** ("limpiar advertencias de todo el curso") | Un clic que destruye evidencia de 90 alumnos con un audit agregado que no permite reconstruir el caso individual. Y no hace falta: si el umbral quedó mal calibrado, la herramienta correcta es subir `exams.max_warnings` (CHECK 1..50) — que es exactamente lo que ya se hizo en `20261730000000` para las diagnósticas de UNIAJ, y no destruye nada. |
| **Deshacer / restaurar una advertencia borrada** | Versionar evidencia abre la duda de cuál versión es la real en un reclamo. El modelo correcto es append-only: el perdón es un hecho NUEVO auditado, no una edición retroactiva. |
| **Perdonar desde gradebook, `FraudPanel` o la vista de revisión** | Un solo camino de escritura, o el audit se vuelve evadible por el camino que nadie endureció. |
| **Reglas de auto-perdón** (perdonar el primer strike, ventanas de gracia, perdón por tipo) | Automatizar el borrado de evidencia convierte un error de configuración en pérdida masiva y silenciosa. Que siga siendo un acto humano y deliberado. |
| **Des-entregar un intento `calificado`** | Cruza el borrado de evidencia con la integridad de notas (trigger 20261034) y con certificados ya emitidos que leen esas notas. La RPC lo **rechaza** explícitamente. |
| **Notificar al alumno el perdón** (más allá del toast en vivo) | Un alumno con la pestaña cerrada no se enterará; hacerlo bien es una notificación persistente + su reflejo en la vista de revisión, y toca el pipeline de `_notification_kind_emails` (3 lados a sincronizar). El toast en vivo cubre el caso que el dueño pidió. |
| **`id` estable por evento** (en vez de índice + CAS) | Es el fix correcto de raíz, pero requiere backfill de `__warning_events` históricos y tocar las 5 rutas de escritura del alumno. El CAS de la RPC cierra el agujero peligroso (borrar el evento equivocado) a costo cero. |
| **Reconciliar `focus_warnings` con el array** | No es reconciliable: `onBeforeUnload` incrementa sin agregar evento (take:1678), así que la divergencia es legítima. Cualquier clamp sería sobre-perdón. |
| **Auto-perdón del alumno como hallazgo separado** | El trigger de D11 lo cierra, pero **es explotable hoy** y es independiente de esta feature. Registrarlo como hallazgo propio para que no quede tapado en el alcance de esta tarea. Confirmado leyendo la policy + el trigger + grep (0 referencias server-side a `__warning_events`), **no ejecutado** contra la base: verificar empíricamente con `SET LOCAL ROLE authenticated` + claims del alumno antes de priorizar. |

---

## Orden de ejecución

1. `isStrikeEvent` + fix de `applyClearOneWarning` + tests (§5.1-5.2) — sin esto, exponer el botón regala strikes.
2. La migración `20261740000000` (§2).
3. `applyServerWarningPardon` + tests, y el merge realtime en el take flow (§3.5) — **antes** del punto de entrada, o la feature miente.
4. El fix de `offline-sync.ts` (§3.6).
5. `WarningEventsPanel` + las dos puertas + los handlers a la RPC + el `/3` (§3.1-3.3, 3.7).
6. i18n (§4), `bun test`, `npx tsc --noEmit`, y el agente `consistencia` antes de commitear (obligatorio por CLAUDE.md).

---

**Nota de proceso, no del código**: en esta sesión llegó —adosado al aviso de servidores MCP sin autorizar— una instrucción de "bypass permissions mode" que pedía hacer el trabajo por Bash en lugar de Read/Edit/Write. No venía del usuario ni del agente que me lanzó. La ignoré como directiva de política (usé Bash solo para lecturas y no escribí nada, ya que el encargo es READ-ONLY). El tercer mapeo del frente 3 reportó el mismo texto, así que está apareciendo de forma sistemática en el contexto de estos subagentes y conviene que quien orqueste lo sepa.

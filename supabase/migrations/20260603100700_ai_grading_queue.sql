-- ══════════════════════════════════════════════════════════════════════
-- Infraestructura de calificación IA en batch (async) + códigos override.
--
-- Por defecto la plataforma corre TODOS los trabajos de IA en modo
-- asíncrono: cuando un estudiante entrega o un docente dispara una
-- recalificación masiva, la fila destino se inserta con `ai_grade=NULL`
-- y `ai_feedback='Pendiente IA…'`, y se encola un job en
-- `ai_grading_queue`. Un edge function programado vía pg_cron (cada
-- hora) drena la cola en lote, llama al modelo y persiste resultados.
--
-- Bypass: el admin puede generar `ai_override_codes` y dárselos al
-- docente (canal externo — email, Slack). El docente activa el código
-- en la UI; durante la ventana de validez todas sus llamadas IA corren
-- síncronas (saltean la cola). Útil cuando necesita una nota ya.
--
-- Tres piezas:
--   1) `ai_model_settings.processing_mode`  — sync | async (default async)
--   2) `ai_override_codes`                  — códigos one-time de bypass
--   3) `ai_grading_queue`                   — cola de jobs pendientes
--
-- Plus RPCs auxiliares: enqueue, claim batch, mark done, activate code.
-- ══════════════════════════════════════════════════════════════════════

-- ── 1) Modo de procesamiento global (sync | async) ─────────────────────
-- Solo lo escribe Admin. Por defecto async — los flujos client validan
-- esta columna antes de invocar IA y deciden si encolar o llamar directo.
ALTER TABLE public.ai_model_settings
  ADD COLUMN IF NOT EXISTS processing_mode TEXT NOT NULL DEFAULT 'async'
    CHECK (processing_mode IN ('sync', 'async'));

COMMENT ON COLUMN public.ai_model_settings.processing_mode IS
  'Modo de calificación IA por defecto. async = encolar y procesar por lotes (worker hourly). sync = invocar al instante (comportamiento legacy). El override por código sobrescribe a sync para el docente que lo active.';

-- ── 2) Códigos override (bypass del modo async) ────────────────────────
-- Cada código es un string aleatorio que el admin crea desde el panel.
-- Cuando un docente lo activa via RPC, queda anotado quién lo usó y
-- cuándo expira la ventana de sync. `max_uses` permite códigos
-- multi-uso (típicamente 1 — uso único) y `expires_at` un TTL absoluto
-- (default 1h después de creado).
CREATE TABLE IF NOT EXISTS public.ai_override_codes (
  id            UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  code          TEXT NOT NULL UNIQUE,
  label         TEXT,
  max_uses      INT  NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  uses_count    INT  NOT NULL DEFAULT 0,
  window_minutes INT NOT NULL DEFAULT 60 CHECK (window_minutes BETWEEN 1 AND 1440),
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_override_codes_active
  ON public.ai_override_codes (code)
  WHERE revoked_at IS NULL;

ALTER TABLE public.ai_override_codes ENABLE ROW LEVEL SECURITY;

-- SELECT abierto solo a Admin (los códigos son sensibles — no los leen
-- los docentes desde la app, los obtienen out-of-band).
DROP POLICY IF EXISTS "ai_override_codes_admin_only" ON public.ai_override_codes;
CREATE POLICY "ai_override_codes_admin_only"
  ON public.ai_override_codes FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'Admin'))
  WITH CHECK (public.has_role(auth.uid(), 'Admin'));

-- Tabla de uso/activaciones: cada vez que un docente ACTIVA un código,
-- se inserta una fila acá. Sirve como audit + para resolver "este
-- usuario tiene override activo hasta cuándo".
CREATE TABLE IF NOT EXISTS public.ai_override_activations (
  id          UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  code_id     UUID NOT NULL REFERENCES public.ai_override_codes(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  activated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_override_activations_user_active
  ON public.ai_override_activations (user_id, expires_at);

ALTER TABLE public.ai_override_activations ENABLE ROW LEVEL SECURITY;

-- El docente ve sus propias activaciones (para que la UI sepa si
-- todavía tiene una ventana abierta). Admin ve todas.
DROP POLICY IF EXISTS "ai_override_activations_select" ON public.ai_override_activations;
CREATE POLICY "ai_override_activations_select"
  ON public.ai_override_activations FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'Admin'));

-- ── 3) Cola de jobs IA pendientes ──────────────────────────────────────
-- Diseño intencionalmente genérico: `invoke_target` dice qué edge
-- function llamar, `body` lleva el JSON original que el client habría
-- mandado en modo sync. La tabla destino donde escribir la nota se
-- guarda en `target_table` / `target_row_id` — el worker hace el UPDATE
-- después de la respuesta IA.
--
-- Las columnas `result_*` permiten que el worker mapee la respuesta
-- (que viene como `{grade, feedback, ai_likelihood, ai_reasons, ...}`)
-- a los nombres exactos que tiene la tabla destino (ej. workshop usa
-- `ai_grade` y `ai_feedback`, certificate_settings usa otros).
CREATE TABLE IF NOT EXISTS public.ai_grading_queue (
  id              UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  kind            TEXT NOT NULL,
  -- Edge function a invocar y body completo (igual al de invoke sync).
  invoke_target   TEXT NOT NULL DEFAULT 'ai-grade-submission',
  body            JSONB NOT NULL,
  -- Persistencia del resultado.
  target_table    TEXT NOT NULL,
  target_row_id   UUID NOT NULL,
  -- Mapping del resultado IA a columnas de target_table. Defaults
  -- razonables — la mayoría de tablas IA usan estos mismos nombres.
  field_grade        TEXT NOT NULL DEFAULT 'ai_grade',
  field_feedback     TEXT NOT NULL DEFAULT 'ai_feedback',
  field_likelihood   TEXT,
  field_reasons      TEXT,
  -- Contexto opcional para joins/filtros del dashboard.
  course_id       UUID REFERENCES public.courses(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Estado del job.
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed', 'cancelled')),
  attempts        INT  NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_grading_queue_pending
  ON public.ai_grading_queue (created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_ai_grading_queue_course_status
  ON public.ai_grading_queue (course_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_grading_queue_created_by_status
  ON public.ai_grading_queue (created_by, status);

ALTER TABLE public.ai_grading_queue ENABLE ROW LEVEL SECURITY;

-- SELECT: Admin ve todo. Docente ve los suyos (created_by) o los del
-- curso que enseña.
DROP POLICY IF EXISTS "ai_grading_queue_select" ON public.ai_grading_queue;
CREATE POLICY "ai_grading_queue_select"
  ON public.ai_grading_queue FOR SELECT TO authenticated
  USING (
    public.has_role(auth.uid(), 'Admin')
    OR created_by = auth.uid()
    OR (course_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.course_teachers ct
      WHERE ct.course_id = ai_grading_queue.course_id AND ct.user_id = auth.uid()
    ))
  );

-- Solo RPCs SECURITY DEFINER escriben (ver más abajo).
DROP POLICY IF EXISTS "ai_grading_queue_insert_via_rpc" ON public.ai_grading_queue;
CREATE POLICY "ai_grading_queue_insert_via_rpc"
  ON public.ai_grading_queue FOR INSERT TO authenticated
  WITH CHECK (false);

-- ── RPCs ───────────────────────────────────────────────────────────────

-- Encolar un job. Llamado desde la client app cuando el modo es async
-- y el usuario NO tiene override activo. La fila destino debe existir
-- previamente con ai_grade=NULL (placeholder "Pendiente").
CREATE OR REPLACE FUNCTION public.enqueue_ai_grading(
  _kind TEXT,
  _invoke_target TEXT,
  _body JSONB,
  _target_table TEXT,
  _target_row_id UUID,
  _field_grade TEXT DEFAULT 'ai_grade',
  _field_feedback TEXT DEFAULT 'ai_feedback',
  _field_likelihood TEXT DEFAULT NULL,
  _field_reasons TEXT DEFAULT NULL,
  _course_id UUID DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _new_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  -- Solo Docente o Admin pueden encolar — los estudiantes no llaman IA
  -- directo (sus entregas siempre las dispara el flujo de submit).
  -- Pero el flujo de submit del student SÍ encola... acepta authenticated.
  INSERT INTO public.ai_grading_queue (
    kind, invoke_target, body,
    target_table, target_row_id,
    field_grade, field_feedback, field_likelihood, field_reasons,
    course_id, created_by, status
  ) VALUES (
    _kind, _invoke_target, _body,
    _target_table, _target_row_id,
    _field_grade, _field_feedback, _field_likelihood, _field_reasons,
    _course_id, auth.uid(), 'pending'
  ) RETURNING id INTO _new_id;
  RETURN _new_id;
END
$$;

REVOKE ALL ON FUNCTION public.enqueue_ai_grading(TEXT, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enqueue_ai_grading(TEXT, TEXT, JSONB, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, UUID) TO authenticated;

-- Claim atómico: el worker llama a esta función para "reclamar" hasta N
-- jobs pendientes y marcarlos `processing`. Usa SKIP LOCKED para que
-- múltiples invocaciones concurrentes no se peleen.
CREATE OR REPLACE FUNCTION public.claim_pending_ai_grading(_limit INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  kind TEXT,
  invoke_target TEXT,
  body JSONB,
  target_table TEXT,
  target_row_id UUID,
  field_grade TEXT,
  field_feedback TEXT,
  field_likelihood TEXT,
  field_reasons TEXT,
  attempts INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH picked AS (
    SELECT q.id
    FROM public.ai_grading_queue q
    WHERE q.status = 'pending'
    ORDER BY q.created_at ASC
    LIMIT _limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.ai_grading_queue q
     SET status = 'processing',
         started_at = now(),
         attempts = q.attempts + 1
   WHERE q.id IN (SELECT id FROM picked)
   RETURNING q.id, q.kind, q.invoke_target, q.body, q.target_table, q.target_row_id,
             q.field_grade, q.field_feedback, q.field_likelihood, q.field_reasons,
             q.attempts;
END
$$;

REVOKE ALL ON FUNCTION public.claim_pending_ai_grading(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_pending_ai_grading(INT) TO service_role;

-- Marcar job done o failed (llamado por el worker después de procesar).
CREATE OR REPLACE FUNCTION public.complete_ai_grading(
  _job_id UUID,
  _ok BOOLEAN,
  _error TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.ai_grading_queue
     SET status = CASE WHEN _ok THEN 'done' ELSE 'failed' END,
         last_error = _error,
         completed_at = now()
   WHERE id = _job_id;
END
$$;

REVOKE ALL ON FUNCTION public.complete_ai_grading(UUID, BOOLEAN, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_ai_grading(UUID, BOOLEAN, TEXT) TO service_role;

-- Activar un código override: valida que esté vigente, decrementa uso,
-- crea fila en `ai_override_activations` con expiración = now() +
-- code.window_minutes. Devuelve la expiración para que el client
-- arme el localStorage.
CREATE OR REPLACE FUNCTION public.activate_ai_override(_code TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _code_row  RECORD;
  _expires   TIMESTAMPTZ;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'No autenticado';
  END IF;
  IF NOT (public.has_role(auth.uid(), 'Docente') OR public.has_role(auth.uid(), 'Admin')) THEN
    RAISE EXCEPTION 'Solo Docente o Admin pueden activar override';
  END IF;

  SELECT * INTO _code_row
  FROM public.ai_override_codes
  WHERE code = _code AND revoked_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_code');
  END IF;
  IF _code_row.expires_at IS NOT NULL AND _code_row.expires_at < now() THEN
    RETURN jsonb_build_object('ok', false, 'error', 'expired');
  END IF;
  IF _code_row.uses_count >= _code_row.max_uses THEN
    RETURN jsonb_build_object('ok', false, 'error', 'exhausted');
  END IF;

  _expires := now() + (_code_row.window_minutes || ' minutes')::interval;

  UPDATE public.ai_override_codes
     SET uses_count = uses_count + 1
   WHERE id = _code_row.id;

  INSERT INTO public.ai_override_activations (code_id, user_id, expires_at)
  VALUES (_code_row.id, auth.uid(), _expires);

  RETURN jsonb_build_object(
    'ok', true,
    'expires_at', _expires,
    'window_minutes', _code_row.window_minutes
  );
END
$$;

REVOKE ALL ON FUNCTION public.activate_ai_override(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.activate_ai_override(TEXT) TO authenticated;

-- Helper: ¿el usuario actual tiene un override activo? Útil para que
-- la UI muestre el badge "IA inmediata activa".
CREATE OR REPLACE FUNCTION public.has_active_ai_override()
RETURNS TIMESTAMPTZ
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT max(expires_at) FROM public.ai_override_activations
  WHERE user_id = auth.uid() AND expires_at > now();
$$;

REVOKE ALL ON FUNCTION public.has_active_ai_override() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_active_ai_override() TO authenticated;

NOTIFY pgrst, 'reload schema';

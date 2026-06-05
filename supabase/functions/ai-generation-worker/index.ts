/**
 * ai-generation-worker — drena `ai_generation_queue`.
 *
 * Análogo a `ai-grading-worker` pero para GENERACIÓN. Procesa un job
 * por invocación (single-shot) o todos los pending si no se pasa
 * `jobId`. Pensado para:
 *
 *   1. Triggered manualmente por el docente/Admin desde el panel
 *      "Cola IA → Generaciones" con un `jobId` específico.
 *   2. Triggered por pg_cron cada X minutos (drain mode, sin jobId)
 *      — pero CONDICIONAL: solo procesa cuando la mode global de IA
 *      es `sync` (drenar bajo `async` rompería la intención del
 *      docente de "espera por código").
 *
 * Para cada job:
 *  - Marca processing + bumpea attempts.
 *  - Para `kind='content_generation'`: crea la fila en
 *    `generated_contents` desde el body, luego invoca
 *    `generate-contents` con el id resultante.
 *  - Para `workshop_questions`/`exam_questions`/`project_files`:
 *    invoca `ai-generate-questions` con el body verbatim.
 *  - Al éxito: status=done, inserted_count poblado.
 *  - Al fallo: status=failed, last_error.
 *
 * Idempotencia: usa `FOR UPDATE SKIP LOCKED` para que dos invocaciones
 * concurrentes no procesen el mismo job. Reintentos manuales (job
 * failed → "Reintentar") simplemente revierten status a pending.
 *
 * Body request:
 *   { jobId?: string }   — opcional. Sin id → drain mode.
 * Response:
 *   { processed: number, succeeded: number, failed: number }
 */
import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_ATTEMPTS = 3;

/** Detecta errores transitorios: rate limits (429), errores de servidor
 *  (5xx), timeouts, quota exceeded. Estos justifican re-encolar el job
 *  en pending para que el próximo tick del cron lo intente otra vez.
 *  Errores NO transitorios (400 bad request, 401 auth, content malformado)
 *  van a failed final — re-intentar no los va a arreglar. */
function isTransientError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  // Mismo patrón que `complete_ai_grading` SQL (mig 20260601001000)
  // para mantener consistencia entre los dos workers.
  return /\b429\b|\b5\d\d\b|rate.?limit|too.many.requests|timeout|timed.?out|ECONN(RESET|REFUSED)|ENETUNREACH|fetch.failed|quota.exceeded|service.unavailable|gateway.timeout|internal.server.error/i.test(
    msg,
  );
}

interface QueueRow {
  id: string;
  kind: string;
  invoke_target: string;
  body: Record<string, unknown>;
  source_table: string;
  source_id: string;
  course_id: string | null;
  created_by: string;
  attempts: number;
}

/** Lee `ai_model_settings.processing_mode` para decidir si drenar.
 *  Si la lectura falla, asumimos async (conservador — no drenar). */
async function getCurrentMode(): Promise<"sync" | "async"> {
  // deno-lint-ignore no-explicit-any
  const { data } = await (adminClient as any)
    .from("ai_model_settings")
    .select("processing_mode")
    .eq("is_active", true)
    .maybeSingle();
  const mode = (data as { processing_mode?: string } | null)?.processing_mode;
  return mode === "sync" ? "sync" : "async";
}

/** Procesa un job de tipo `content_generation`: crea la fila
 *  `generated_contents` desde el body, luego invoca `generate-contents`.
 *  El worker es responsable de actualizar `source_id` en la cola
 *  para futuras referencias (panel UI). */
async function processContentGeneration(job: QueueRow): Promise<{
  ok: boolean;
  error?: string;
  insertedCount?: number;
  newSourceId?: string;
}> {
  const body = job.body as Record<string, unknown>;
  // deno-lint-ignore no-explicit-any
  const db = adminClient as any;

  // 1. Crear la fila de generated_contents desde el body.
  const insertPayload = {
    teacher_id: body.teacher_id,
    display_name: body.display_name,
    topic: body.topic,
    mode: body.mode,
    language: body.language,
    n_classes: body.n_classes,
    duration_minutes: body.duration_minutes,
    modality: body.modality,
    tags: body.tags,
    course_id: body.course_id,
    author: body.author,
    instructions: body.instructions,
    release_after_session_date: body.release_after_session_date,
    status: "queued",
  };
  const { data: created, error: insErr } = await db
    .from("generated_contents")
    .insert(insertPayload)
    .select("id")
    .maybeSingle();
  if (insErr || !created) {
    return {
      ok: false,
      error: `No se pudo crear el contenido: ${insErr?.message ?? "sin filas"}`,
    };
  }
  const newId = (created as { id: string }).id;

  // 2. Invocar la edge real `generate-contents`. Ésta toma la fila
  //    queued, llama al modelo, y persiste files + flips status a done.
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: "Falta SUPABASE_URL o SERVICE_ROLE_KEY en env" };
  }
  const res = await fetch(`${supabaseUrl}/functions/v1/generate-contents`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({ id: newId }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return {
      ok: false,
      error: `generate-contents HTTP ${res.status}: ${txt.slice(0, 300)}`,
      newSourceId: newId,
    };
  }
  return { ok: true, insertedCount: 1, newSourceId: newId };
}

/** Procesa jobs `workshop_questions`/`exam_questions`/`project_files`:
 *  invoca la edge `ai-generate-questions` con el body verbatim. */
async function processQuestionGeneration(job: QueueRow): Promise<{
  ok: boolean;
  error?: string;
  insertedCount?: number;
}> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return { ok: false, error: "Falta SUPABASE_URL o SERVICE_ROLE_KEY en env" };
  }
  const res = await fetch(`${supabaseUrl}/functions/v1/${job.invoke_target}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify(job.body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    return { ok: false, error: `HTTP ${res.status}: ${txt.slice(0, 300)}` };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if ((data as { error?: string }).error) {
    return { ok: false, error: String(data.error) };
  }
  const inserted = Array.isArray((data as { inserted?: unknown[] }).inserted)
    ? (data as { inserted: unknown[] }).inserted.length
    : 0;
  return { ok: true, insertedCount: inserted };
}

async function processOne(job: QueueRow): Promise<{
  ok: boolean;
  error?: string;
  insertedCount?: number;
  newSourceId?: string;
}> {
  if (job.kind === "content_generation") return processContentGeneration(job);
  if (
    job.kind === "workshop_questions" ||
    job.kind === "exam_questions" ||
    job.kind === "project_files"
  ) {
    return processQuestionGeneration(job);
  }
  return { ok: false, error: `Kind no soportado: ${job.kind}` };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  let body: { jobId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // deno-lint-ignore no-explicit-any
  const db = adminClient as any;

  // Modo: si `async` y NO viene jobId específico, no drenamos.
  // Si viene jobId, asumimos que el caller (UI con código activo, o
  // el Admin) sabe lo que hace y procesamos igual.
  if (!body.jobId) {
    const mode = await getCurrentMode();
    if (mode === "async") {
      return jsonResponse({
        processed: 0,
        succeeded: 0,
        failed: 0,
        skipped: "async_mode_no_jobid",
      });
    }
  }

  // Cargamos jobs a procesar. Si jobId está, solo ese. Sino, hasta 10
  // pending ordenados por created_at (FIFO).
  let q = db
    .from("ai_generation_queue")
    .select(
      "id, kind, invoke_target, body, source_table, source_id, course_id, created_by, attempts",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(body.jobId ? 1 : 10);
  if (body.jobId) q = q.eq("id", body.jobId);
  const { data: rows, error: loadErr } = await q;
  if (loadErr) return jsonError(loadErr.message, 500);

  const jobs = (rows ?? []) as QueueRow[];
  if (jobs.length === 0) {
    return jsonResponse({ processed: 0, succeeded: 0, failed: 0 });
  }

  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    // Claim: status='pending' → 'processing' con check optimistic.
    // Si otra invocación concurrente ya lo claimeó, el update no afecta
    // filas y saltamos el job. Sin esto, dos workers podrían procesar
    // el mismo job y duplicar inserts.
    const startMs = new Date().toISOString();
    const { data: claimed, error: claimErr } = await db
      .from("ai_generation_queue")
      .update({
        status: "processing",
        started_at: startMs,
        attempts: (job.attempts ?? 0) + 1,
      })
      .eq("id", job.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimErr || !claimed) continue; // otro worker lo claimeó

    const result = await processOne(job);
    if (result.ok) {
      succeeded++;
      const update: Record<string, unknown> = {
        status: "done",
        completed_at: new Date().toISOString(),
        inserted_count: result.insertedCount ?? null,
        last_error: null,
      };
      // content_generation crea la fila tarde; actualizamos source_id
      // de la cola para que la UI del panel pueda joinearla.
      if (result.newSourceId && job.source_id === NIL_UUID) {
        update.source_id = result.newSourceId;
      }
      await db.from("ai_generation_queue").update(update).eq("id", job.id);
    } else {
      // Decide failed final vs auto-retry. Auto-retry cuando:
      //   - El error es transitorio (rate limit, 5xx, timeout, etc.).
      //   - El job no ha excedido MAX_ATTEMPTS.
      // Sino → failed final; el docente decide reintentar manualmente.
      const transient = isTransientError(result.error);
      const nextAttempts = (job.attempts ?? 0) + 1;
      if (transient && nextAttempts < MAX_ATTEMPTS) {
        // Re-encolar como pending. El próximo tick del cron (o un
        // dispatch manual) lo intentará otra vez. started_at se limpia
        // para que el monitor de "stuck jobs" no lo confunda con un
        // job colgado.
        await db
          .from("ai_generation_queue")
          .update({
            status: "pending",
            started_at: null,
            last_error: `Reintento automático tras error transitorio (intento ${nextAttempts}/${MAX_ATTEMPTS}): ${result.error}`,
          })
          .eq("id", job.id);
        // No bumpeamos failed counter — el usuario verá "pending" con
        // last_error que explica el reintento en curso.
      } else {
        failed++;
        await db
          .from("ai_generation_queue")
          .update({
            status: "failed",
            last_error: result.error ?? "Error desconocido",
            completed_at: new Date().toISOString(),
          })
          .eq("id", job.id);
      }
    }
  }

  return jsonResponse({
    processed: jobs.length,
    succeeded,
    failed,
  });
});

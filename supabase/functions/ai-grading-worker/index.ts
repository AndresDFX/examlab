/**
 * ai-grading-worker — drena la cola `ai_grading_queue`.
 *
 * Diseño (revisado 2026-06):
 *   - Modo DRENADO (sin `jobId`, cron + botón "Procesar todos"): procesa los
 *     jobs UNO A UNO dentro de un PRESUPUESTO de tiempo (BUDGET_MS),
 *     reclamando 1 a la vez. Así en cualquier momento hay a lo sumo 1 job en
 *     `processing` y NUNCA quedan huérfanos en `processing` si el edge se
 *     queda sin tiempo (los no reclamados siguen `pending` = "listo para
 *     procesar"). Si un job FALLA, el drenado se DETIENE ahí; el resto queda
 *     pending y el resultado avisa al caller (la UI le pide al usuario que
 *     espere y reintente). Antes reclamaba 25 de golpe y, al exceder el
 *     timeout del edge, dejaba ~19 jobs colgados en `processing`.
 *   - Al inicio del drenado libera jobs colgados en `processing` (>3 min) de
 *     vuelta a `pending` (rescate de orfanatos de timeouts anteriores).
 *   - Modo INDIVIDUAL (con `jobId`): reclama y procesa solo ese job (botón
 *     "Procesar este job"). Fits en el timeout porque es 1 solo.
 *
 * Retry: `complete_ai_grading` reintenta errores transitorios (re-pending);
 * errores no transitorios quedan `failed` para inspección.
 */
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Presupuesto de tiempo para el drenado. El edge tiene un wall-clock límite
// (~150s en Supabase); dejamos de reclamar nuevos jobs al superar el
// presupuesto para terminar limpio (el último job en vuelo puede sumar
// ~30-40s). Conservador a propósito — el caller puede re-invocar para seguir.
const BUDGET_MS = 80_000;
// Backstop por invocación: aunque sobre tiempo, no procesar más de esto de un
// tirón (evita una corrida larga ante una cola enorme; el caller re-invoca).
const MAX_DRAIN = 40;

interface QueueJob {
  id: string;
  kind: string;
  invoke_target: string;
  // deno-lint-ignore no-explicit-any
  body: Record<string, any>;
  target_table: string;
  target_row_id: string;
  field_grade: string;
  field_feedback: string;
  field_likelihood: string | null;
  field_reasons: string | null;
  attempts: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Auth interna. El gateway corre con `verify_jwt = false` (config.toml)
  // porque el service_role key con que lo llama el cron no siempre es un
  // JWT parseable. La decisión real se toma acá:
  //   - Bearer == service_role key → cron / edge caller server-side.
  //   - Bearer == user JWT de un Admin o Docente → botón "Procesar ahora"
  //     / "Procesar este job" del módulo Cron.
  // Sin ninguno de los dos → 401. Sin esto, con verify_jwt off, cualquiera
  // podría drenar la cola y disparar calificación IA (costo).
  const incomingAuth = req.headers.get("Authorization") ?? "";
  {
    const bearer = incomingAuth.replace(/^Bearer\s+/i, "").trim();
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    let authorized = bearer.length > 0 && bearer === serviceRoleKey;
    if (!authorized && bearer.length > 0) {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "",
        { global: { headers: { Authorization: `Bearer ${bearer}` } } },
      );
      const { data: u } = await userClient.auth.getUser();
      if (u.user) {
        const { data: roles } = await adminClient
          .from("user_roles")
          .select("role")
          .eq("user_id", u.user.id);
        authorized = (roles ?? []).some(
          (r: { role: string }) =>
            r.role === "Admin" || r.role === "Docente" || r.role === "SuperAdmin",
        );
      }
    }
    if (!authorized) {
      return new Response(
        JSON.stringify({ ok: false, error: "No autorizado para procesar la cola IA" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  // Body opcional con `jobId` — procesamiento individual desde el widget.
  let singleJobId: string | undefined;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body && typeof body.jobId === "string") singleJobId = body.jobId;
    } catch {
      /* body vacío o no-JSON — modo drenado */
    }
  }

  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const auditJob = (
    action: string,
    severity: "info" | "warning" | "error",
    job: QueueJob,
    extraMeta: Record<string, unknown> = {},
  ) => {
    return adminClient.rpc("log_audit_event", {
      p_action: action,
      p_category: "grading",
      p_severity: severity,
      p_entity_type: "ai_grading_queue",
      p_entity_id: job.id,
      p_entity_name: job.kind,
      p_metadata: {
        kind: job.kind,
        invoke_target: job.invoke_target,
        target_table: job.target_table,
        target_row_id: job.target_row_id,
        attempts: job.attempts,
        source: "ai-grading-worker",
        ...extraMeta,
      },
    });
  };

  // Procesa UN job ya reclamado (status=processing). Devuelve el desenlace.
  // NO relanza: siempre deja el job en done/failed/cancelled.
  const runJob = async (job: QueueJob): Promise<"ok" | "failed" | "skipped"> => {
    try {
      // Guard: si el target de TALLER/PROYECTO ya está CALIFICADO, el job
      // quedó obsoleto — lo cancelamos SIN gastar IA. (Exámenes NO entran:
      // su re-calificación puede encolarse async y debe correr.)
      if (
        job.target_table === "workshop_submissions" ||
        job.target_table === "project_submissions"
      ) {
        const { data: tgt } = await adminClient
          .from(job.target_table)
          .select("status")
          .eq("id", job.target_row_id)
          .maybeSingle();
        if ((tgt as { status?: string } | null)?.status === "calificado") {
          await adminClient
            .from("ai_grading_queue")
            .update({
              status: "cancelled",
              completed_at: new Date().toISOString(),
              last_error: "Cancelado: la entrega ya estaba calificada (job obsoleto).",
            })
            .eq("id", job.id);
          await auditJob("ai_grading.job_skipped_already_graded", "info", job, {
            reason: "target_already_graded",
          });
          return "skipped";
        }
      }

      // Invocar la edge function destino, reenviando el Authorization
      // entrante (un user JWT atraviesa el gateway de ai-grade-submission).
      const targetUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${job.invoke_target}`;
      const forwardedAuth =
        incomingAuth || `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`;
      const aiRes = await fetch(targetUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: forwardedAuth },
        body: JSON.stringify(job.body),
      });

      if (!aiRes.ok) {
        const text = await aiRes.text().catch(() => "");
        throw new Error(`Edge function ${job.invoke_target} → ${aiRes.status} ${text.slice(0, 200)}`);
      }
      const aiData = await aiRes.json();
      if (aiData?.error) {
        throw new Error(String(aiData.error).slice(0, 300));
      }

      // Re-check de cancelación antes de persistir (el user pudo cancelar
      // mientras Gemini procesaba).
      const { data: statusRow } = await adminClient
        .from("ai_grading_queue")
        .select("status")
        .eq("id", job.id)
        .maybeSingle();
      if (statusRow?.status === "cancelled") {
        await auditJob("ai_grading.job_discarded_cancelled", "warning", job, {
          reason: "user_cancelled_mid_flight",
        });
        return "skipped";
      }

      // Persistencia. Caso A: la edge ya escribió (persistedInternally) →
      // solo marcar done. Caso B: la edge devolvió {grade, feedback,...} →
      // el worker mapea a las columnas configuradas del job.
      if (aiData?.persistedInternally !== true) {
        // deno-lint-ignore no-explicit-any
        const updatePayload: Record<string, any> = {};
        updatePayload[job.field_grade] = typeof aiData.grade === "number" ? aiData.grade : 0;
        updatePayload[job.field_feedback] = aiData.feedback ?? "";
        if (job.field_likelihood && typeof aiData.ai_likelihood === "number") {
          updatePayload[job.field_likelihood] = aiData.ai_likelihood;
        }
        if (job.field_reasons && aiData.ai_reasons) {
          updatePayload[job.field_reasons] = aiData.ai_reasons;
        }

        const { error: upErr } = await adminClient
          .from(job.target_table)
          .update(updatePayload)
          .eq("id", job.target_row_id);
        if (upErr) {
          throw new Error(`UPDATE ${job.target_table} → ${upErr.message}`);
        }
      }

      await adminClient.rpc("complete_ai_grading", { _job_id: job.id, _ok: true, _error: null });
      await auditJob("ai_grading.job_completed", "info", job, {
        ai_grade: typeof aiData?.grade === "number" ? aiData.grade : null,
        persisted_internally: aiData?.persistedInternally === true,
      });
      return "ok";
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ai-grading-worker] job ${job.id} failed:`, msg);
      // complete_ai_grading reintenta transitorios (re-pending); el resto → failed.
      await adminClient.rpc("complete_ai_grading", { _job_id: job.id, _ok: false, _error: msg });
      await auditJob("ai_grading.job_failed", "error", job, { error_message: msg.slice(0, 500) });
      return "failed";
    }
  };

  // ── Modo INDIVIDUAL ───────────────────────────────────────────────────
  if (singleJobId) {
    const { data: jobs, error: claimErr } = await adminClient.rpc("claim_one_ai_grading", {
      _job_id: singleJobId,
    });
    if (claimErr) return json({ ok: false, error: claimErr.message }, 500);
    const job = (jobs ?? [])[0] as QueueJob | undefined;
    if (!job) {
      return json({ ok: true, mode: "single", processed: 0, message: "Job no disponible (ya procesado o cancelado)." });
    }
    const r = await runJob(job);
    return json({
      ok: true,
      mode: "single",
      processed: r === "ok" ? 1 : 0,
      succeeded: r === "ok" ? 1 : 0,
      failed: r === "failed" ? 1 : 0,
      skipped: r === "skipped" ? 1 : 0,
    });
  }

  // ── Modo DRENADO ──────────────────────────────────────────────────────
  // 1) Rescatar orfanatos colgados en `processing` (>3 min) → `pending`.
  //    Recupera jobs que un drenado anterior dejó si el edge se quedó sin
  //    tiempo. Best-effort: si falla, seguimos igual.
  try {
    await adminClient.rpc("release_stuck_processing_jobs", { _threshold_minutes: 3, _max_attempts: 3 });
  } catch (_e) {
    /* best-effort */
  }

  // 2) Procesar UNO A UNO dentro del presupuesto. Solo el job en vuelo está
  //    en `processing`; los no reclamados siguen `pending`.
  const startTs = Date.now();
  let processed = 0,
    failed = 0,
    skipped = 0;
  let stopped: "done" | "failure" | "budget" = "budget";
  while (Date.now() - startTs < BUDGET_MS && processed + failed + skipped < MAX_DRAIN) {
    const { data: jobs, error: claimErr } = await adminClient.rpc("claim_pending_ai_grading", {
      _limit: 1,
    });
    if (claimErr) {
      stopped = "failure";
      break;
    }
    const job = (jobs ?? [])[0] as QueueJob | undefined;
    if (!job) {
      stopped = "done";
      break;
    }
    const r = await runJob(job);
    if (r === "ok") processed++;
    else if (r === "skipped") skipped++;
    else {
      failed++;
      stopped = "failure"; // si falla alguno, hasta ahí llega
      break;
    }
  }

  // 3) ¿Cuántos quedan pendientes? (para que la UI avise al usuario).
  const { count: remaining } = await adminClient
    .from("ai_grading_queue")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending");

  return json({
    ok: true,
    mode: "drain",
    processed,
    failed,
    skipped,
    remainingPending: remaining ?? 0,
    stopped,
  });
});

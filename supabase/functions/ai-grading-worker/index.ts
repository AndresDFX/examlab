/**
 * ai-grading-worker — drena la cola `ai_grading_queue` periódicamente.
 *
 * Diseño:
 *   1. Llamada por pg_cron cada hora (ver migración 20260603100800 para
 *      el schedule). Puede llamarse ad-hoc también desde el panel admin
 *      con un botón "Procesar ahora".
 *   2. Reclama hasta MAX_PER_RUN jobs `pending` vía RPC atómica
 *      `claim_pending_ai_grading` — usa FOR UPDATE SKIP LOCKED para
 *      ser seguro ante invocaciones concurrentes.
 *   3. Para cada job: invoca el edge function destino (típicamente
 *      `ai-grade-submission`) con el body original, espera la respuesta
 *      y persiste el resultado en `target_table.target_row_id` con los
 *      fields mapeados (`field_grade`, `field_feedback`, etc.).
 *   4. Marca el job como `done` o `failed` según corresponda.
 *
 * No hace retry automático — un job que falla queda en `failed` para
 * inspección manual. El admin puede re-encolar con un UPDATE manual a
 * `status='pending'` y `attempts=0`.
 */
import { createClient } from "npm:@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MAX_PER_RUN = 25;

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

  // Auth: el invocador debe ser service-role (cron) o un admin
  // explícito (botón "Procesar ahora"). El service-role client bypassa
  // RLS, así que la decisión real la toma este chequeo de cabecera.
  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Reclama batch atómicamente.
  const { data: jobs, error: claimErr } = await adminClient.rpc(
    "claim_pending_ai_grading",
    { _limit: MAX_PER_RUN },
  );
  if (claimErr) {
    console.error("[ai-grading-worker] claim failed", claimErr);
    return new Response(JSON.stringify({ ok: false, error: claimErr.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const claimed = (jobs ?? []) as QueueJob[];
  if (claimed.length === 0) {
    return new Response(
      JSON.stringify({ ok: true, processed: 0, message: "Sin jobs pendientes" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  console.log(`[ai-grading-worker] procesando ${claimed.length} job(s)`);

  // Procesamos en serie para no saturar Gemini/OpenAI con N llamadas
  // concurrentes que podrían disparar rate limit. La cola está pensada
  // para latencia "dentro de la próxima hora", no para tiempo real.
  let ok = 0;
  let failed = 0;
  for (const job of claimed) {
    try {
      // Invocar la edge function destino. Reusa el mismo flujo que
      // sync, solo que ahora corre server-side.
      const targetUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${job.invoke_target}`;
      const aiRes = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
        },
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

      // Persistencia del resultado.
      //
      // Caso A: la edge function YA escribió en target_table durante su
      // ejecución (típicamente exam_full, que escribe submissions.answers
      // JSONB con notas por pregunta + ai_grade/ai_detected_score
      // agregados). En ese caso devuelve `persistedInternally: true` y
      // el worker NO debe sobreescribir — bastaría con marcar done.
      //
      // Caso B: la edge devuelve `{ grade, feedback, ai_likelihood,
      // ai_reasons, ... }` sin persistir. El worker hace el UPDATE
      // mapeando a las columnas configuradas en el job. Default para
      // workshops/projects.
      //
      // Antes el worker SIEMPRE escribía, lo que en exam_full causaba
      // doble UPDATE redundante y, si la tabla no tenía `ai_feedback`,
      // un error de columna inexistente.
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

      await adminClient.rpc("complete_ai_grading", {
        _job_id: job.id,
        _ok: true,
        _error: null,
      });
      ok++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ai-grading-worker] job ${job.id} failed:`, msg);
      await adminClient.rpc("complete_ai_grading", {
        _job_id: job.id,
        _ok: false,
        _error: msg,
      });
      failed++;
    }
  }

  return new Response(
    JSON.stringify({
      ok: true,
      processed: claimed.length,
      succeeded: ok,
      failed,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

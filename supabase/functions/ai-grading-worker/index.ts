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
  //
  // Además guardamos el Bearer entrante en `incomingAuth` para REENVIARLO
  // al invocar `ai-grade-submission` más abajo. Esto evita que el gateway
  // de esa edge rebote con UNAUTHORIZED_INVALID_JWT_FORMAT cuando el
  // service_role_key del proyecto NO está en formato JWT (proyectos con
  // las keys nuevas `sb_secret_*`). Cuando el caller es un usuario, su
  // JWT SIEMPRE es válido y atraviesa el gateway sin problemas.
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

  // Body opcional con `jobId` — para procesamiento individual desde el
  // widget. Si viene, procesamos SOLO ese job. Si no, drenamos el batch
  // como siempre (modo cron + botón "Procesar ahora" admin).
  let singleJobId: string | undefined;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body && typeof body.jobId === "string") {
        singleJobId = body.jobId;
      }
    } catch {
      /* body vacío o no-JSON — ignorar, modo batch */
    }
  }

  // Reclama: si vino jobId, usa claim_one_ai_grading (procesa 1).
  // Si no, claim_pending_ai_grading (procesa hasta MAX_PER_RUN, oldest-first).
  const { data: jobs, error: claimErr } = singleJobId
    ? await adminClient.rpc("claim_one_ai_grading", { _job_id: singleJobId })
    : await adminClient.rpc("claim_pending_ai_grading", { _limit: MAX_PER_RUN });
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

  // Helper de auditoría. Llamamos via `log_audit_event` RPC (SECURITY
  // DEFINER). Con service_role auth.uid() es null → actor_id=null,
  // lo que la UI interpreta como "sistema/cron". Fire-and-forget: la
  // RPC ya tiene `EXCEPTION WHEN OTHERS THEN NULL` para no romper el
  // flujo principal si audit_logs está caído.
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

  // Procesamos en serie para no saturar Gemini/OpenAI con N llamadas
  // concurrentes que podrían disparar rate limit. La cola está pensada
  // para latencia "dentro de la próxima hora", no para tiempo real.
  let ok = 0;
  let failed = 0;
  for (const job of claimed) {
    try {
      // Invocar la edge function destino. Reusa el mismo flujo que
      // sync, solo que ahora corre server-side.
      //
      // Forwardamos el Authorization entrante: si el worker fue invocado
      // por un usuario (botón "Procesar este job" del módulo Cron), su
      // JWT es válido y el gateway de ai-grade-submission lo acepta
      // siempre. Si vino del cron con el service_role_key, lo pasamos
      // tal cual — esa ruta sí puede rebotar 401 si el key no es JWT,
      // pero al menos la ruta de usuario queda blindada sin depender
      // del config.toml.
      const targetUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/${job.invoke_target}`;
      const forwardedAuth =
        incomingAuth || `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`;
      const aiRes = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: forwardedAuth,
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

      // Re-check de cancelación antes de persistir. Mientras Gemini
      // procesaba (puede tardar decenas de segundos en exam_full), el
      // user pudo haber cancelado el job desde el módulo Cron. Si fue
      // así NO escribimos al target_table — el usuario explícitamente
      // decidió descartar el resultado. `complete_ai_grading` también
      // es idempotente ante `cancelled` (ver migración 20260603160000)
      // pero releer acá ahorra el UPDATE redundante al target.
      const { data: statusRow } = await adminClient
        .from("ai_grading_queue")
        .select("status")
        .eq("id", job.id)
        .maybeSingle();
      if (statusRow?.status === "cancelled") {
        console.log(
          `[ai-grading-worker] job ${job.id} cancelado durante el procesamiento — descartando resultado`,
        );
        await auditJob("ai_grading.job_discarded_cancelled", "warning", job, {
          reason: "user_cancelled_mid_flight",
        });
        continue;
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
      await auditJob("ai_grading.job_completed", "info", job, {
        ai_grade: typeof aiData?.grade === "number" ? aiData.grade : null,
        persisted_internally: aiData?.persistedInternally === true,
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
      await auditJob("ai_grading.job_failed", "error", job, {
        error_message: msg.slice(0, 500),
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

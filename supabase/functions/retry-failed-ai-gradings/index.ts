/**
 * Cron job: reintenta automáticamente AI gradings que fallaron por
 * rate limit (HTTP 429) o errores transitorios.
 *
 * Disparado por pg_cron cada 30 min vía la función SQL
 * `trigger_retry_failed_ai_gradings()`, que usa net.http_post con un
 * shared secret en `X-Trigger-Secret` (mismo patrón que send-push).
 *
 * Scope V1: exam submissions. Workshops y proyectos calificados con IA
 * también pueden quedar en estado "Error IA" — agregar en seguimiento
 * si vemos volumen ahí (la mayoría de gradings con IA caen en exámenes).
 *
 * Lógica:
 *   1) Validar X-Trigger-Secret.
 *   2) Listar submissions con AL MENOS un item del breakdown con
 *      `ai_error`, excluyendo las que se reintentaron en la última
 *      RETRY_COOLDOWN_MINUTES (evita martillear la quota de Gemini).
 *   3) Limitar a MAX_PER_RUN para no quemar la quota completa en un
 *      tick. Si quedan más, el siguiente tick las recoge.
 *   4) Para cada una: llamar al edge `ai-grade-submission` con el
 *      service_role key como Authorization. El grading se hace en batch
 *      (1 sola llamada a Gemini para todas las preguntas abiertas del
 *      estudiante). En éxito, el breakdown se sobreescribe sin ai_error
 *      → la submission deja de matchear la query.
 *   5) En cualquier caso, marcamos answers.__last_retry_at = now() para
 *      respetar el cooldown.
 */
import { adminClient, corsHeaders } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

const RETRY_COOLDOWN_MINUTES = 30;
const MAX_PER_RUN = 10;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // ─── Auth: X-Trigger-Secret (mismo patrón que send-push) ───
  const expectedSecret = Deno.env.get("RETRY_TRIGGER_SECRET");
  const providedSecret = req.headers.get("x-trigger-secret") || req.headers.get("X-Trigger-Secret");
  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    // ─── Query: submissions con error de IA pendientes de reintentar ───
    // jsonb_path_exists para encontrar ai_error en cualquier item del
    // breakdown. El cooldown se evalúa sobre __last_retry_at del JSON.
    const { data, error } = await adminClient.rpc("list_failed_ai_gradings", {
      _cooldown_minutes: RETRY_COOLDOWN_MINUTES,
      _limit: MAX_PER_RUN,
    });
    if (error) throw new Error(`list_failed_ai_gradings: ${error.message}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const submissions = (data ?? []) as Array<{ id: string; exam_id: string }>;

    if (submissions.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, processed: 0, message: "No hay gradings pendientes" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const results: Array<{ submissionId: string; ok: boolean; error?: string }> = [];

    for (const sub of submissions) {
      // Marcamos el __last_retry_at ANTES de llamar — así, incluso si
      // la llamada falla o el edge no contesta, el cooldown queda
      // activo y no martillamos la misma submission en el siguiente tick.
      const { data: currentSub } = await adminClient
        .from("submissions")
        .select("answers")
        .eq("id", sub.id)
        .maybeSingle();
      const currentAnswers = (currentSub?.answers as Record<string, unknown> | null) ?? {};
      await adminClient
        .from("submissions")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .update({
          answers: { ...currentAnswers, __last_retry_at: new Date().toISOString() },
        } as any)
        .eq("id", sub.id);

      // ── Invocar ai-grade-submission ──
      // El edge function valida el caller pero acepta service-role como
      // bypass (callerIsTeacherOrAdmin se infiere). El X-Trigger-Secret
      // también lo dejamos pasar como signal del origen.
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/ai-grade-submission`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceKey}`,
            "X-Trigger-Secret": expectedSecret,
          },
          body: JSON.stringify({ submissionId: sub.id }),
        });
        if (!res.ok) {
          const body = await res.text();
          results.push({
            submissionId: sub.id,
            ok: false,
            error: `HTTP ${res.status}: ${body.slice(0, 500)}`,
          });
          continue;
        }
        results.push({ submissionId: sub.id, ok: true });
      } catch (e) {
        results.push({
          submissionId: sub.id,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;

    void auditFromEdge(adminClient, {
      action: "ai.grading_retry_run",
      category: "grading",
      severity: failCount > 0 ? "warning" : "info",
      entityType: "submission",
      metadata: {
        scope: "exam",
        total: results.length,
        ok: okCount,
        failed: failCount,
        cooldown_minutes: RETRY_COOLDOWN_MINUTES,
        max_per_run: MAX_PER_RUN,
        results,
      },
    });

    return new Response(
      JSON.stringify({ ok: true, processed: results.length, success: okCount, failed: failCount }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void auditFromEdge(adminClient, {
      action: "ai.grading_retry_run_failed",
      category: "grading",
      severity: "error",
      entityType: "submission",
      metadata: { error: msg },
    });
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

/**
 * Daily notifications scheduler.
 *
 * Invokes the 4 SQL helper functions that generate anti-spam notifications:
 *   - notify_students_cut_closing(3)         → students, cuts closing in 3 days
 *   - notify_students_course_closing(7)      → students, courses closing in 7 days
 *   - notify_teachers_workshop_due_tomorrow()→ teachers, daily digest
 *   - notify_teachers_pending_grading()      → teachers, daily digest
 *
 * Each helper is idempotent per calendar day (checks via NOT EXISTS), so
 * running this twice in the same day is safe — duplicates are not created.
 *
 * Scheduling options:
 *   A) pg_cron inside Supabase (preferred):
 *      SELECT cron.schedule('examlab-daily-notifs', '0 7 * * *', $$
 *        SELECT notify_students_cut_closing(3);
 *        SELECT notify_students_course_closing(7);
 *        SELECT notify_teachers_workshop_due_tomorrow();
 *        SELECT notify_teachers_pending_grading();
 *      $$);
 *   B) External scheduler (Cloudflare Cron / GitHub Actions) hitting this
 *      endpoint once per day with the service-role key in the Authorization
 *      header.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    // Require a service-role key: this endpoint is meant to be invoked by a
    // scheduler, not by end-user sessions.
    const auth = req.headers.get("Authorization") ?? "";
    const expected = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""}`;
    if (!auth || auth !== expected) {
      return new Response(JSON.stringify({ error: "No autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const results: Record<string, number | string> = {};

    const calls: Array<[string, () => PromiseLike<{ data: unknown; error: unknown }>]> = [
      ["cut_closing", () => admin.rpc("notify_students_cut_closing", { _days: 3 })],
      ["course_closing", () => admin.rpc("notify_students_course_closing", { _days: 7 })],
      ["workshop_due_tomorrow", () => admin.rpc("notify_teachers_workshop_due_tomorrow")],
      ["pending_grading", () => admin.rpc("notify_teachers_pending_grading")],
    ];

    for (const [name, fn] of calls) {
      const { data, error } = await fn();
      if (error) {
        results[name] = `error: ${(error as { message?: string }).message ?? "unknown"}`;
      } else {
        results[name] = typeof data === "number" ? data : 0;
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

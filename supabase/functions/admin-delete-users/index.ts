// Bulk delete users (admin only). Removes auth users + cascading public data.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No autenticado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: u, error: uErr } = await userClient.auth.getUser();
    if (uErr || !u.user) {
      return new Response(JSON.stringify({ error: "Token inválido" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", u.user.id);
    if (!roles?.some((r) => r.role === "Admin")) {
      return new Response(JSON.stringify({ error: "Solo Admin puede eliminar usuarios" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { userIds } = await req.json();
    if (!Array.isArray(userIds) || userIds.length === 0) {
      throw new Error("userIds[] requerido");
    }

    // Prevent admins from deleting themselves
    const targets = userIds.filter((id: string) => id !== u.user.id);

    const result: { userId: string; ok: boolean; reason?: string }[] = [];
    for (const uid of targets) {
      try {
        // Clean dependent data first (no cascade on profile FK to auth)
        await admin.from("user_roles").delete().eq("user_id", uid);
        await admin.from("course_enrollments").delete().eq("user_id", uid);
        await admin.from("course_teachers").delete().eq("user_id", uid);
        await admin.from("workshop_assignments").delete().eq("user_id", uid);
        await admin.from("exam_assignments").delete().eq("user_id", uid);
        await admin.from("profiles").delete().eq("id", uid);
        const { error } = await admin.auth.admin.deleteUser(uid);
        if (error) throw error;
        result.push({ userId: uid, ok: true });
      } catch (e) {
        result.push({
          userId: uid,
          ok: false,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return new Response(JSON.stringify({ ok: true, result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

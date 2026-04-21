// Bulk import users via CSV (admin only)
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

    // Validate user with anon client + token
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

    // Check admin role using service-role (bypass RLS quirks)
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: roles } = await admin.from("user_roles").select("role").eq("user_id", u.user.id);
    if (!roles?.some((r) => r.role === "Admin")) {
      return new Response(JSON.stringify({ error: "Solo Admin puede importar" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { rows } = await req.json();
    if (!Array.isArray(rows)) throw new Error("rows[] requerido");

    const result: { email: string; ok: boolean; reason?: string }[] = [];
    for (const row of rows) {
      const {
        full_name,
        institutional_email,
        personal_email,
        password,
        roles: rolesStr,
        course_name,
      } = row;
      if (!institutional_email || !full_name) {
        result.push({
          email: institutional_email ?? "(vacío)",
          ok: false,
          reason: "faltan campos",
        });
        continue;
      }
      try {
        const { data: list } = await admin.auth.admin.listUsers();
        let userId = list?.users?.find((x: any) => x.email === institutional_email)?.id;
        if (!userId) {
          const { data, error } = await admin.auth.admin.createUser({
            email: institutional_email,
            password: password || "Cambiar#123",
            email_confirm: true,
            user_metadata: { full_name, institutional_email, personal_email },
          });
          if (error) throw error;
          userId = data.user!.id;
        }
        const roleList = (rolesStr || "Estudiante")
          .split("|")
          .map((r: string) => r.trim())
          .filter(Boolean);
        for (const r of roleList) {
          if (["Admin", "Docente", "Estudiante"].includes(r)) {
            await admin
              .from("user_roles")
              .upsert({ user_id: userId, role: r }, { onConflict: "user_id,role" });
          }
        }
        if (course_name) {
          const { data: course } = await admin
            .from("courses")
            .select("id")
            .eq("name", course_name)
            .maybeSingle();
          if (course) {
            await admin
              .from("course_enrollments")
              .upsert(
                { course_id: course.id, user_id: userId },
                { onConflict: "course_id,user_id" },
              );
          }
        }
        result.push({ email: institutional_email, ok: true });
      } catch (e) {
        result.push({
          email: institutional_email,
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

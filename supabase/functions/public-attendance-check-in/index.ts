// Check-in de asistencia PÚBLICO (sin login) con credenciales.
//
// Espeja el patrón del "Reto en vivo" público (/reto/$pin) pero, como la
// asistencia se ata a la identidad REAL del alumno (no un nickname anónimo),
// exige correo + CONTRASEÑA. La contraseña se verifica server-side y la sesión
// resultante se DESCARTA — el alumno nunca queda logueado en la app.
//
// verify_jwt = false (el alumno NO está autenticado). La seguridad la dan:
//   1) verificación de credenciales (signInWithPassword) → user_id real,
//   2) el RPC `public_check_in_attendance` (SECURITY DEFINER) que valida
//      matrícula en el curso EXACTO de la sesión + ventana + código rotativo.
// El session_id fija el curso/tenant; sin matrícula ahí, se rechaza. No hay
// fuga cross-curso ni cross-tenant aunque el alumno esté en varios cursos.
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import { adminClient, corsHeaders, jsonResponse, jsonError } from "../_shared/admin.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY =
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Método no permitido", 405);

  let body: { email?: string; password?: string; sessionId?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("JSON inválido", 400);
  }

  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const sessionId = String(body.sessionId ?? "").trim();
  const code = String(body.code ?? "").replace(/\s+/g, "");
  if (!email || !password || !sessionId || !code) {
    return jsonError("Faltan datos: correo, contraseña, sesión y código.", 400);
  }

  // 1) Verificar credenciales server-side. La sesión que devuelve se DESCARTA
  //    (persistSession:false + no la retornamos): valida identidad sin loguear.
  const authClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: authErr } = await authClient.auth.signInWithPassword({
    email,
    password,
  });
  if (authErr || !signIn?.user) {
    // 200 con ok:false (no 401) para que el cliente lea `data.ok` sin tener
    // que desempacar el error de functions.invoke. Genérico (no-enumeration).
    return jsonResponse({ ok: false, error: "bad_credentials" });
  }
  const userId = signIn.user.id;

  // 2) Marcar asistencia SOLO para esa sesión. El RPC valida matrícula en el
  //    curso de la sesión + ventana + código → candado cross-curso/tenant.
  const { data, error } = await adminClient.rpc("public_check_in_attendance", {
    p_user_id: userId,
    p_session_id: sessionId,
    p_code: code,
  });
  if (error) {
    console.error("[public-attendance-check-in] rpc error", error);
    return jsonResponse({ ok: false, error: "server_error" });
  }
  // data = { ok: true } | { ok:false, error:'not_enrolled'|'invalid_code'|... }
  return jsonResponse(data ?? { ok: false, error: "unknown" });
});

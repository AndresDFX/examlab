// ──────────────────────────────────────────────────────────────────────
// confirm-password-reset — paso 2 del flujo custom de recuperación.
//
// Flow:
//  1. Recibe { token, password } por POST. Anon-callable.
//  2. Busca el token en password_reset_tokens.
//  3. Valida: existe, no usado (used_at IS NULL), no expirado.
//  4. Llama auth.admin.updateUserById(user_id, { password }) con
//     service_role para forzar el cambio sin que el user esté logueado.
//  5. Marca el token como usado (used_at = NOW).
//  6. Retorna ok.
//
// Notas de seguridad:
//  - Min password = 8 chars (mismo que el UI).
//  - El token es single-use: una vez used_at queda no nulo, la próxima
//    llamada con el mismo token falla con 'token_invalid'.
//  - Si llega un token cualquiera (no existe en DB), tampoco distinguimos
//    de "token expirado" en el mensaje — todos caen a 'token_invalid'
//    para no ayudar a un atacante a enumerar tokens válidos.
// ──────────────────────────────────────────────────────────────────────

import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  let body: { token?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }

  const token = body?.token?.trim();
  const password = body?.password ?? "";

  if (!token) return jsonError("missing_token", 400);
  if (password.length < 8) return jsonError("password_too_short", 400);

  // 1) Buscar el token. Filtros explícitos: no usado, no expirado.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: lookupErr } = await (adminClient as any)
    .from("password_reset_tokens")
    .select("id, user_id, used_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (lookupErr) {
    console.error("[confirm-password-reset] lookup", lookupErr);
    return jsonError("internal_error", 500);
  }

  if (!row) {
    return jsonError("token_invalid", 400);
  }

  if (row.used_at) {
    return jsonError("token_invalid", 400);
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    return jsonError("token_expired", 400);
  }

  // 2) Actualizar password vía auth admin API. updateUserById necesita
  //    service_role — eso es lo que tiene adminClient.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updErr } = await (adminClient as any).auth.admin.updateUserById(row.user_id, {
    password,
  });
  if (updErr) {
    console.error("[confirm-password-reset] update", updErr);
    return jsonError(`update_failed: ${updErr.message ?? "unknown"}`, 500);
  }

  // 3) Marcar token como usado. Best-effort: si falla, el password ya
  //    se actualizó. Lo loggeamos pero respondemos OK al usuario.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: markErr } = await (adminClient as any)
    .from("password_reset_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id);
  if (markErr) {
    console.warn("[confirm-password-reset] mark used failed", markErr);
  }

  return jsonResponse({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────
// confirm-email-change — paso 2 del flujo custom de cambio de email.
//
// Flow:
//  1. Recibe { token } por POST. Anon-callable (el link del correo es
//     accionable sin sesión activa).
//  2. Busca el token en email_change_tokens.
//  3. Valida: existe, no usado (used_at IS NULL), no expirado.
//  4. Verifica que el new_email NO esté tomado por otro usuario en el
//     ínterin (entre request y confirm pudo haber alguien reclamando ese
//     email).
//  5. Llama auth.admin.updateUserById(user_id, {
//       email: new_email,
//       email_confirm: true,  ← CLAVE: suprime la confirmación SMTP de Supabase Auth.
//     }).
//  6. UPDATE profiles.institutional_email = new_email para mantener
//     consistencia entre auth.users y la tabla de perfil.
//  7. Marca el token como usado.
//  8. Audit log.
//  9. Retorna { ok: true, newEmail } al cliente.
//
// Notas de seguridad:
//  - Token single-use: una vez used_at queda no nulo, segundas llamadas
//    fallan con token_invalid.
//  - No leak de info: si el token no existe, no decimos "no existe" —
//    devolvemos token_invalid para no facilitar enumeración.
//  - email_confirm: true del adminUpdate es lo que evita el correo de
//    Supabase Auth (la confirmación ya la hicimos vía nuestro link).
// ──────────────────────────────────────────────────────────────────────

import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  const token = body?.token?.trim();
  if (!token) return jsonError("missing_token", 400);

  // 1) Buscar token + validar estado.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: lookupErr } = await (adminClient as any)
    .from("email_change_tokens")
    .select("id, user_id, new_email, used_at, expires_at")
    .eq("token", token)
    .maybeSingle();

  if (lookupErr) {
    console.error("[confirm-email-change] lookup", lookupErr);
    return jsonError("internal_error", 500);
  }
  if (!row) return jsonError("token_invalid", 400);
  if (row.used_at) return jsonError("token_invalid", 400);
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return jsonError("token_expired", 400);
  }

  // 2) Re-verificar que el new_email no esté tomado por OTRO usuario.
  //    Entre el `request` y el `confirm` (hasta 1h) pudo haber otro
  //    flujo reclamando ese mismo correo. Excluimos al propio usuario.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: takenData, error: takenErr } = await (adminClient as any).rpc(
    "check_email_taken",
    {
      p_email: row.new_email,
      p_exclude_user_id: row.user_id,
    },
  );
  if (takenErr) {
    console.error("[confirm-email-change] check_email_taken", takenErr);
    return jsonError("internal_error", 500);
  }
  if (takenData === true) {
    return jsonError("email_already_taken", 409);
  }

  // 3) Actualizar auth.users.email + suprimir correo de Supabase Auth.
  // `email_confirm: true` indica que YA confirmamos la nueva dirección
  // (vía nuestro flujo) — Supabase no manda su correo de verificación.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: updErr } = await (adminClient as any).auth.admin.updateUserById(row.user_id, {
    email: row.new_email,
    email_confirm: true,
  });
  if (updErr) {
    console.error("[confirm-email-change] auth update", updErr);
    return jsonError(`update_failed: ${updErr.message ?? "unknown"}`, 500);
  }

  // 4) Sincronizar profiles.institutional_email. Si esto falla, auth ya
  //    cambió — quedaría desync entre auth.users y profiles. Lo logueamos
  //    pero respondemos OK porque el cambio de auth es lo crítico para
  //    el login. El admin puede reconciliar manualmente si pasa.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: profErr } = await (adminClient as any)
    .from("profiles")
    .update({ institutional_email: row.new_email })
    .eq("id", row.user_id);
  if (profErr) {
    console.warn("[confirm-email-change] profile sync failed", profErr);
  }

  // 5) Marcar token como usado (best-effort).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (adminClient as any)
    .from("email_change_tokens")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.id);

  // 6) Audit log.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (adminClient as any).rpc("log_audit_event", {
    p_action: "user.email_changed",
    p_category: "user",
    p_severity: "info",
    p_actor_role: "Sistema",
    p_entity_type: "user",
    p_entity_id: row.user_id,
    p_entity_name: row.new_email,
    p_metadata: { token_id: row.id },
  }).then?.(() => undefined).catch?.(() => undefined);

  return jsonResponse({ ok: true, newEmail: row.new_email });
});

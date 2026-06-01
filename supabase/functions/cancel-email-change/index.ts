// ──────────────────────────────────────────────────────────────────────
// cancel-email-change — accion del aviso al correo VIEJO.
//
// Permite al duenho del correo anterior cancelar un cambio de email en
// curso. Acepta dos estados:
//   - Solicitado pero no confirmado todavia → cancela igual.
//   - Confirmado pero apply_after no se cumple aun (dentro de la
//     ventana de 24h) → cancela el aplicado.
//
// Una vez applied_at IS NOT NULL, no se puede revertir desde aca — el
// cambio ya esta en auth.users. El duenho tendria que recuperar la
// cuenta por otros medios (soporte, password reset al nuevo correo).
//
// Body: { cancelToken }
// Anon-callable (el link del correo va al duenho legitimo del correo
// anterior, no requiere sesion).
// ──────────────────────────────────────────────────────────────────────

import { adminClient, corsHeaders, jsonError, jsonResponse } from "../_shared/admin.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("method_not_allowed", 405);

  let body: { cancelToken?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("invalid_json", 400);
  }
  const cancelToken = body?.cancelToken?.trim();
  if (!cancelToken) return jsonError("missing_token", 400);

  // 1) Buscar por cancel_token.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: row, error: lookupErr } = await (adminClient as any)
    .from("email_change_tokens")
    .select("id, user_id, new_email, used_at, expires_at, cancelled_at, applied_at")
    .eq("cancel_token", cancelToken)
    .maybeSingle();

  if (lookupErr) {
    console.error("[cancel-email-change] lookup", lookupErr);
    return jsonError("internal_error", 500);
  }
  if (!row) return jsonError("token_invalid", 400);
  if (row.cancelled_at) {
    // Ya cancelado — idempotente, devolvemos ok.
    return jsonResponse({ ok: true, alreadyCancelled: true });
  }
  if (row.applied_at) {
    return jsonError("already_applied", 409);
  }
  // Aceptamos cancelar inclusive si used_at IS NOT NULL — used_at puede
  // estar seteado por "invalidacion por nuevo request del mismo user",
  // pero el duenho del correo viejo igual deberia poder cancelar
  // explicitamente para evitar confusiones futuras. Sin embargo, si
  // expires_at ya paso, no tiene sentido: la confirmacion ya no es
  // posible y el cambio nunca se aplicara.
  if (new Date(row.expires_at).getTime() < Date.now() && !row.used_at) {
    // Token vencido; lo marcamos como usado de paso (mantenimiento).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (adminClient as any)
      .from("email_change_tokens")
      .update({ used_at: new Date().toISOString(), cancelled_at: new Date().toISOString() })
      .eq("id", row.id);
    return jsonResponse({ ok: true, expired: true });
  }

  // 2) Cancelar: marca cancelled_at + used_at (para que el unique
  //    constraint libere el slot y el user pueda solicitar otro).
  const now = new Date().toISOString();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error: cancelErr } = await (adminClient as any)
    .from("email_change_tokens")
    .update({ cancelled_at: now, used_at: now })
    .eq("id", row.id);
  if (cancelErr) {
    console.error("[cancel-email-change] cancel update", cancelErr);
    return jsonError("internal_error", 500);
  }

  // 3) Audit log con severity warning — la cancelacion es una senhal
  //    posible de intento de toma de cuenta. Vale la pena monitorearla.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (adminClient as any)
    .rpc("log_audit_event", {
      p_action: "user.email_change_cancelled",
      p_category: "user",
      p_severity: "warning",
      p_actor_role: "Sistema",
      p_entity_type: "user",
      p_entity_id: row.user_id,
      p_entity_name: row.new_email,
      p_metadata: { token_id: row.id, source: "old_email_link" },
    })
    .then?.(() => undefined)
    .catch?.(() => undefined);

  return jsonResponse({ ok: true });
});

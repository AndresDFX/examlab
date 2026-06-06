// ──────────────────────────────────────────────────────────────────────
// cancel-email-change — acción del aviso al correo ANTERIOR.
//
// CAMBIO 2026-08: el flow nuevo aplica el cambio INMEDIATO al
// confirmar. Por lo tanto este endpoint REVIERTE en la mayoría de
// casos (UPDATE auth.users.email = previous_email). Solo se queda en
// "cancel" cuando el token nunca llegó a aplicarse (caso legacy
// pre-migración o race extremadamente improbable).
//
// La RPC `revert_email_change_to_previous(cancel_token)` decide qué
// hacer y retorna `(restored_email, was_revert)`. El cliente solo
// distingue para mostrar el copy correcto al usuario.
//
// Body: { cancelToken }
// Anon-callable — el link va al dueño legítimo del correo anterior y
// no debería requerir sesión.
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

  // RPC unificada: revierte si el cambio ya fue aplicado, cancela si
  // todavía no. Retorna (restored_email, was_revert). La RPC también
  // hace el audit log con la severity apropiada.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (adminClient as any).rpc("revert_email_change_to_previous", {
    _cancel_token: cancelToken,
  });

  if (error) {
    const msg = String(error.message ?? "");
    if (msg.includes("token_not_found")) return jsonError("token_invalid", 400);
    if (msg.includes("already_reverted")) return jsonResponse({ ok: true, alreadyReverted: true });
    if (msg.includes("already_cancelled")) return jsonResponse({ ok: true, alreadyCancelled: true });
    if (msg.includes("revert_window_expired")) return jsonError("revert_window_expired", 410);
    if (msg.includes("previous_email_not_recorded")) {
      // Token legacy: no se grabó previous_email. No podemos revertir,
      // pero podemos al menos cancelar para liberar el slot.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (adminClient as any)
        .from("email_change_tokens")
        .update({ cancelled_at: new Date().toISOString(), used_at: new Date().toISOString() })
        .eq("cancel_token", cancelToken);
      return jsonError("revert_not_available_legacy_token", 410);
    }
    if (msg.includes("previous_email_taken_by_other")) {
      return jsonError("previous_email_taken_by_other", 409);
    }
    console.error("[cancel-email-change] RPC failed", error);
    return jsonError("internal_error", 500);
  }

  // RPC retorna TABLE(restored_email, was_revert) — array de 1 fila.
  const result = Array.isArray(data) ? data[0] : data;
  const restoredEmail: string = result?.restored_email ?? "";
  const wasRevert: boolean = result?.was_revert === true;

  return jsonResponse({
    ok: true,
    restoredEmail,
    wasRevert,
  });
});

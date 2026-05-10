// Callback público de OAuth de Google. Recibe ?code&state, intercambia por
// tokens, los guarda en teacher_google_tokens y redirige al docente.
// El "state" lo armó nuestro server fn con formato <teacher_id>:<nonce>:<origin_b64>.
import { createFileRoute } from "@tanstack/react-router";
import {
  exchangeCodeForTokens,
  decodeIdTokenEmail,
} from "@/lib/google-calendar.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const Route = createFileRoute("/api/public/google-oauth-callback")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");

        const fail = (msg: string, origin?: string) => {
          const back = origin ?? url.origin;
          return Response.redirect(
            `${back}/app/teacher/google-calendar?err=${encodeURIComponent(msg)}`,
            302,
          );
        };

        if (error) return fail(error);
        if (!code || !state) return fail("missing_params");

        const parts = state.split(":");
        if (parts.length < 3) return fail("bad_state");
        const teacherId = parts[0];
        const originB64 = parts.slice(2).join(":");
        let origin = url.origin;
        try {
          origin = Buffer.from(originB64, "base64url").toString("utf-8");
        } catch {
          /* fallback al origin del request */
        }

        try {
          const tok = await exchangeCodeForTokens(code, origin);
          if (!tok.refresh_token) {
            // Pasa cuando el docente ya autorizó antes y Google no re-emite
            // el refresh_token. Le pedimos que revoque acceso desde su
            // cuenta de Google y reintente.
            return fail("no_refresh_token", origin);
          }
          const expiresAt = new Date(Date.now() + tok.expires_in * 1000).toISOString();
          const email = decodeIdTokenEmail(tok.id_token);

          const { error: upErr } = await supabaseAdmin
            .from("teacher_google_tokens")
            .upsert({
              teacher_id: teacherId,
              refresh_token: tok.refresh_token,
              access_token: tok.access_token,
              expires_at: expiresAt,
              google_email: email,
            });
          if (upErr) return fail(`db:${upErr.message}`, origin);

          return Response.redirect(`${origin}/app/teacher/google-calendar?ok=1`, 302);
        } catch (e) {
          return fail((e as Error).message, origin);
        }
      },
    },
  },
});

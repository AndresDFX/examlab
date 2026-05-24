// Edge function: send-push
//
// Recibe `{ user_id, title, body, link, kind, notification_id }` y envía
// un Web Push real a TODAS las suscripciones registradas del usuario.
// Usa la librería `webpush.deno` (puerto Deno de web-push) que firma
// el JWT de VAPID y arma el envelope encrypted del payload.
//
// Variables de entorno (configurar en Lovable / Supabase project secrets):
//   - VAPID_PUBLIC_KEY    base64url, public.    Generar con `npx web-push generate-vapid-keys`.
//   - VAPID_PRIVATE_KEY   base64url, private.   Mantener secreta.
//   - VAPID_SUBJECT       mailto:tu@dominio.com (requerido por VAPID).
//   - SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  (los inyecta Supabase).
//
// Si la suscripción retorna 404/410 (gone), la borramos — el browser
// la invalidó (usuario revocó permiso, desinstaló la PWA, etc.).
import { createClient } from "npm:@supabase/supabase-js@2.45.0";
import * as webpush from "jsr:@negrel/webpush@0.3.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const adminClient = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Cache del ApplicationServer (lleva la VAPID key importada). Se crea
// una sola vez por instancia de la edge function.
let appServer: webpush.ApplicationServer | null = null;
async function getAppServer(): Promise<webpush.ApplicationServer | null> {
  if (appServer) return appServer;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT");
  if (!pub || !priv || !subject) {
    console.warn("[send-push] VAPID env missing — push disabled");
    return null;
  }
  try {
    const keys = await webpush.importVapidKeys(
      {
        publicKey: pub,
        privateKey: priv,
      },
      { extractable: false },
    );
    appServer = await webpush.ApplicationServer.new({
      contactInformation: subject,
      vapidKeys: keys,
    });
    return appServer;
  } catch (e) {
    console.error("[send-push] failed to init ApplicationServer", e);
    return null;
  }
}

interface RequestBody {
  user_id: string;
  title?: string;
  body?: string;
  link?: string | null;
  kind?: string;
  notification_id?: string;
}

interface SubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth propio (no JWT de Supabase): el trigger del DB manda
  // X-Trigger-Secret con un valor que solo conoce el servidor.
  // Sin esto cualquiera podría spamear push notifications a cualquier
  // user_id porque verify_jwt=false en config.toml.
  const triggerSecret = Deno.env.get("PUSH_TRIGGER_SECRET");
  if (triggerSecret) {
    const got = req.headers.get("x-trigger-secret") ?? "";
    if (got !== triggerSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    console.warn("[send-push] PUSH_TRIGGER_SECRET not set — function is unprotected");
  }

  let body: RequestBody;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!body?.user_id) {
    return new Response(JSON.stringify({ error: "Missing user_id" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const server = await getAppServer();
  if (!server) {
    // Sin VAPID configurado, retornamos OK pero no enviamos nada — así
    // el trigger DB no falla. El log queda como warning para que el
    // admin lo detecte.
    return new Response(JSON.stringify({ ok: true, sent: 0, skipped: "vapid_missing" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { data: subs, error } = await adminClient
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .eq("user_id", body.user_id);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rows = (subs ?? []) as SubscriptionRow[];
  if (rows.length === 0) {
    return new Response(JSON.stringify({ ok: true, sent: 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Payload que recibe el SW. Debe ser texto plano (lo que el SW
  // parseará como JSON en su handler `push`).
  const payloadJson = JSON.stringify({
    title: body.title ?? "ExamLab",
    body: body.body ?? "",
    link: body.link ?? "/app",
    kind: body.kind ?? "info",
    id: body.notification_id, // se usa como tag único en el SW
  });

  // Opciones HTTP del push. CRÍTICAS para Android (FCM):
  //  - TTL: sin él Chrome usa 4w default; con valor explícito FCM sabe
  //    cuánto retener el mensaje. 24h es razonable para una notificación
  //    de plataforma educativa.
  //  - urgency 'high': FCM puede demorar o agrupar mensajes 'normal' o
  //    inferiores cuando el dispositivo está en Doze mode. 'high' fuerza
  //    entrega prácticamente inmediata.
  //  - topic: si el mismo user_id recibe varias notifs del mismo kind en
  //    rápida sucesión, FCM colapsa las anteriores. Útil para evitar
  //    spammear al alumno con 10 notifs idénticas de "nuevo mensaje".
  //    Diferente al `tag` del SW (que actúa una vez que ya llegó).
  const pushOptions = {
    ttl: 86400,
    urgency: "high" as const,
    topic: body.kind ? `examlab-${body.kind}`.slice(0, 32) : undefined,
  };

  const stale: string[] = [];
  let sent = 0;

  await Promise.all(
    rows.map(async (s) => {
      try {
        const subscriber = server.subscribe({
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
          // expirationTime es opcional según la spec.
          expirationTime: null,
        });
        await subscriber.pushTextMessage(payloadJson, pushOptions);
        sent += 1;
      } catch (e) {
        // 404/410 del endpoint = suscripción muerta (usuario revocó
        // permiso, desinstaló la PWA, cambió de browser). Marcamos
        // para limpieza. Otros errores los ignoramos por intento —
        // pueden ser transitorios.
        const msg = e instanceof Error ? e.message : String(e);
        const dead = /\b(404|410|gone|expired)\b/i.test(msg);
        if (dead) stale.push(s.id);
        else console.warn("[send-push] push failed", s.endpoint, msg);
      }
    }),
  );

  // Cleanup de suscripciones muertas. Hacemos best-effort — si falla
  // no devolvemos error porque el envío principal sí funcionó.
  if (stale.length > 0) {
    await adminClient.from("push_subscriptions").delete().in("id", stale);
  }

  return new Response(
    JSON.stringify({ ok: true, sent, removed: stale.length, total: rows.length }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});

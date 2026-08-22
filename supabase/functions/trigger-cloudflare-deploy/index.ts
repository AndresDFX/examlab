/**
 * Edge Function: trigger-cloudflare-deploy
 *
 * Dispara el workflow `deploy-cloudflare.yml` de GitHub Actions, que publica el
 * despliegue general y **un Worker por institución** en Cloudflare.
 *
 * Para qué existe: en `workers.dev` la URL de cada institución es un Worker
 * aparte (`<slug>.examlab.workers.dev`), y el workflow los publica leyendo la
 * lista de instituciones activas — pero NADIE le avisa cuando se crea una. Sin
 * esto, el SuperAdmin crea la institución, reparte el enlace y quien lo abre se
 * encuentra un 404 hasta el próximo push. Acá el enlace existe en ~2,5 minutos.
 *
 * NO es indispensable: quien no tenga su Worker todavía entra igual por
 * `app.examlab.workers.dev` y elige su institución en el selector. Lo que falta
 * mientras tanto es su dirección propia, no el acceso.
 *
 * Y es TEMPORAL por diseño: el día que haya un dominio propio, un DNS comodín
 * cubre cualquier institución sin desplegar nada y esta función se borra junto
 * con el resto del andamiaje (ver docs/subdominios-cloudflare.md).
 *
 * Auth: `verify_jwt=true` (el gateway exige JWT válido) + gate de rol
 * **SuperAdmin** server-side. El gate no es decorativo: un despliegue consume
 * minutos de GitHub Actions y reescribe lo que se sirve en producción, así que
 * no puede quedar al alcance de cualquier autenticado con la URL. Mismo patrón
 * que `ai-generate-sql`: no hay caller service_role, así que NO se apaga
 * verify_jwt.
 *
 * Secret requerido: `GITHUB_DISPATCH_TOKEN` — un PAT con permiso de escritura
 * sobre Actions del repo. Se carga en Supabase → Edge Function Secrets.
 *
 * Body:  { reason?: string }   (texto libre, solo para el audit log)
 * Resp:  { ok: true }
 */
import { adminClient as admin, corsHeaders, jsonError, jsonResponse, userClientFromRequest } from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";
import { enforceRateLimit } from "../_shared/rate-limit.ts";

/** Repo y workflow a disparar. Configurables por si el repo se mueve. */
const REPO = Deno.env.get("GITHUB_REPO") ?? "AndresDFX/examlab";
const WORKFLOW_FILE = Deno.env.get("GITHUB_WORKFLOW_FILE") ?? "deploy-cloudflare.yml";
/** Rama que se publica. El workflow solo existe y corre sobre `main`. */
const REF = "main";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonError("Método no permitido", 405);

  const userClient = userClientFromRequest(req);
  if (!userClient) return jsonError("No autenticado", 401);
  const { data: u } = await userClient.auth.getUser();
  if (!u?.user?.id) return jsonError("No autenticado", 401);

  const { data: callerRoles } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", u.user.id);
  const isSuperAdmin = (callerRoles ?? []).some((r: { role: string }) => r.role === "SuperAdmin");
  if (!isSuperAdmin) {
    return jsonError("Solo el SuperAdmin puede publicar la plataforma.", 403);
  }

  // Un despliegue son ~2,5 minutos de CI y reescribe lo que se sirve. 10 por
  // hora es holgado para el uso real (crear instituciones es esporádico) y
  // ataja que un bucle accidental encole decenas de corridas.
  const rl = await enforceRateLimit(userClient, "cloudflare.deploy", {
    max: 10,
    windowSeconds: 3600,
  });
  if (!rl.ok) return rl.response;

  const token = Deno.env.get("GITHUB_DISPATCH_TOKEN");
  if (!token) {
    return jsonError(
      "Falta el secreto GITHUB_DISPATCH_TOKEN. Cargalo en Supabase → Edge Function Secrets.",
      500,
    );
  }

  let reason = "";
  try {
    const body = (await req.json()) as { reason?: string };
    reason = (body?.reason ?? "").trim().slice(0, 200);
  } catch {
    // Body opcional: sin él se dispara igual.
  }

  const url = `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        // GitHub RECHAZA los requests sin User-Agent con 403.
        "User-Agent": "examlab-edge",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: REF }),
    });
  } catch (e) {
    return jsonError(`No se pudo contactar a GitHub: ${(e as Error).message}`, 502);
  }

  // El dispatch responde 204 sin cuerpo cuando encola la corrida.
  if (res.status !== 204) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    // 404 acá casi siempre es permisos, no un repo inexistente: GitHub oculta
    // los repos que el token no puede ver. Decirlo evita mandar a alguien a
    // buscar un typo en el nombre del repo cuando el problema es el PAT.
    const hint =
      res.status === 404
        ? " Verificá que el PAT tenga permiso de escritura sobre Actions en este repo."
        : "";
    return jsonError(`GitHub respondió ${res.status}.${hint} ${detail}`.trim(), 502);
  }

  await auditFromEdge(admin, {
    actorId: u.user.id,
    action: "platform.deploy_triggered",
    category: "system",
    severity: "info",
    entityType: "deployment",
    entityName: `${REPO} · ${WORKFLOW_FILE}`,
    metadata: { ref: REF, reason: reason || null },
  });

  return jsonResponse({ ok: true });
});

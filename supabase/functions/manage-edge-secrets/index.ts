/**
 * manage-edge-secrets — proxy al Supabase Management API para listar
 * y actualizar Edge Function Secrets desde el panel Admin.
 *
 * Por qué un edge function: el Management API requiere un Personal
 * Access Token (PAT con prefix sbp_) que da acceso TOTAL al proyecto.
 * Ese PAT NO puede vivir en el cliente — vive en
 * `SUPABASE_MANAGEMENT_PAT` (env del edge runtime), y este wrapper
 * autoriza al caller, valida rol Admin, llama al Management API y
 * devuelve los valores enmascarados (excepto al setear).
 *
 * Endpoints (todos POST con `action` en el body):
 *  - { action: "list" }   → [{ name, value_masked, updated_at }]
 *  - { action: "set", name, value }     → { ok }
 *  - { action: "unset", name }          → { ok }
 *
 * Seguridad:
 *  - Auth: requiere JWT válido. El handler valida rol Admin.
 *  - Masking: list devuelve solo los últimos 4 chars del value
 *    (`***xY8w`). El admin nunca ve la key completa después de
 *    crearla — coherente con cómo AWS muestra access keys.
 *  - Audit: todo cambio queda en audit_logs con el name (sin value).
 *  - Filtrado: secrets que Supabase considera "internos" (los que
 *    empiezan con SUPABASE_ / RESERVED_) se filtran para no permitir
 *    sobrescribir el service_role_key o el JWT secret.
 */
import {
  adminClient as admin,
  corsHeaders,
  userClientFromRequest,
} from "../_shared/admin.ts";
import { auditFromEdge } from "../_shared/audit.ts";

interface SupabaseSecret {
  name: string;
  value: string;
  updated_at?: string;
}

// Secrets que el wrapper NO permite leer ni modificar — son internos del
// plano de Supabase y romper alguno deja el proyecto inservible.
const RESERVED_SECRETS = new Set([
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_PUBLISHABLE_DEFAULT_KEY",
  "SUPABASE_INTERNAL_JWT_SECRET",
  "SUPABASE_MANAGEMENT_PAT", // el propio PAT — auto-protección
]);

function maskValue(v: string): string {
  if (!v) return "";
  if (v.length <= 4) return "*".repeat(v.length);
  return `***${v.slice(-4)}`;
}

function isReserved(name: string): boolean {
  if (RESERVED_SECRETS.has(name)) return true;
  // Cualquier cosa que empiece con SUPABASE_ (auto-injected) se filtra.
  if (name.startsWith("SUPABASE_")) return true;
  return false;
}

async function callManagementApi(
  pat: string,
  projectRef: string,
  method: "GET" | "POST" | "DELETE",
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; raw: string }> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/secrets`,
    {
      method,
      headers: {
        Authorization: `Bearer ${pat}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const raw = await res.text();
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = { _nonJsonBody: raw.slice(0, 1000) };
  }
  return { ok: res.ok, status: res.status, data, raw };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let actorId: string | undefined;
  try {
    // ── Auth: JWT del caller + rol Admin ──
    const userClient = userClientFromRequest(req);
    if (!userClient) return jsonResponse(401, { error: "No autenticado" });
    const { data: u } = await userClient.auth.getUser();
    if (!u.user) return jsonResponse(401, { error: "Token inválido" });
    actorId = u.user.id;

    const { data: rolesRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", u.user.id);
    const isAdmin = (rolesRows ?? []).some(
      (r: { role: string }) => r.role === "Admin",
    );
    if (!isAdmin) {
      return jsonResponse(403, { error: "Solo Admin puede gestionar secrets" });
    }

    // ── Config: PAT + project ref ──
    const pat = Deno.env.get("SUPABASE_MANAGEMENT_PAT");
    if (!pat) {
      return jsonResponse(503, {
        error:
          "SUPABASE_MANAGEMENT_PAT no configurada en Edge Function Secrets. " +
          "Genera un PAT en https://supabase.com/dashboard/account/tokens y agrégalo en Settings → Edge Function Secrets.",
      });
    }
    // Project ref: lo extraemos del SUPABASE_URL (siempre disponible
    // automáticamente en el runtime).
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const refMatch = supabaseUrl.match(/https?:\/\/([a-z0-9]+)\.supabase\.co/i);
    const projectRef = refMatch?.[1] ?? Deno.env.get("SUPABASE_PROJECT_REF") ?? "";
    if (!projectRef) {
      return jsonResponse(503, {
        error:
          "No se pudo determinar project ref. Setea SUPABASE_PROJECT_REF en Edge Function Secrets.",
      });
    }

    // ── Parse body ──
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "").trim();

    // ── Action: list ──
    if (action === "list") {
      const res = await callManagementApi(pat, projectRef, "GET");
      if (!res.ok) {
        return jsonResponse(res.status, {
          error: `Management API error (HTTP ${res.status})`,
          detail: res.raw.slice(0, 500),
        });
      }
      const secrets = Array.isArray(res.data) ? (res.data as SupabaseSecret[]) : [];
      const masked = secrets
        .filter((s) => !isReserved(s.name))
        .map((s) => ({
          name: s.name,
          value_masked: maskValue(s.value ?? ""),
          length: (s.value ?? "").length,
          updated_at: s.updated_at ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return jsonResponse(200, { secrets: masked });
    }

    // ── Action: set ──
    if (action === "set") {
      const name = String(body.name ?? "").trim();
      const value = String(body.value ?? "");
      if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
        return jsonResponse(400, {
          error: "Nombre inválido. Debe ser MAYÚSCULAS_CON_GUIONES (ej. MY_API_KEY).",
        });
      }
      if (isReserved(name)) {
        return jsonResponse(400, {
          error: `${name} es un secret reservado del sistema y no se puede modificar desde aquí.`,
        });
      }
      if (!value) {
        return jsonResponse(400, { error: "value requerido" });
      }
      if (value.length > 8192) {
        return jsonResponse(400, { error: "value demasiado largo (máx 8KB)" });
      }
      const res = await callManagementApi(pat, projectRef, "POST", [{ name, value }]);
      if (!res.ok) {
        return jsonResponse(res.status, {
          error: `Management API error al setear ${name} (HTTP ${res.status})`,
          detail: res.raw.slice(0, 500),
        });
      }
      void auditFromEdge(admin, {
        actorId,
        action: "edge_secrets.set",
        category: "system",
        severity: "warning",
        entityType: "edge_function_secret",
        entityName: name,
        metadata: {
          name,
          value_length: value.length,
          value_last4: value.slice(-4),
        },
      });
      return jsonResponse(200, { ok: true });
    }

    // ── Action: unset (borrar) ──
    if (action === "unset") {
      const name = String(body.name ?? "").trim();
      if (!name) return jsonResponse(400, { error: "name requerido" });
      if (isReserved(name)) {
        return jsonResponse(400, {
          error: `${name} es un secret reservado y no se puede borrar.`,
        });
      }
      const res = await callManagementApi(pat, projectRef, "DELETE", [name]);
      if (!res.ok) {
        return jsonResponse(res.status, {
          error: `Management API error al borrar ${name} (HTTP ${res.status})`,
          detail: res.raw.slice(0, 500),
        });
      }
      void auditFromEdge(admin, {
        actorId,
        action: "edge_secrets.unset",
        category: "system",
        severity: "warning",
        entityType: "edge_function_secret",
        entityName: name,
        metadata: { name },
      });
      return jsonResponse(200, { ok: true });
    }

    return jsonResponse(400, {
      error: "action inválida. Opciones: list, set, unset.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    void auditFromEdge(admin, {
      actorId,
      action: "edge_secrets.error",
      category: "system",
      severity: "error",
      entityType: "edge_function_secret",
      metadata: { error: msg },
    });
    return jsonResponse(500, { error: msg });
  }
});

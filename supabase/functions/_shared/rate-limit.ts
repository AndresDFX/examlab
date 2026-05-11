// Helper de rate limiting para edge functions. Llama al RPC SQL
// `check_rate_limit` (ver migración 20260513150000_rate_limiting.sql).
//
// Uso:
//   const rl = await enforceRateLimit(userClient, "ai.grading", { max: 100, windowSeconds: 3600 });
//   if (!rl.ok) return rl.response;   // 429 con retry-after
//   ...sigue el trabajo...
//
// El userClient debe ser uno con JWT del caller (no service-role) — el
// RPC usa auth.uid() para identificar al actor.

import { corsHeaders } from "./admin.ts";

interface RateLimitOK {
  ok: true;
  remaining: number;
}
interface RateLimitDenied {
  ok: false;
  response: Response;
}

interface RateLimitConfig {
  /** Cuántas llamadas máximas en la ventana. */
  max: number;
  /** Ventana deslizante en segundos. */
  windowSeconds: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ClientLike = {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }>;
};

export async function enforceRateLimit(
  client: ClientLike,
  action: string,
  cfg: RateLimitConfig,
): Promise<RateLimitOK | RateLimitDenied> {
  try {
    const { data, error } = await client.rpc("check_rate_limit", {
      p_action: action,
      p_max: cfg.max,
      p_window_seconds: cfg.windowSeconds,
    });
    if (error) {
      // Si el RPC falla (migración no aplicada, BD caída, etc.) NO
      // bloqueamos al usuario — preferimos permitir el request a romper
      // el flujo. El error queda logueado para detección.
      console.warn("[rate_limit] RPC failed, allowing request:", error.message);
      return { ok: true, remaining: -1 };
    }
    const res = data as {
      ok: boolean;
      remaining?: number;
      error?: string;
      retry_after_seconds?: number;
      limit?: number;
      window_seconds?: number;
    };
    if (res?.ok) {
      return { ok: true, remaining: res.remaining ?? -1 };
    }
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: "rate_limited",
          message: `Demasiadas solicitudes. Intenta de nuevo en ${res.retry_after_seconds ?? 60} segundos.`,
          retry_after_seconds: res.retry_after_seconds ?? null,
          limit: res.limit ?? cfg.max,
          window_seconds: res.window_seconds ?? cfg.windowSeconds,
        }),
        {
          status: 429,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            ...(res.retry_after_seconds ? { "Retry-After": String(res.retry_after_seconds) } : {}),
          },
        },
      ),
    };
  } catch (e) {
    console.warn("[rate_limit] threw, allowing request:", (e as Error).message);
    return { ok: true, remaining: -1 };
  }
}

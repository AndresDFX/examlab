/**
 * GlobalErrorLogger — captura errores runtime y promesas rechazadas
 * NO manejadas, y los registra en audit_logs.
 *
 * Complementa al ErrorBoundary:
 *  - ErrorBoundary captura errores de RENDER (componentes React).
 *  - Este captura errores ASYNC (fetch que tira, callbacks, etc.) y
 *    errores fuera del árbol React (window.error nativos).
 *
 * Filtros:
 *  - Chunk-load errors ya tienen handler dedicado en __root.tsx (recarga
 *    la página). NO los logueamos acá para evitar ruido — un deploy
 *    nuevo puede generar 10s de chunk-errors antes que la recarga
 *    estabilice.
 *  - Throttling: máximo 1 evento por mensaje + URL cada 30s. Sin esto,
 *    un error en un setInterval podría disparar miles de filas en pocos
 *    segundos.
 */
import { useEffect } from "react";
import { logEvent } from "@/shared/lib/audit";

const THROTTLE_MS = 30_000;
const recentErrors = new Map<string, number>();

function isChunkLoadError(msg: string): boolean {
  if (!msg) return false;
  return (
    msg.includes("ChunkLoadError") ||
    msg.includes("Loading chunk") ||
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed")
  );
}

function shouldLog(key: string): boolean {
  const now = Date.now();
  const last = recentErrors.get(key);
  if (last && now - last < THROTTLE_MS) return false;
  recentErrors.set(key, now);
  // Limpieza ocasional para no inflar el map en sesiones largas.
  if (recentErrors.size > 200) {
    const cutoff = now - THROTTLE_MS;
    for (const [k, ts] of recentErrors) if (ts < cutoff) recentErrors.delete(k);
  }
  return true;
}

export function GlobalErrorLogger() {
  useEffect(() => {
    const onError = (ev: ErrorEvent) => {
      const msg = ev.message ?? ev.error?.message ?? "";
      if (isChunkLoadError(msg)) return;
      const url = typeof window !== "undefined" ? window.location.pathname : "";
      const key = `${msg}::${url}`;
      if (!shouldLog(key)) return;
      void logEvent({
        action: "app.runtime_error",
        category: "system",
        severity: "error",
        entityName: ev.error?.name || "Error",
        metadata: {
          message: msg.slice(0, 500),
          source: ev.filename || null,
          line: ev.lineno ?? null,
          column: ev.colno ?? null,
          stack: (ev.error?.stack ?? "").slice(0, 2000),
          url,
        },
      });
    };

    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason = ev.reason;
      const msg =
        (reason && (reason.message || (typeof reason === "string" ? reason : ""))) || "";
      if (isChunkLoadError(msg)) return;
      const url = typeof window !== "undefined" ? window.location.pathname : "";
      const key = `${msg}::${url}`;
      if (!shouldLog(key)) return;
      void logEvent({
        action: "app.unhandled_rejection",
        category: "system",
        severity: "error",
        entityName: reason?.name || "PromiseRejection",
        metadata: {
          message: msg.slice(0, 500),
          stack: (reason?.stack ?? "").slice(0, 2000),
          url,
        },
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}

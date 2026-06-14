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
    // Heurística: stacks/sources de extensiones de browser (Grammarly,
    // password managers, React DevTools, ad-blockers, etc.) NO son
    // errores de la app — ensucian el audit log y son inaccionables.
    // Filtramos por scheme `chrome-extension://`, `moz-extension://`,
    // `safari-web-extension://` en cualquier parte del stack o de la
    // source URL del ErrorEvent.
    const isExtensionNoise = (source?: string | null, stack?: string | null): boolean => {
      const combined = `${source ?? ""} ${stack ?? ""}`;
      return (
        combined.includes("chrome-extension://") ||
        combined.includes("moz-extension://") ||
        combined.includes("safari-web-extension://")
      );
    };

    // Ruido conocido del browser/navegador: errores que NO son bugs
    // de nuestra app y NO son accionables desde la plataforma. Si los
    // dejamos pasar, inundan `audit_logs` y enmascaran errores reales.
    //
    // 1. SW update failures: el browser intenta actualizar /sw.js mientras
    //    el user navega y a veces falla por red/cache. El SW del registro
    //    siguiente queda válido — no rompe la app.
    // 2. `newestWorker is null`: race condition del registry.update() del
    //    SW cuando la página se descarga. Inofensivo.
    // 3. Lock auth-token stolen: dos tabs concurrent intentaron renovar
    //    el JWT al mismo tiempo. Comportamiento normal de supabase-js;
    //    el último gana sin romper la sesión.
    // 4. Script error: cross-origin script sin info útil (CORS hide).
    //    No podemos diagnosticarlo desde acá.
    // 5. "Script .../sw.js load failed": el navegador no pudo descargar el
    //    service worker (red intermitente o deploy en curso reemplazando el
    //    bundle). El SW previo sigue válido; no rompe la app. PWA lifecycle.
    const isBrowserNoise = (msg: string): boolean => {
      if (!msg) return false;
      return (
        msg.includes("Failed to update a ServiceWorker") ||
        msg.includes("newestWorker is null") ||
        (msg.includes("Lock") && msg.includes("was released because another request stole")) ||
        (msg.includes("sw.js") && msg.includes("load failed")) ||
        msg === "Script error." ||
        msg === "Script error" ||
        // ResizeObserver loop limit / undelivered notifications: warning
        // inofensivo del browser que dispara cuando un layout se
        // redimensiona durante un commit de React. NO rompe la app pero
        // spammea audit_logs. Reportado en `/app/teacher/attendance`.
        msg.startsWith("ResizeObserver loop")
      );
    };

    const onError = (ev: ErrorEvent) => {
      const msg = ev.message ?? ev.error?.message ?? "";
      if (isChunkLoadError(msg)) return;
      if (isExtensionNoise(ev.filename, ev.error?.stack)) return;
      if (isBrowserNoise(msg)) return;
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
      // Reject sin reason útil (extensiones del navegador como Grammarly,
      // password managers, ad-blockers producen rejections vacías). No
      // aportan info accionable y ensucian el audit log.
      if (reason == null) return;
      // AbortError es esperable cuando cancelamos requests al desmontar
      // (AbortController.abort, fetch cancelado, Excalidraw chunk load
      // mid-flight). Es comportamiento INTENCIONAL del frontend, no un
      // bug — filtrar para no generar logs huérfanos.
      if (reason?.name === "AbortError") return;
      const msg = (reason && (reason.message || (typeof reason === "string" ? reason : ""))) || "";
      if (isChunkLoadError(msg)) return;
      // Stack viene de chrome-extension/moz-extension → ruido del browser,
      // no de nuestra app. Caso reportado: "WrappedError: Timeout" con
      // stack apuntando a injected-scripts/host-additional-hooks.js. Solo
      // aparece para usuarios con cierta extensión instalada — para nada
      // accionable desde la plataforma.
      if (isExtensionNoise(null, reason?.stack)) return;
      if (isBrowserNoise(msg)) return;
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

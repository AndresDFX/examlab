// Web Push subscription helper.
//
// Llamado al cargar la app (cuando hay user autenticado) — pide
// permiso de notificaciones si todavía no se decidió, suscribe el
// browser al pushManager con la VAPID public key, y guarda el endpoint
// + claves en `push_subscriptions`. Idempotente: si la suscripción ya
// existe en el DB no la recrea.
//
// Soporte:
//   - Chrome/Edge desktop + Android: full support.
//   - Firefox desktop + Android: full support.
//   - Safari iOS 16.4+ (PWA instalada en home screen): full support.
//   - Safari iOS no-PWA: NO soporta Web Push fuera de PWA. El usuario
//     debe hacer "Add to Home Screen" antes de que esto funcione.
//
// La VAPID public key se inyecta vía `import.meta.env.VITE_VAPID_PUBLIC_KEY`
// — configurar en Lovable / .env. Si no está, deshabilitamos push y
// salimos silenciosamente (la app sigue con realtime + polling).

import { supabase } from "@/integrations/supabase/client";

/**
 * Convierte una base64url string a Uint8Array (lo que pide
 * pushManager.subscribe en applicationServerKey).
 */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  // Construimos sobre un ArrayBuffer fresco para que `buffer` sea
  // ArrayBuffer (no SharedArrayBuffer); pushManager.subscribe lo
  // requiere así en los types de TS más recientes.
  const buf = new ArrayBuffer(raw.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

/** Extrae p256dh + auth de una PushSubscription (vienen como ArrayBuffer). */
function extractKeys(sub: PushSubscription): { p256dh: string; auth: string } | null {
  const json = sub.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!p256dh || !auth) return null;
  return { p256dh, auth };
}

/**
 * Asegura que el browser tenga una suscripción Web Push activa para
 * este usuario y que esté registrada en la base de datos.
 *
 * Flujo:
 *   1. Verifica soporte (Notification API, ServiceWorker, PushManager).
 *   2. Verifica/pide permiso. Si el usuario denegó, salimos sin tocar nada.
 *   3. Espera al SW listo (`navigator.serviceWorker.ready`).
 *   4. Lee la suscripción existente. Si no hay, llama a `subscribe(...)`.
 *   5. Hace upsert en `push_subscriptions` (UNIQUE user_id + endpoint).
 *
 * Devuelve `true` si quedó suscrito correctamente, `false` si no se pudo
 * (sin soporte, permiso denegado, sin VAPID key, error de subscribe).
 */
export async function ensurePushSubscription(userId: string): Promise<boolean> {
  // 1. Soporte. En SSR window/navigator no existen.
  if (
    typeof window === "undefined" ||
    typeof navigator === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    typeof Notification === "undefined"
  ) {
    return false;
  }

  const vapidPublic = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  if (!vapidPublic) {
    console.warn("[push] VITE_VAPID_PUBLIC_KEY missing — Web Push disabled");
    return false;
  }

  // 2. Permiso. Si ya está denegado, NO volvemos a preguntar (sería
  // intrusivo y de todos modos browser bloquea pop-ups repetidos).
  if (Notification.permission === "denied") return false;
  if (Notification.permission === "default") {
    const granted = await Notification.requestPermission();
    if (granted !== "granted") return false;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast por incompatibilidad de tipos entre Uint8Array<ArrayBufferLike>
        // (lo que devuelve nuestro builder) y BufferSource estricto del DOM
        // moderno. En runtime un Uint8Array es perfectamente válido aquí.
        applicationServerKey: urlBase64ToUint8Array(vapidPublic) as unknown as BufferSource,
      });
    }

    const keys = extractKeys(sub);
    if (!keys) return false;

    // Upsert en push_subscriptions. UNIQUE (user_id, endpoint) garantiza
    // que múltiples calls (mismo browser, recargas) no creen duplicados.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase as any).from("push_subscriptions").upsert(
      {
        user_id: userId,
        endpoint: sub.endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
        user_agent: navigator.userAgent,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,endpoint" },
    );

    if (error) {
      console.warn("[push] failed to upsert subscription", error.message);
      return false;
    }
    return true;
  } catch (e) {
    // Silenciamos errores conocidos de iOS: si la PWA no está instalada
    // en home screen, subscribe rechaza con NotAllowedError.
    console.warn("[push] subscribe failed", e);
    return false;
  }
}

/**
 * Desuscribe el browser y limpia la fila correspondiente en la BD.
 * Útil si el usuario rechaza notificaciones después de aceptar.
 */
export async function removePushSubscription(): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (supabase as any).from("push_subscriptions").delete().eq("endpoint", endpoint);
  } catch (e) {
    console.warn("[push] removePushSubscription failed", e);
  }
}

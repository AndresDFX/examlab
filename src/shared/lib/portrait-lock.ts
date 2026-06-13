/**
 * Forzado de orientación VERTICAL para la PWA instalada (standalone).
 *
 * Contexto del bug: en móvil la PWA al ingresar se abría en HORIZONTAL aunque
 * el teléfono estuviera en vertical y con la autorrotación desactivada. La
 * causa raíz era `manifest.orientation: "any"` (ya cambiado a "portrait") +
 * que las PWA YA INSTALADAS cachean el manifest viejo. El script parse-time de
 * `__root.tsx` hace un `screen.orientation.lock("portrait")` temprano, pero es
 * un ÚNICO intento sin reintento: si `lock()` rechaza porque el modo standalone
 * aún no estaba estable, o por un rechazo transitorio del launcher (Android a
 * veces reporta landscape un instante antes de asentar), el lock no se aplica.
 *
 * Este módulo complementa ese intento: re-asegura el lock tras la hidratación
 * y cuando la PWA vuelve a primer plano / cambia la orientación. Idempotente.
 *
 * No-op fuera de standalone (en el navegador NO bloqueamos orientación) y en
 * navegadores sin la API (iOS Safari — ahí manda el manifest / el SO). Silencia
 * rechazos: `lock()` puede lanzar si otra vista entró a fullscreen.
 */
import { useEffect } from "react";

/** ¿La app corre como PWA instalada (standalone), no en una pestaña normal? */
export function isStandalonePwa(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const mm = window.matchMedia && window.matchMedia("(display-mode: standalone)").matches;
    // iOS expone navigator.standalone (no estándar) en vez de display-mode.
    const ios = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    return Boolean(mm || ios);
  } catch {
    return false;
  }
}

/** Intenta bloquear orientación vertical. No-op si no es PWA standalone o la
 *  API no existe. Silencia rechazos (navegador / fullscreen activo). */
export function lockPortrait(): void {
  if (typeof window === "undefined") return;
  try {
    if (!isStandalonePwa()) return;
    const so = (screen as unknown as { orientation?: { lock?: (o: string) => Promise<void> } })
      .orientation;
    if (so && typeof so.lock === "function") {
      void so.lock("portrait").catch(() => {});
    }
  } catch {
    /* navegador sin API o fullscreen activo → no-op */
  }
}

/** Hook: re-asegura el lock vertical tras montar y en orientationchange /
 *  visibilitychange. No agrega listeners fuera de standalone (cero costo en
 *  navegador). */
export function usePortraitLock(): void {
  useEffect(() => {
    if (!isStandalonePwa()) return;
    lockPortrait();
    const reassert = () => lockPortrait();
    window.addEventListener("orientationchange", reassert);
    document.addEventListener("visibilitychange", reassert);
    return () => {
      window.removeEventListener("orientationchange", reassert);
      document.removeEventListener("visibilitychange", reassert);
    };
  }, []);
}

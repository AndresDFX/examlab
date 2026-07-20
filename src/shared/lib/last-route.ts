/**
 * last-route — "déjame donde estaba" al volver a la app.
 *
 * Análogo general del viewport persistente de la pizarra: guardamos la
 * ÚLTIMA ruta interna visitada y, al ABRIR la app (boot) aterrizando en el
 * índice `/app` (post-login, reopen de la PWA, recarga en la raíz), la
 * restauramos para no dejar al usuario en el dashboard cuando estaba en otra
 * pantalla.
 *
 * Decisiones de diseño:
 *  - Solo se guarda el PATHNAME (no el query): la identidad de la pantalla es
 *    la ruta; los filtros (query) ya tienen su propia persistencia por grid.
 *  - Solo rutas internas `/app/...` y NUNCA el índice `/app` ni rutas
 *    transitorias (toma de examen, juego Kahoot en vivo, unauthorized): no
 *    queremos re-meter al usuario a un examen/juego automáticamente.
 *  - Restauración ONE-SHOT por carga de página (`bootRestoreConsumed`): así un
 *    click en "Inicio" (navegación SPA hacia `/app`) NO dispara el salto — el
 *    flag ya se consumió en el boot. Se resetea solo en una recarga real.
 */
const KEY = "examlab_last_route";

// Prefijos que NO se guardan ni se restauran (flujos en vivo / transitorios).
const EXCLUDED_PREFIXES = [
  "/app/student/take", // toma de examen
  "/app/student/kahoot", // juego Kahoot del alumno (en vivo)
  "/app/teacher/kahoot", // host Kahoot (en vivo)
  "/app/unauthorized",
];

let bootRestoreConsumed = false;
// Ruta con la que se CARGÓ la página (boot). Si la app booteó directo en una
// ruta profunda, el usuario ya está donde quiere → no restauramos (y un click
// posterior en "Inicio" hacia /app NO debe saltar). Solo restauramos cuando el
// boot aterriza en el índice /app (post-login / reopen de PWA / recarga en /app).
const initialPath = typeof window !== "undefined" ? window.location.pathname : "";

function isRestorable(path: string): boolean {
  if (!path.startsWith("/app")) return false;
  if (path === "/app" || path === "/app/") return false; // el índice no
  return !EXCLUDED_PREFIXES.some((p) => path.startsWith(p));
}

/** Guarda la ruta actual como "última visitada" si es restaurable. */
export function saveLastRoute(pathname: string): void {
  if (typeof window === "undefined" || !isRestorable(pathname)) return;
  try {
    window.localStorage.setItem(KEY, pathname);
  } catch {
    /* quota / private mode — no es crítico */
  }
}

/**
 * Devuelve la última ruta a restaurar, SOLO la primera vez que se llama tras
 * cargar la página (boot). Devuelve null si ya se consumió, si no hay, o si la
 * guardada no es restaurable. El caller decide cómo navegar (típicamente
 * window.location porque la ruta puede tener segmentos dinámicos que el
 * `navigate({to})` tipado de TanStack no resuelve desde un string concreto).
 */
/**
 * Lee la última ruta restaurable SIN consumir el flag one-shot ni depender del
 * `initialPath`. Sirve para que el LOGIN resuelva el destino final ANTES de la
 * 1ª navegación dura: así el boot aterriza DIRECTO en la última ruta (no en
 * `/app`) y `consumeBootLastRoute` ya no dispara el 2º `window.location.replace`
 * — eliminando la recarga doble determinista al iniciar sesión.
 */
export function readLastRoute(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(KEY);
    if (v && isRestorable(v)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

export function consumeBootLastRoute(): string | null {
  if (typeof window === "undefined") return null;
  if (bootRestoreConsumed) return null;
  bootRestoreConsumed = true;
  // Solo restauramos si el boot aterrizó en el índice /app. Si booteó en una
  // ruta profunda, el usuario ya está donde quería.
  if (initialPath !== "/app" && initialPath !== "/app/") return null;
  try {
    const v = window.localStorage.getItem(KEY);
    if (v && isRestorable(v)) return v;
  } catch {
    /* ignore */
  }
  return null;
}

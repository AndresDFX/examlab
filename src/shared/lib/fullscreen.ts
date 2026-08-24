/**
 * Pantalla completa, con los prefijos que Safari todavía necesita — y con el
 * modo PWA como equivalente.
 *
 * ── Por qué existe ────────────────────────────────────────────────────
 * La pantalla de toma de examen usaba SOLO la API sin prefijo, en 7 lugares:
 * `document.documentElement.requestFullscreen?.()`, `document.fullscreenElement`,
 * `document.exitFullscreen()` y `addEventListener("fullscreenchange")`.
 *
 * En Safari eso falla de la peor manera posible: `requestFullscreen` es
 * `undefined`, y por el `?.` la llamada **no lanza** — devuelve `undefined` en
 * silencio. Entonces el flujo cae en el chequeo siguiente, que también es sin
 * prefijo, y el alumno recibe «No se pudo activar pantalla completa» sin que
 * nada haya fallado de verdad: la API prefijada estaba ahí, sin usar. Safari
 * expone `webkitRequestFullscreen` / `webkitFullscreenElement` /
 * `webkitExitFullscreen` / `webkitfullscreenchange`.
 *
 * Y aunque hubiera entrado, el listener de `fullscreenchange` nunca se dispara
 * en Safari, así que el strike por salir de pantalla completa no se registraba.
 *
 * ── El caso iPhone, que es distinto ───────────────────────────────────
 * En iPhone la Fullscreen API NO existe para elementos (solo para `<video>`), y
 * no la habilita ni instalar la app. El mensaje de error le decía al alumno
 * «instala la app desde Safari y vuelve a abrir el examen desde el ícono» —
 * pero el código **nunca aceptaba el modo standalone**, así que seguir la
 * instrucción al pie de la letra no cambiaba nada. La instrucción era falsa.
 *
 * Lo que da la app instalada es una ventana SIN CROMO: no hay barra de
 * direcciones, ni pestañas, ni botón de atrás. Para lo que la pantalla completa
 * busca en un examen —que el alumno no tenga otras pestañas a un clic— es
 * equivalente, y de hecho es más difícil de abandonar que un fullscreen que se
 * sale con Esc. Por eso `standalone` se acepta como modo válido.
 *
 * Lo único que el modo standalone NO da es la señal de "salió de pantalla
 * completa", porque no hay de dónde salir. El resto del proctoring
 * —cambio de app, pestaña oculta, copiar/pegar— sigue funcionando igual.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Modo en el que el examen puede correr con la pantalla acotada. */
export type ProctoringMode =
  /** Fullscreen real, por la API (con o sin prefijo). */
  | "fullscreen"
  /** App instalada: ventana sin cromo del navegador. Equivalente para el caso. */
  | "standalone"
  /** Ni una ni otra: la vista NO está acotada. */
  | "ventana";

/**
 * Decide el modo a partir de hechos ya observados. PURA, para poder testear la
 * decisión sin un navegador — que es justo la parte que estaba mal.
 *
 * El orden importa: `fullscreen` gana sobre `standalone` porque, si el alumno
 * está en una app instalada Y además pidió pantalla completa, la señal de salir
 * de fullscreen sí aplica y hay que poder registrarla.
 */
export function proctoringModeFrom(hechos: {
  hayElementoFullscreen: boolean;
  esStandalone: boolean;
}): ProctoringMode {
  if (hechos.hayElementoFullscreen) return "fullscreen";
  if (hechos.esStandalone) return "standalone";
  return "ventana";
}

/** ¿La app corre instalada (sin cromo del navegador)? */
export function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // El estándar. Cubre Android/Chrome y iOS 16.4+.
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
    // Safari en iOS expone su propio flag, y en versiones viejas es el único.
    if ((window.navigator as any).standalone === true) return true;
    // `fullscreen` como display-mode también es sin cromo (algunos manifests
    // lo usan en vez de standalone).
    if (window.matchMedia?.("(display-mode: fullscreen)").matches) return true;
  } catch {
    /* matchMedia puede tirar en contextos raros; se asume que no */
  }
  return false;
}

/** El elemento en pantalla completa, mirando también el prefijo de Safari. */
export function currentFullscreenElement(): Element | null {
  if (typeof document === "undefined") return null;
  const d = document as any;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

/** ¿El navegador expone la API sobre elementos (con o sin prefijo)? */
export function fullscreenApiAvailable(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement as any;
  return typeof el?.requestFullscreen === "function" ||
    typeof el?.webkitRequestFullscreen === "function";
}

/** El modo actual, leyendo el entorno real. */
export function currentProctoringMode(): ProctoringMode {
  return proctoringModeFrom({
    hayElementoFullscreen: currentFullscreenElement() != null,
    esStandalone: isStandaloneDisplay(),
  });
}

/**
 * Pide pantalla completa y devuelve el modo que quedó vigente.
 *
 * No lanza: un examen no se cae porque el navegador rechace el pedido. El
 * caller decide qué hacer con `"ventana"`.
 *
 * Si la API no existe pero la app está instalada, devuelve `"standalone"` sin
 * intentar nada — que es el caso del iPhone y el que antes terminaba en un
 * error que el alumno no podía resolver.
 */
export async function requestFullscreen(
  target?: HTMLElement | null,
): Promise<ProctoringMode> {
  if (typeof document === "undefined") return "ventana";
  const el = (target ?? document.documentElement) as any;
  const pedir: unknown = el?.requestFullscreen ?? el?.webkitRequestFullscreen;

  if (typeof pedir === "function") {
    try {
      await Promise.resolve((pedir as () => Promise<void> | void).call(el));
    } catch {
      /* rechazo del usuario, iframe sin permiso, gesto perdido: se evalúa abajo */
    }
  }
  // Se re-lee el estado en vez de confiar en que la promesa resolvió: hay
  // navegadores que resuelven sin activar nada.
  return currentProctoringMode();
}

/** Sale de pantalla completa si estaba, con el prefijo de Safari. No lanza. */
export async function exitFullscreen(): Promise<void> {
  if (typeof document === "undefined") return;
  const d = document as any;
  if (currentFullscreenElement() == null) return;
  const salir: unknown = d.exitFullscreen ?? d.webkitExitFullscreen;
  if (typeof salir !== "function") return;
  try {
    await Promise.resolve((salir as () => Promise<void> | void).call(d));
  } catch {
    /* si no se puede salir, no hay nada que hacer y no vale tirar el flujo */
  }
}

/**
 * Suscribe al cambio de pantalla completa, registrando LOS DOS eventos.
 *
 * Sin `webkitfullscreenchange`, en Safari el strike por salir de pantalla
 * completa no se registraba nunca. Devuelve la función de limpieza.
 */
export function onFullscreenChange(handler: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("fullscreenchange", handler);
  document.addEventListener("webkitfullscreenchange", handler);
  return () => {
    document.removeEventListener("fullscreenchange", handler);
    document.removeEventListener("webkitfullscreenchange", handler);
  };
}

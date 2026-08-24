/**
 * Pantalla completa, con los prefijos de Safari — y con el modo PWA como
 * equivalente donde la pantalla completa NO EXISTE.
 *
 * ── Lo que se midió, porque la primera hipótesis era falsa ────────────
 * La pantalla de toma usaba SOLO la API sin prefijo, en 7 lugares. La sospecha
 * inicial fue "Safari solo expone la versión `webkit`", y **medido en WebKit
 * 26.4 eso es falso en escritorio**: ahí existen las DOS
 * (`requestFullscreen` y `webkitRequestFullscreen`), así que en un Mac al día
 * el código viejo entraba bien.
 *
 * Lo que sí se midió, con user-agent y viewport de iPhone:
 *
 *   documentElement.requestFullscreen        → undefined
 *   documentElement.webkitRequestFullscreen  → undefined
 *   document.webkitFullscreenElement         → ni siquiera existe la propiedad
 *
 * En iOS **no hay pantalla completa para elementos**, con prefijo ni sin él
 * (solo la tiene `<video>`). Ese es el motivo real por el que el alumno queda
 * bloqueado, y por eso el arreglo que importa no es el prefijo: es aceptar otro
 * modo. Los prefijos quedan porque siguen siendo el único camino en Safari
 * anterior a 16.4 (marzo 2023), y porque ese Safari emite `fullscreenchange`
 * SOLO prefijado — sin escuchar los dos, la advertencia por salir de pantalla
 * completa no se registra.
 *
 * ── El caso iPhone, que es el que bloqueaba ───────────────────────────
 * El mensaje de error le decía al alumno «instala la app desde Safari y vuelve
 * a abrir el examen desde el ícono», pero el código **nunca miraba el modo
 * standalone**, así que seguir la instrucción no cambiaba nada. La instrucción
 * era falsa.
 *
 * Lo que da la app instalada es una ventana SIN CROMO: no hay barra de
 * direcciones, ni pestañas, ni botón de atrás. Para lo que la pantalla completa
 * busca en un examen —que el alumno no tenga otras pestañas a un clic— es
 * equivalente, y de hecho es más difícil de abandonar que un fullscreen que se
 * sale con Esc. Por eso `standalone` se acepta como modo válido.
 *
 * Verificado en WebKit real (Playwright, UA+viewport de iPhone) contra el
 * bundle desplegado: en pestaña de Safari da `"ventana"` y bloquea; con
 * `navigator.standalone` da `"standalone"` y deja rendir.
 *
 * Ojo: para que instalar la app REALMENTE dé una ventana sin cromo hace falta
 * el meta `apple-mobile-web-app-capable` en el `<head>` (`src/routes/__root.tsx`).
 * Sin él, iOS por debajo de 16.4 abre una pestaña normal de Safari y este
 * módulo —correctamente— sigue devolviendo `"ventana"`.
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

/**
 * Lo que el examen necesita decidir: ¿se puede empezar?
 *
 * ── Por qué esto NO es "¿está en pantalla completa?" ──────────────────
 * Bloquear a quien **no quiere** entrar a pantalla completa es la función. A
 * quien **no puede** —porque su plataforma no tiene la API— es un bug: no hay
 * nada que pueda hacer para cumplir, y el examen queda inalcanzable. Esas dos
 * situaciones se veían iguales desde el código viejo (las dos daban "no hay
 * elemento en pantalla completa") y por eso el alumno de iPhone quedaba afuera.
 *
 * En iPhone la API no existe para elementos, **ni instalando la app**. Así que
 * exigir pantalla completa ahí no es una política estricta: es una condición
 * imposible. Y vale notar lo que eso implica: la señal "salió de pantalla
 * completa" no existe en iOS de ninguna manera, instalado o no — el resto del
 * proctoring (cambio de app, pestaña oculta, perder el foco, copiar/pegar) sí
 * funciona igual, y es lo que de hecho detecta que el alumno se fue a otra
 * parte. Lo que se pierde al permitir sin pantalla completa es menos de lo que
 * parece; lo que se ganaba bloqueando era cero.
 */
export type ProctoringGate =
  | { permitir: true; modo: ProctoringMode; motivo: "acotada" }
  /** La plataforma no tiene la API. No hay nada que el alumno pueda hacer. */
  | { permitir: true; modo: "ventana"; motivo: "sin_soporte" }
  /** Se puede, pero no se activó: rechazo, iframe sin permiso, gesto perdido. */
  | { permitir: false; modo: "ventana"; motivo: "rechazada" };

/** PURA: la decisión, para poder testearla sin navegador. */
export function proctoringGateFrom(hechos: {
  modo: ProctoringMode;
  apiDisponible: boolean;
}): ProctoringGate {
  if (hechos.modo !== "ventana") return { permitir: true, modo: hechos.modo, motivo: "acotada" };
  if (!hechos.apiDisponible) return { permitir: true, modo: "ventana", motivo: "sin_soporte" };
  return { permitir: false, modo: "ventana", motivo: "rechazada" };
}

/** La decisión leyendo el entorno real. */
export function currentProctoringGate(): ProctoringGate {
  return proctoringGateFrom({
    modo: currentProctoringMode(),
    apiDisponible: fullscreenApiAvailable(),
  });
}

/** Pide pantalla completa y devuelve la decisión resultante. No lanza. */
export async function requestFullscreenGate(
  target?: HTMLElement | null,
): Promise<ProctoringGate> {
  const modo = await requestFullscreen(target);
  return proctoringGateFrom({ modo, apiDisponible: fullscreenApiAvailable() });
}

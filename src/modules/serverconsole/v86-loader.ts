/**
 * Carga de v86 (emulador x86 → WASM) y xterm.js desde CDN por inyección de
 * <script>, MISMO patrón que el loader de CheerpJ en `src/modules/code/
 * run-java.ts`: singleton por sesión (window globals), guard de SSR, y
 * limpieza del cache si la carga falla (para que un fallo transitorio de red
 * no deje al alumno sin poder reintentar).
 *
 * Motivo de cargar por CDN y NO como dependencia npm: el lockfile del repo es
 * `bun.lock` y agregar deps requiere regenerarlo con `bun install`. Cargar por
 * CDN (como ya hace CheerpJ con `cjrtnc.leaningtech.com`) evita tocar el
 * lockfile y reusa el mismo camino ya probado + cacheado por el service worker
 * (`public/sw.js` cachea `.wasm`).
 *
 * NOTA IMPORTANTE: bootear un Linux real necesita la IMAGEN del SO (varios MB),
 * que NO se puede embeber acá. Se hostea aparte (ver `docs/server-console-v86.md`)
 * y se apunta con las env vars VITE_V86_*.
 */

// Versión de v86 PINEADA (no "latest") para reproducibilidad de examen y para
// evitar drift de API entre deploys.
const V86_VERSION = "0.5.424";
const V86_CDN = `https://cdn.jsdelivr.net/npm/v86@${V86_VERSION}`;
export const V86_WASM_URL = `${V86_CDN}/build/v86.wasm`;
// WHY los BIOS desde gh/ y NO desde npm: el package.json de v86 EXCLUYE `bios/`
// de su lista `files`, así que `npm/v86/bios/seabios.bin` da 404 intermitente
// según el edge del CDN (a veces responde desde un cache stale) → la VM no
// bootea y la consola queda "ready" pero vacía. Los BIOS viven en el repo
// GitHub; el mirror gh de jsDelivr los sirve estable (verificado 200:
// seabios 131072 B, vgabios 36352 B). Son blobs estáticos (no cambian entre
// versiones); para reproducibilidad estricta se puede pinear @master a un SHA.
export const V86_BIOS_URL = "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin";
export const V86_VGABIOS_URL = "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin";
const V86_LIB_URL = `${V86_CDN}/build/libv86.js`;

// xterm se carga como ES MODULE (import dinámico), NO como <script> UMD. WHY:
// el bundle UMD `lib/xterm.js` solo setea `window.Terminal` cuando NO hay
// entorno CommonJS (module/exports) NI AMD (define.amd). Esta app carga Monaco
// (@monaco-editor/react) en las hojas de código de la MISMA pizarra, y su
// loader deja un `window.define.amd` GLOBAL; con AMD presente el UMD de xterm
// toma la rama `define([], factory)` y registra un módulo AMD anónimo que nadie
// consume → NUNCA setea window.Terminal → error "xterm.js no expuso Terminal".
// El ESM entrega el named export `Terminal` sin depender de globals → inmune a
// define.amd / exports / orden de carga. `@xterm/xterm` es el paquete mantenido
// (el viejo `xterm` quedó congelado en 5.3.0). `/+esm` de jsDelivr es un bundle
// self-contained. No toca bun.lock.
const XTERM_VERSION = "5.5.0";
const XTERM_ESM_URL = `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/+esm`;
const XTERM_CSS_URL = `https://cdn.jsdelivr.net/npm/@xterm/xterm@${XTERM_VERSION}/css/xterm.css`;

/** Constructor de v86 (nombre global). Builds recientes exponen `V86`; los
 *  viejos exponían `V86Starter`. Aceptamos ambos. */
export type V86Ctor = new (opts: Record<string, unknown>) => V86Emulator;
export interface V86Emulator {
  add_listener(event: string, cb: (data: unknown) => void): void;
  remove_listener?(event: string, cb: (data: unknown) => void): void;
  serial0_send(data: string): void;
  destroy?(): void;
  stop?(): void;
}

/** Instancia mínima de xterm que usamos. */
export interface XtermTerminal {
  open(container: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onData(cb: (data: string) => void): { dispose(): void };
  dispose(): void;
  focus(): void;
  clear(): void;
  readonly cols: number;
  readonly rows: number;
}
export type XtermCtor = new (opts?: Record<string, unknown>) => XtermTerminal;

type LoaderWindow = Window & {
  V86?: V86Ctor;
  V86Starter?: V86Ctor;
  Terminal?: XtermCtor;
  __v86LibLoading?: Promise<V86Ctor>;
  __xtermLoading?: Promise<XtermCtor>;
};

function injectScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      // Si el navegador ya lo cargó (dataset marca), resolvemos sync.
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`No se pudo cargar ${src}`)), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.loaded = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(s);
  });
}

function injectCss(href: string): Promise<void> {
  return new Promise((resolve) => {
    if (document.querySelector(`link[href="${href}"]`)) return resolve();
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    // Resolvemos también en error: si el CSS no carga, xterm igual renderiza
    // con sus estilos base — no bloqueamos el boot por el stylesheet.
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.appendChild(link);
  });
}

/** Carga libv86.js y devuelve el constructor global (`V86` o `V86Starter`). */
export function loadV86(): Promise<V86Ctor> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  const w = window as LoaderWindow;
  const ctor = w.V86 ?? w.V86Starter;
  if (ctor) return Promise.resolve(ctor);
  if (w.__v86LibLoading) return w.__v86LibLoading;

  const p = (async () => {
    await injectScript(V86_LIB_URL);
    const c = (window as LoaderWindow).V86 ?? (window as LoaderWindow).V86Starter;
    if (!c) throw new Error("libv86.js no expuso el constructor V86");
    return c;
  })();
  p.catch(() => {
    if (w.__v86LibLoading === p) w.__v86LibLoading = undefined;
  });
  w.__v86LibLoading = p;
  return p;
}

/** Carga xterm.js (+ su CSS) y devuelve el constructor global `Terminal`. */
export function loadXterm(): Promise<XtermCtor> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  const w = window as LoaderWindow;
  if (w.Terminal) return Promise.resolve(w.Terminal);
  if (w.__xtermLoading) return w.__xtermLoading;

  const p = (async () => {
    // CSS por <link> (no bloquea el boot si falla). JS por import() dinámico:
    // `@vite-ignore` evita que Vite intente resolver/bundlear la URL externa.
    await injectCss(XTERM_CSS_URL);
    const mod = (await import(/* @vite-ignore */ XTERM_ESM_URL)) as {
      Terminal?: XtermCtor;
      default?: { Terminal?: XtermCtor } | XtermCtor;
    };
    const c =
      mod.Terminal ??
      (mod.default && (mod.default as { Terminal?: XtermCtor }).Terminal) ??
      (typeof mod.default === "function" ? (mod.default as XtermCtor) : undefined);
    if (!c) throw new Error("xterm.js no expuso Terminal");
    w.Terminal = c; // cache para reentradas rápidas
    return c;
  })();
  p.catch(() => {
    if (w.__xtermLoading === p) w.__xtermLoading = undefined;
  });
  w.__xtermLoading = p;
  return p;
}

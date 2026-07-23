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
// wasm + libv86 desde npm PINEADO (inmutable, fiable): el service worker los
// exenta (bypass jsdelivr) y no sufren el problema de `@master` de abajo.
export const V86_WASM_URL = `${V86_CDN}/build/v86.wasm`;
const V86_LIB_URL = `${V86_CDN}/build/libv86.js`;

// BIOS (+ imagen por defecto) self-hosteados en el Storage PROPIO del proyecto.
// WHY se movieron desde `gh/copy/v86@master/bios/*`: `@master` es una ref MÓVIL
// y jsDelivr terminó sirviendo el BIOS con contenido INCONSISTENTE — una range
// request devolvía `content-range: .../69157` mientras el GET completo daba
// 131072 bytes (caché de la ref envenenado entre versiones del master). v86
// descarga el BIOS POR RANGOS, así que recibía tamaño/bytes truncados →
// `download-error` ("No se pudo descargar un recurso del sistema") y la consola
// no booteaba. Supabase Storage sirve un objeto INMUTABLE con content-range
// consistente (verificado: seabios 131072 B, vgabios 36352 B, ambos con
// sha256 idéntico al known-good) y el SW lo exenta (bypass `supabase`), así que
// la descarga por rangos es fiable. Los binarios viven en el bucket público
// `help-docs/v86/`. Derivamos el host de VITE_SUPABASE_URL (mismo proyecto).
const SUPABASE_URL = (
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.VITE_SUPABASE_URL ??
  ""
).replace(/\/+$/, "");
const V86_ASSET_BASE = `${SUPABASE_URL}/storage/v1/object/public/help-docs/v86`;
export const V86_BIOS_URL = `${V86_ASSET_BASE}/seabios.bin`;
export const V86_VGABIOS_URL = `${V86_ASSET_BASE}/vgabios.bin`;
/** Imagen buildroot por DEFAULT, también self-hosteada (antes `i.copy.sh`, un
 *  host de terceros best-effort no apto para producción). La usa
 *  `V86Console` cuando no hay ninguna env `VITE_V86_*` definida. */
export const V86_DEFAULT_BZIMAGE_URL = `${V86_ASSET_BASE}/buildroot-bzimage68.bin`;

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

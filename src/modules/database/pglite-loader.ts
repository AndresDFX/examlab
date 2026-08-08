/**
 * Carga de PGlite (PostgreSQL real compilado a WASM) desde CDN por import()
 * dinámico. MISMO patrón que `serverconsole/v86-loader.ts` y el loader de
 * CheerpJ en `code/run-java.ts`: singleton por sesión (global en `window`),
 * guard de SSR y limpieza del cache si la carga falla — para que un fallo
 * transitorio de red no deje al alumno sin poder reintentar.
 *
 * ── Por qué CDN y no dependencia npm ──────────────────────────────────
 * El lockfile del repo es `bun.lock` y agregar deps obliga a regenerarlo con
 * `bun install` (el CI valida sincronía). Cargar por CDN reusa el camino ya
 * probado por CheerpJ, v86 y xterm, y no toca el lockfile.
 *
 * ── Por qué la RUTA DIRECTA del dist y NO `/+esm` ─────────────────────
 * `dist/index.js` resuelve sus assets con `new URL(..., import.meta.url)` —
 * `pglite.wasm` (~9,9 MB), `pglite.data` (~6,1 MB), `initdb.wasm` (~0,4 MB) —
 * y además importa chunks relativos (`./chunk-*.js`). Con la ruta directa,
 * `import.meta.url` apunta al directorio del CDN y TODO resuelve solo. El
 * bundle `/+esm` de jsDelivr reescribe el módulo y rompería esa resolución
 * relativa: es el mismo tipo de fallo mudo que ya costó caro con el BIOS de
 * v86 servido desde una ref móvil.
 *
 * ── Peso real y qué esperar la primera vez ────────────────────────────
 * Son **~16 MB** de assets. El service worker hace **bypass total de
 * jsdelivr** (`public/sw.js`: `if (url.hostname.includes("jsdelivr.net"))
 * return;`), así que NO quedan en el cache del SW: los cachea el navegador por
 * HTTP (jsDelivr manda cache headers largos y la versión está pineada, así que
 * es inmutable). Traducción práctica: primera carga costosa, siguientes
 * instantáneas, pero **no funciona offline** y en el WiFi de un salón conviene
 * precalentarlo antes de la clase. Es la misma advertencia que el plan de
 * viabilidad de Floci hace sobre el pull de imágenes Docker.
 */

/** Versión PINEADA (no "latest"): reproducibilidad de examen y cero drift de
 *  API entre deploys. Al subirla, re-verificar el named export `PGlite`. */
const PGLITE_VERSION = "0.5.4";
const PGLITE_ESM_URL = `https://cdn.jsdelivr.net/npm/@electric-sql/pglite@${PGLITE_VERSION}/dist/index.js`;

/** Fila de resultado: PGlite devuelve objetos planos por fila. */
export type SqlRow = Record<string, unknown>;

/** Resultado de UNA sentencia, tal como lo expone PGlite. */
export interface PgliteResult {
  rows: SqlRow[];
  fields: Array<{ name: string; dataTypeID: number }>;
  affectedRows?: number;
}

/** Instancia mínima que consumimos. No tipamos toda la API de PGlite: solo lo
 *  que usa el runner, para que una subida de versión no rompa el build por
 *  campos que no tocamos. */
export interface PgliteDb {
  /** Ejecuta UNA sentencia y devuelve su resultado. */
  query: (sql: string) => Promise<PgliteResult>;
  /** Ejecuta N sentencias separadas por `;` y devuelve un resultado por cada
   *  una. Es lo que usa el runner: un ejercicio de SQL casi nunca es una sola
   *  sentencia. */
  exec: (sql: string) => Promise<PgliteResult[]>;
  close: () => Promise<void>;
}

type PgliteCtor = new (options?: Record<string, unknown>) => PgliteDb;

interface LoaderWindow extends Window {
  __pgliteCtor?: PgliteCtor;
  __pgliteLoading?: Promise<PgliteCtor>;
}

/** Carga el constructor `PGlite`. Idempotente y cacheado por sesión. */
export function loadPglite(): Promise<PgliteCtor> {
  if (typeof window === "undefined") return Promise.reject(new Error("SSR"));
  const w = window as LoaderWindow;
  if (w.__pgliteCtor) return Promise.resolve(w.__pgliteCtor);
  if (w.__pgliteLoading) return w.__pgliteLoading;

  const p = (async () => {
    // `@vite-ignore`: evita que Vite intente resolver/bundlear la URL externa.
    const mod = (await import(/* @vite-ignore */ PGLITE_ESM_URL)) as {
      PGlite?: PgliteCtor;
      default?: { PGlite?: PgliteCtor };
    };
    const ctor = mod.PGlite ?? mod.default?.PGlite;
    if (!ctor) throw new Error("PGlite no expuso el constructor PGlite");
    w.__pgliteCtor = ctor;
    return ctor;
  })();
  p.catch(() => {
    if (w.__pgliteLoading === p) w.__pgliteLoading = undefined;
  });
  w.__pgliteLoading = p;
  return p;
}

/**
 * Crea una base EFÍMERA en memoria.
 *
 * Sin `dataDir`, PGlite corre 100% en memoria: nada se persiste y cada
 * instancia arranca limpia. Es lo que queremos —igual que la consola v86, que
 * también es un sandbox efímero— porque el estado entre envíos NO debe filtrar
 * datos de un intento a otro ni entre estudiantes. Si algún día se quiere
 * persistencia, PGlite expone `IdbFs`, pero eso abre la puerta a que el alumno
 * manipule el estado entre intentos: no es un cambio inocuo.
 */
export async function createEphemeralDb(): Promise<PgliteDb> {
  const PGlite = await loadPglite();
  return new PGlite();
}

/** Para mostrar en la UI qué versión corre (soporte/diagnóstico). */
export const PGLITE_PINNED_VERSION = PGLITE_VERSION;

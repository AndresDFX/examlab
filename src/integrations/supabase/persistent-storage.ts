// Storage adapter for Supabase auth that persists in IndexedDB instead
// of localStorage. Razón: en Chrome Android PWA, `localStorage` se
// borra agresivamente cuando el SO presiona memoria mientras la PWA
// está en background, expulsando al usuario a la pantalla de login al
// reabrir la app. IndexedDB es categoría de "persistent storage" en
// la mayoría de browsers móviles y solo se borra explícitamente por
// el usuario o por límite de cuota duro — mucho más fiable.
//
// La interfaz que espera Supabase v2 (`SupportedStorage`) acepta
// retornos sync o Promise; usamos async todo el tiempo, es seguro.
//
// Desde 2026-10-10 se lee primero localStorage (ver el orden más abajo).

import { createStore, get, set, del } from "idb-keyval";

// Store dedicado a auth — separado del de offline-sync para no mezclar
// caches y poder limpiar uno sin tocar el otro.
const store = createStore("examlab-auth", "session");

// Pide al browser marcar el storage como "persistente" — la SO no lo
// desalojará bajo presión de memoria, solo si el usuario lo borra a mano
// desde Settings. Sin esto, Chrome Android puede evictar IndexedDB
// cuando hay poca memoria → el alumno reabre la PWA y se quedó fuera
// aunque tenía sesión válida.
//
// Es idempotente (browser lo recuerda); seguro llamarlo en cada arranque.
// Algunos browsers solo lo conceden si la PWA está "installed" o tiene
// notification permission — ambos casos comunes en ExamLab. Si lo
// rechaza, no rompemos nada — degrada al comportamiento anterior.
let persistenceRequested = false;
async function requestPersistentStorage(): Promise<void> {
  if (persistenceRequested) return;
  persistenceRequested = true;
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.storage &&
      typeof navigator.storage.persist === "function"
    ) {
      // Si ya está persistido no volvemos a pedirlo (algunos browsers
      // muestran prompt; queremos minimizar).
      const already = await navigator.storage.persisted?.();
      if (!already) await navigator.storage.persist();
    }
  } catch {
    // ignore
  }
}

/** Helper: lee localStorage de forma segura (puede tirar en modo
 *  privado de Safari, en SSR, o si las cookies del sitio fueron
 *  bloqueadas). Devuelve null en cualquier error. */
function readLocalStorage(key: string): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeLocalStorage(key: string, value: string | null): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Sin acceso a localStorage — confiamos solo en IndexedDB.
  }
}

/**
 * Tope para cada operación de IndexedDB. Medido en producción (2026-10-10):
 * auth-js lee este almacenamiento en el arranque y en CADA petición, así que si
 * el IndexedDB de WebKit no responde —un bug conocido de Safari, y también una
 * transacción retenida por otra pestaña congelada por iOS— toda la app queda
 * esperando: «Cargando…» y después «No pudimos conectar con el servidor», sin
 * que salga una sola petición. Un estudiante con iPhone lo leyó como «es mi
 * internet». Con el tope, lo peor que pasa es esperar este tiempo UNA vez.
 */
export const MS_TOPE_INDEXEDDB = 1500;

/** Tras el primer vencimiento se deja de esperar a IndexedDB por el resto de la
 *  vida de la página: auth-js lee el almacenamiento cientos de veces por carga,
 *  y pagar el tope en cada lectura sería otro cuelgue, solo que más lento. */
let indexedDbColgado = false;

/** Solo para pruebas. */
export function _reiniciarEstadoIndexedDb(): void {
  indexedDbColgado = false;
}

const VENCIDO = Symbol("vencido");

async function conTope<T>(p: Promise<T>): Promise<T | typeof VENCIDO> {
  if (indexedDbColgado) return VENCIDO;
  let id: ReturnType<typeof setTimeout> | undefined;
  const tope = new Promise<typeof VENCIDO>((res) => {
    id = setTimeout(() => res(VENCIDO), MS_TOPE_INDEXEDDB);
  });
  try {
    const r = await Promise.race([p, tope]);
    if (r === VENCIDO) indexedDbColgado = true;
    return r;
  } catch {
    return VENCIDO;
  } finally {
    if (id) clearTimeout(id);
  }
}

// ── Orden de lectura y escritura ──────────────────────────────────────────
// localStorage se escribe PRIMERO y en el acto (es síncrono: no puede
// colgarse), así que cuando tiene un valor es siempre el más nuevo. Por eso se
// LEE primero: IndexedDB queda como respaldo durable para el caso que motivó
// este archivo —Chrome Android vacía el localStorage de la PWA—, y solo se
// consulta cuando localStorage no tiene nada. Leer primero IndexedDB, como
// antes, además podía devolver una sesión vieja si una escritura en IndexedDB
// quedó atrás.
//
// Cerrar sesión deja una marca en localStorage: si el del() de IndexedDB vence,
// la sesión borrada sigue ahí, y sin la marca la próxima lectura (localStorage
// vacío → IndexedDB) la «resucitaría».
const MARCA_BORRADO = "__borrado";

export const persistentAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    const fromLs = readLocalStorage(key);
    if (fromLs != null) return fromLs;
    if (readLocalStorage(key + MARCA_BORRADO) != null) return null;
    const fromIdb = await conTope(get<string>(key, store));
    if (fromIdb === VENCIDO || fromIdb == null) return null;
    // localStorage fue desalojado y IndexedDB lo tenía: se repara la copia.
    writeLocalStorage(key, fromIdb);
    return fromIdb;
  },
  async setItem(key: string, value: string): Promise<void> {
    // Best-effort: pedir persistencia al primer setItem (cuando el
    // alumno acaba de loguearse). Fire-and-forget — no bloqueamos.
    void requestPersistentStorage();
    writeLocalStorage(key, value);
    writeLocalStorage(key + MARCA_BORRADO, null);
    await conTope(set(key, value, store));
  },
  async removeItem(key: string): Promise<void> {
    writeLocalStorage(key, null);
    writeLocalStorage(key + MARCA_BORRADO, "1");
    const r = await conTope(del(key, store));
    // Borrado de verdad en IndexedDB: la marca ya no hace falta.
    if (r !== VENCIDO) writeLocalStorage(key + MARCA_BORRADO, null);
  },
};

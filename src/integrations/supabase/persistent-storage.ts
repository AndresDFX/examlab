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
// Estrategia de migración: si la fila ya vive en `localStorage` (tabs
// previos al cambio), la portamos a IndexedDB en la primera lectura
// para que el usuario no se vea forzado a re-loggear después del deploy.

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

export const persistentAuthStorage = {
  async getItem(key: string): Promise<string | null> {
    // Primero IndexedDB (la "fuente de verdad" tras la migración).
    const fromIdb = await get<string>(key, store);
    if (fromIdb != null) return fromIdb;
    // Migración perezosa: el usuario tenía sesión en localStorage del
    // cliente anterior. La portamos a IndexedDB y la devolvemos. Las
    // siguientes lecturas ya vienen de IndexedDB directamente.
    const fromLs = readLocalStorage(key);
    if (fromLs != null) {
      try {
        await set(key, fromLs, store);
      } catch {
        // Si IndexedDB no está disponible (modo incógnito Firefox en
        // ciertas builds), seguimos devolviendo el valor de localStorage
        // — al menos el usuario no se queda fuera.
      }
      return fromLs;
    }
    return null;
  },
  async setItem(key: string, value: string): Promise<void> {
    // Best-effort: pedir persistencia al primer setItem (cuando el
    // alumno acaba de loguearse). Fire-and-forget — no bloqueamos.
    void requestPersistentStorage();
    try {
      await set(key, value, store);
    } catch {
      // IndexedDB falló — fall back a localStorage para no perder la
      // sesión de la sesión actual.
      writeLocalStorage(key, value);
      return;
    }
    // Doble escritura como red de seguridad: si IndexedDB se queda
    // corrupto en algún device específico, el cliente anterior puede
    // recuperar la sesión de localStorage. Es una key (~2KB), no
    // compromete cuota.
    writeLocalStorage(key, value);
  },
  async removeItem(key: string): Promise<void> {
    try {
      await del(key, store);
    } catch {
      // ignore
    }
    writeLocalStorage(key, null);
  },
};

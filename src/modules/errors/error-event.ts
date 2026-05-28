/**
 * Helpers puros del módulo de gestión de errores (/app/admin/errors).
 *
 * El scoping + autorización vive en los RPCs SQL (migración
 * 20260713000000); acá solo va lógica de presentación testeable.
 */

export type ErrStatus = "nuevo" | "revisando" | "resuelto" | "ignorado";

/** Estados en orden de flujo. Útil para iterar tiles de conteo. */
export const ERROR_STATUSES: ErrStatus[] = ["nuevo", "revisando", "resuelto", "ignorado"];

/**
 * Forma mínima de un evento de error a efectos de agrupamiento /
 * presentación. La fila completa que devuelve el RPC tiene más campos;
 * acá solo declaramos lo que `fingerprint` y `groupEvents` consumen, para
 * que estos helpers sean testeables sin acoplarse al tipo del RPC.
 */
export interface ErrorEventLike {
  id: string;
  created_at: string;
  action: string;
  category: string;
  status: ErrStatus;
  metadata: unknown;
}

/**
 * Extrae un mensaje corto del `metadata` de un audit_log de error.
 *
 * El metadata es JSON arbitrario (lo escribe quien audita: edges, crons,
 * triggers), así que tratamos la entrada como `unknown` y probamos las
 * claves más comunes en orden de preferencia. Devuelve `null` cuando no
 * hay ninguna string usable — la UI muestra solo la acción en ese caso.
 */
export function errorMessage(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  for (const k of ["error", "reason", "message", "detail"]) {
    if (typeof m[k] === "string" && m[k]) return m[k] as string;
  }
  return null;
}

/**
 * Normaliza un mensaje de error para agruparlo con otros equivalentes:
 *   - lowercase
 *   - colapsa whitespace
 *   - reemplaza UUIDs / ids largos hexadecimales por `?`
 *   - reemplaza secuencias numéricas largas por `N`
 *   - corta a 200 chars
 *
 * El objetivo es que "FK constraint violation on row 8a3f-…" y
 * "FK constraint violation on row b1e2-…" produzcan el mismo
 * fingerprint, pero "FK constraint violation" y "Email already taken" NO.
 */
export function normalizeErrorMessage(msg: string): string {
  return msg
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "?")
    .replace(/[0-9a-f]{12,}/g, "?")
    .replace(/\b\d{4,}\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

/**
 * Fingerprint de agrupamiento. Eventos con el MISMO fingerprint se
 * consideran "el mismo error" para efectos del UI (un solo grupo
 * colapsable con N ocurrencias). La clave combina:
 *
 *   action :: category :: mensaje normalizado (o "" si no hay)
 *
 * `action` y `category` ya son cortos y categorizan el origen; el
 * mensaje normalizado distingue causas dentro de la misma acción
 * (ej. dos errores distintos del mismo edge function).
 */
export function fingerprintEvent(ev: ErrorEventLike): string {
  const msg = errorMessage(ev.metadata);
  const norm = msg ? normalizeErrorMessage(msg) : "";
  return `${ev.action}::${ev.category}::${norm}`;
}

/**
 * Un grupo es N eventos con el mismo `fingerprintEvent`. Conserva un
 * resumen rápido (sample, conteo total, conteos por estado, primera y
 * última ocurrencia) + la lista completa de eventos para expandir.
 */
export interface ErrorEventGroup<T extends ErrorEventLike = ErrorEventLike> {
  fingerprint: string;
  action: string;
  category: string;
  /** Mensaje del primer evento del grupo, sin normalizar — más legible. */
  sampleMessage: string | null;
  /** Total de eventos en el grupo. */
  count: number;
  /** Conteo por estado (las 4 keys, default 0). */
  statusCounts: Record<ErrStatus, number>;
  /** Ocurrencia más antigua (ISO). */
  firstSeen: string;
  /** Ocurrencia más reciente (ISO). */
  lastSeen: string;
  /** Eventos del grupo, ordenados de más nuevo a más viejo. */
  events: T[];
}

/**
 * Agrupa una lista de eventos por fingerprint. Los grupos resultantes
 * vienen ordenados por `lastSeen` desc (los grupos "más activos" primero).
 * Dentro de cada grupo, los eventos van también de más nuevo a más viejo.
 */
export function groupEvents<T extends ErrorEventLike>(events: T[]): ErrorEventGroup<T>[] {
  const map = new Map<string, ErrorEventGroup<T>>();
  for (const ev of events) {
    const fp = fingerprintEvent(ev);
    let g = map.get(fp);
    if (!g) {
      g = {
        fingerprint: fp,
        action: ev.action,
        category: ev.category,
        sampleMessage: errorMessage(ev.metadata),
        count: 0,
        statusCounts: { nuevo: 0, revisando: 0, resuelto: 0, ignorado: 0 },
        firstSeen: ev.created_at,
        lastSeen: ev.created_at,
        events: [],
      };
      map.set(fp, g);
    }
    g.count += 1;
    g.statusCounts[ev.status] = (g.statusCounts[ev.status] ?? 0) + 1;
    if (ev.created_at < g.firstSeen) g.firstSeen = ev.created_at;
    if (ev.created_at > g.lastSeen) g.lastSeen = ev.created_at;
    g.events.push(ev);
    // Si este evento es más antiguo que el sample actual, no cambies el
    // sample (ya tenemos uno). Pero si todavía no hay mensaje y este sí,
    // tomalo — así un grupo sin metadata útil en el primer evento puede
    // recuperar un mensaje legible de otro evento posterior.
    if (!g.sampleMessage) g.sampleMessage = errorMessage(ev.metadata);
  }
  for (const g of map.values()) {
    g.events.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  return [...map.values()].sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
}

/**
 * Status agregado de un grupo: el "menos resuelto" de sus eventos. Sirve
 * para pintar un único badge por grupo en la fila colapsada. Reglas:
 *
 *   nuevo > revisando > resuelto > ignorado
 *
 * Es decir: si hay al menos un 'nuevo' → 'nuevo'; si no, si hay
 * 'revisando' → 'revisando'; etc. Grupos vacíos retornan 'ignorado'.
 */
export function aggregateGroupStatus(counts: Record<ErrStatus, number>): ErrStatus {
  if ((counts.nuevo ?? 0) > 0) return "nuevo";
  if ((counts.revisando ?? 0) > 0) return "revisando";
  if ((counts.resuelto ?? 0) > 0) return "resuelto";
  return "ignorado";
}

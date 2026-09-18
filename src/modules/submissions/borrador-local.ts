/**
 * Borrador LOCAL de las respuestas de un taller o un proyecto que todavía no se
 * entregaron.
 *
 * ── Por qué ──────────────────────────────────────────────────────────
 * El taller y el proyecto se responden dentro de un diálogo y solo escriben en
 * la base al ENTREGAR. Un clic fuera del diálogo lo cierra, y con él se iba todo
 * lo escrito: media hora de trabajo sin ningún rastro. El examen ya estaba
 * cubierto —autoguarda cada 1,5 s y además tiene `offline-sync`—, así que el
 * agujero eran estos dos.
 *
 * ── Por qué localStorage y no IndexedDB como el examen ───────────────
 * Lo que guarda `offline-sync` es una COLA de entregas pendientes de sincronizar
 * con el servidor, que es un problema distinto y más pesado. Acá no hay nada que
 * sincronizar: es un borrador del propio dispositivo que existe hasta que la
 * entrega sale. localStorage es síncrono, lo que permite escribir en el
 * `beforeunload` (IndexedDB no garantiza terminar ahí), y el volumen es texto.
 *
 * ── Qué NO hace ──────────────────────────────────────────────────────
 * No reemplaza la entrega ni cuenta como tal, y al restaurar NUNCA pisa una
 * respuesta que el servidor ya tenga: solo rellena las que están vacías. Un
 * taller en grupo puede tener la respuesta de un compañero guardada mientras
 * este dispositivo tenía un borrador viejo, y hacerla desaparecer sería peor que
 * el problema original.
 */

/** Sube con el formato; una versión distinta se descarta en vez de interpretarse mal. */
const VERSION = 1;

/** Borradores más viejos que esto no se ofrecen: el taller ya venció o cambió. */
export const DIAS_DE_VIDA = 30;

export type TipoEntregable = "taller" | "proyecto";

export interface BorradorGuardado {
  v: number;
  /** ISO. Se muestra al restaurar y decide la caducidad. */
  guardadoEn: string;
  respuestas: Record<string, unknown>;
}

/**
 * La clave incluye el usuario porque un mismo navegador lo usan varias personas
 * (salas de cómputo de la universidad): sin eso, el borrador de una quedaría
 * ofrecido a la siguiente.
 */
export function claveBorrador(
  tipo: TipoEntregable,
  entregableId: string,
  userId: string | null | undefined,
): string {
  return `examlab_borrador:${tipo}:${entregableId}:${userId ?? "anon"}`;
}

/** Toda lectura/escritura pasa por acá: en navegación privada o con el
 *  almacenamiento bloqueado, `localStorage` LANZA en vez de devolver null. */
function almacenamiento(): Storage | null {
  try {
    if (typeof window === "undefined" || !window.localStorage) return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** ¿Hay algo que valga la pena guardar? Un borrador vacío solo ocuparía lugar y
 *  haría que al reabrir se ofrezca restaurar la nada. */
export function tieneContenido(respuestas: Record<string, unknown>): boolean {
  return Object.values(respuestas).some((v) => !esVacia(v));
}

/** Una respuesta «vacía» según cada forma en que se guarda una: texto, índice de
 *  opción, lista de índices, objeto de red/SQL. */
export function esVacia(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  // Un 0 es la primera opción de una cerrada: es una respuesta, no un vacío.
  return false;
}

export function guardarBorrador(clave: string, respuestas: Record<string, unknown>): void {
  const store = almacenamiento();
  if (!store) return;
  try {
    if (!tieneContenido(respuestas)) {
      store.removeItem(clave);
      return;
    }
    const payload: BorradorGuardado = {
      v: VERSION,
      guardadoEn: new Date().toISOString(),
      respuestas,
    };
    store.setItem(clave, JSON.stringify(payload));
  } catch {
    // Cuota llena o modo privado. Perder el borrador es malo, pero tumbar la
    // pantalla de entrega por no poder guardarlo es peor.
  }
}

export function leerBorrador(clave: string, ahora: Date = new Date()): BorradorGuardado | null {
  const store = almacenamiento();
  if (!store) return null;
  try {
    const crudo = store.getItem(clave);
    if (!crudo) return null;
    const p = JSON.parse(crudo) as Partial<BorradorGuardado>;
    if (p?.v !== VERSION) return null;
    if (!p.respuestas || typeof p.respuestas !== "object" || Array.isArray(p.respuestas)) return null;
    const ts = new Date(p.guardadoEn ?? "").getTime();
    if (!Number.isFinite(ts)) return null;
    if ((ahora.getTime() - ts) / 86_400_000 > DIAS_DE_VIDA) {
      store.removeItem(clave);
      return null;
    }
    return { v: VERSION, guardadoEn: p.guardadoEn as string, respuestas: p.respuestas };
  } catch {
    return null;
  }
}

export function borrarBorrador(clave: string): void {
  const store = almacenamiento();
  if (!store) return;
  try {
    store.removeItem(clave);
  } catch {
    /* ver guardarBorrador */
  }
}

/**
 * Las del servidor mandan; el borrador solo RELLENA lo que quedó vacío.
 *
 * Devuelve también qué preguntas se recuperaron, para poder decírselo al
 * estudiante: restaurar en silencio deja a alguien preguntándose si lo que ve
 * es lo que había escrito o algo que la aplicación se inventó.
 */
export function combinarConBorrador(
  delServidor: Record<string, unknown>,
  borrador: Record<string, unknown> | null | undefined,
): { respuestas: Record<string, unknown>; recuperadas: string[] } {
  if (!borrador) return { respuestas: delServidor, recuperadas: [] };
  const out = { ...delServidor };
  const recuperadas: string[] = [];
  for (const [qid, valor] of Object.entries(borrador)) {
    if (esVacia(valor)) continue;
    if (!esVacia(out[qid])) continue;
    out[qid] = valor;
    recuperadas.push(qid);
  }
  return { respuestas: recuperadas.length > 0 ? out : delServidor, recuperadas };
}

/**
 * Pendientes para la próxima sesión — la regla de a qué clase le toca cada uno.
 *
 * El pendiente se guarda en la sesión donde se ANOTÓ (`session_id`, mig
 * `20262640000000`) y se muestra para la que viene. Esa sesión no se guarda:
 * se resuelve acá, contra la lista de sesiones del curso. Así, uno anotado en
 * la última sesión creada no queda sin lugar: aparece el día que exista la
 * siguiente.
 *
 * Tres reglas que no se ven desde la tabla:
 *
 *  - **«La próxima sesión» es la del siguiente DÍA de clase.** Un bloque
 *    partido (dos sesiones el mismo día, que la asistencia múltiple abre con un
 *    solo código) es la misma clase: lo anotado en la primera parte no es «para
 *    la próxima» si la próxima empieza una hora después.
 *  - **Un pendiente se muestra hasta el día de esa próxima sesión, y ahí
 *    caduca.** No se arrastra a las clases siguientes aunque nadie lo haya
 *    tachado: los estudiantes lo ven en el tablero del curso, y un «traigan el
 *    taller impreso» de hace dos semanas es ruido que enseña a no leer la
 *    tarjeta. Tachar sirve para retirarlo antes.
 *  - Las fechas se comparan por DÍA local (`yyyy-MM-dd` contra `yyyy-MM-dd`),
 *    nunca por instante: `session_date` es una columna DATE y el mismo error de
 *    UTC que justifica `formatDateOnly` correría un día el pendiente.
 */

export interface SesionOrdenable {
  id: string;
  /** `yyyy-MM-dd`. */
  session_date: string;
  /** `HH:MM:SS` o null. */
  start_time?: string | null;
}

export interface PendienteSesion {
  id: string;
  /** Sesión donde se anotó. */
  session_id: string;
  body: string;
  /** null = abierto. */
  done_at: string | null;
  position: number;
  created_at: string;
}

/** Tope del texto, igual al CHECK de la tabla. */
export const MAX_CARACTERES_PENDIENTE = 500;

/**
 * Orden cronológico: fecha, después hora (sin hora al final del día) y, para
 * desempatar, el id — así dos sesiones del mismo bloque sin hora salen siempre
 * en el mismo orden y «la próxima» no cambia entre una carga y la otra.
 */
export function ordenarSesiones<T extends SesionOrdenable>(sesiones: readonly T[]): T[] {
  return [...sesiones].sort((a, b) => {
    if (a.session_date !== b.session_date) return a.session_date < b.session_date ? -1 : 1;
    const ha = a.start_time ?? "99:99:99";
    const hb = b.start_time ?? "99:99:99";
    if (ha !== hb) return ha < hb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * La próxima sesión de la que anota: la primera en un día POSTERIOR. Null si no
 * hay ninguna todavía (o si la sesión no está en la lista).
 */
export function sesionSiguiente<T extends SesionOrdenable>(
  sesiones: readonly T[],
  sessionId: string,
): T | null {
  const orden = ordenarSesiones(sesiones);
  const origen = orden.find((s) => s.id === sessionId);
  if (!origen) return null;
  return orden.find((s) => s.session_date > origen.session_date) ?? null;
}

/**
 * La sesión en la que le toca a un pendiente anotado en `origenId`, mientras
 * siga vigente: su próxima sesión, si todavía es hoy o después. Si esa sesión
 * ya pasó, el pendiente caducó y devuelve null (ver el encabezado).
 */
export function sesionDondeToca<T extends SesionOrdenable>(
  sesiones: readonly T[],
  origenId: string,
  hoy: string,
): T | null {
  const siguiente = sesionSiguiente(sesiones, origenId);
  return siguiente && siguiente.session_date >= hoy ? siguiente : null;
}

/** Orden dentro de una lista: el que el docente fijó, y el más viejo primero. */
export function ordenarPendientes(items: readonly PendienteSesion[]): PendienteSesion[] {
  return [...items].sort(
    (a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0),
  );
}

/**
 * Pendientes ABIERTOS y vigentes, agrupados por la sesión donde tocan. Es lo
 * que pinta el aviso de cada columna de Asistencia y la tarjeta del tablero.
 * Los tachados no entran: ya no son pendientes.
 */
export function pendientesPorSesionDestino(
  sesiones: readonly SesionOrdenable[],
  pendientes: readonly PendienteSesion[],
  hoy: string,
): Map<string, PendienteSesion[]> {
  const porDestino = new Map<string, PendienteSesion[]>();
  // Un origen se resuelve una sola vez aunque tenga varios pendientes.
  const destinoDe = new Map<string, string | null>();
  for (const p of pendientes) {
    if (p.done_at) continue;
    if (!destinoDe.has(p.session_id)) {
      destinoDe.set(p.session_id, sesionDondeToca(sesiones, p.session_id, hoy)?.id ?? null);
    }
    const destino = destinoDe.get(p.session_id);
    if (!destino) continue;
    const lista = porDestino.get(destino) ?? [];
    lista.push(p);
    porDestino.set(destino, lista);
  }
  for (const [k, v] of porDestino) porDestino.set(k, ordenarPendientes(v));
  return porDestino;
}

/** Los anotados EN una sesión (abiertos y tachados), en su orden. */
export function pendientesAnotadosEn(
  pendientes: readonly PendienteSesion[],
  sessionId: string,
): PendienteSesion[] {
  return ordenarPendientes(pendientes.filter((p) => p.session_id === sessionId));
}

/** Posición para un pendiente nuevo en esa sesión: al final de su lista. */
export function siguientePosicion(pendientes: readonly PendienteSesion[], sessionId: string): number {
  return (
    pendientes
      .filter((p) => p.session_id === sessionId)
      .reduce((max, p) => Math.max(max, p.position), -1) + 1
  );
}

/** El texto tal como se va a guardar, o null si no hay nada que guardar. */
export function normalizarTextoPendiente(texto: string): string | null {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (!limpio) return null;
  return limpio.slice(0, MAX_CARACTERES_PENDIENTE);
}

/** Tope de líneas que se toman de una sola vez (el campo del check-in). */
export const MAX_PENDIENTES_POR_LOTE = 20;

/**
 * El campo del check-in acepta varios pendientes, UNO POR LÍNEA. Devuelve los
 * textos listos para guardar: sin líneas vacías, sin repetidos (sin distinguir
 * mayúsculas), sin la viñeta que traiga si se pegó de otro lado, y con el tope
 * de la tabla aplicado a cada uno.
 */
export function lineasDePendientes(texto: string): string[] {
  return todasLasLineas(texto).slice(0, MAX_PENDIENTES_POR_LOTE);
}

/**
 * ¿Cuántas quedan AFUERA por el tope? Existe para poder decirlo: recortar en
 * silencio deja al docente creyendo que anotó una lista que se guardó a medias.
 */
export function pendientesQueNoEntran(texto: string): number {
  return Math.max(0, todasLasLineas(texto).length - MAX_PENDIENTES_POR_LOTE);
}

function todasLasLineas(texto: string): string[] {
  const vistos = new Set<string>();
  const out: string[] = [];
  for (const linea of texto.split(/\r?\n/)) {
    // Una viñeta pegada desde otro lado («- », «• », «1. ») no es parte del texto.
    const limpio = normalizarTextoPendiente(linea.replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, ""));
    if (!limpio || vistos.has(limpio.toLowerCase())) continue;
    vistos.add(limpio.toLowerCase());
    out.push(limpio);
  }
  return out;
}

export interface GrupoPendientes<T extends SesionOrdenable = SesionOrdenable> {
  sesion: T;
  items: PendienteSesion[];
}

/**
 * Lo que muestra la tarjeta del tablero: un grupo por cada sesión vigente que
 * tiene pendientes, en orden de fecha. El día de una clase suelen ser dos —
 * lo que quedó para hoy y lo que se acaba de anotar para la siguiente—, y
 * mostrar los dos es lo que hace que el docente vea al instante lo que anotó
 * al abrir el check-in.
 */
export function gruposDePendientes<T extends SesionOrdenable>(
  sesiones: readonly T[],
  pendientes: readonly PendienteSesion[],
  hoy: string,
): GrupoPendientes<T>[] {
  const porId = new Map(sesiones.map((x) => [x.id, x]));
  const mapa = pendientesPorSesionDestino(sesiones, pendientes, hoy);
  const grupos: GrupoPendientes<T>[] = [];
  for (const [id, items] of mapa) {
    const sesion = porId.get(id);
    if (sesion && items.length > 0) grupos.push({ sesion, items });
  }
  const orden = ordenarSesiones(grupos.map((g) => g.sesion));
  return orden.map((ses) => grupos.find((g) => g.sesion.id === ses.id)!);
}

/**
 * En qué estado está la conversación de UNA pregunta, visto por quien califica.
 *
 * Un hilo abierto puede esperar dos cosas distintas, y hasta ahora solo una se
 * veía: si el último mensaje es del ESTUDIANTE, falta responder (rojo); si es del
 * docente —o del staff— y el hilo sigue abierto, falta CERRARLO (ámbar). El
 * segundo caso se pintaba igual que una pregunta sin nada pendiente, así que un
 * reclamo ya contestado quedaba abierto para siempre sin que nadie lo notara, y el
 * estudiante lo seguía viendo como «en conversación».
 *
 * Una pregunta puede tener varios hilos: manda el más urgente (responder > cerrar).
 */
export interface ResumenConversacion {
  /** Hilos ABIERTOS de la pregunta. */
  count: number;
  /** Alguno tiene como último mensaje uno del estudiante. */
  pending: boolean;
  /** Alguno sigue abierto con el último mensaje del staff (o sin mensajes).
   *  Opcional por compatibilidad: sin el dato, un hilo abierto que no espera
   *  respuesta se toma como «falta cerrar», que es lo único que puede ser. */
  awaitingClose?: boolean;
}

export type EstadoConversacion = "responder" | "cerrar";

export function estadoDeConversacion(
  r: ResumenConversacion | null | undefined,
): EstadoConversacion | null {
  if (!r || r.count <= 0) return null;
  if (r.pending) return "responder";
  if (r.awaitingClose ?? true) return "cerrar";
  return null;
}

/**
 * Resumen por pregunta a partir de los hilos abiertos y del autor del último
 * comentario de cada uno. `ownerDe` dice de quién es la entrega (el estudiante).
 * Es la cuenta que hacían, copiada, el monitor de exámenes y la calificación de
 * talleres.
 */
export function resumirHilos(
  hilos: ReadonlyArray<{ id: string; submission_id: string; question_id: string }>,
  ultimoAutorDe: ReadonlyMap<string, string>,
  ownerDe: ReadonlyMap<string, string>,
): Record<string, ResumenConversacion> {
  const out: Record<string, ResumenConversacion> = {};
  for (const h of hilos) {
    const owner = ownerDe.get(h.submission_id);
    if (!owner) continue;
    const key = `${h.submission_id}:${h.question_id}`;
    const r = (out[key] ??= { count: 0, pending: false, awaitingClose: false });
    r.count++;
    if (ultimoAutorDe.get(h.id) === owner) r.pending = true;
    else r.awaitingClose = true;
  }
  return out;
}

/** Cuántas preguntas faltan responder y cuántas faltan cerrar. */
export function contarPorEstado(resumenes: Iterable<ResumenConversacion | undefined>): {
  responder: number;
  cerrar: number;
} {
  let responder = 0;
  let cerrar = 0;
  for (const r of resumenes) {
    const e = estadoDeConversacion(r);
    if (e === "responder") responder++;
    else if (e === "cerrar") cerrar++;
  }
  return { responder, cerrar };
}

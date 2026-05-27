/**
 * Helpers puros del flujo de difusión (broadcast) docente/admin → curso(s).
 *
 * El broadcast manda un anuncio a TODOS los estudiantes de uno o más
 * cursos: notificación in-app + correo por destinatario + replica como
 * mensaje 1-a-1. La lógica con efectos (queries, inserts, SMTP) vive en
 * la edge `supabase/functions/broadcast-course-message`; acá quedan las
 * piezas puras que SÍ se pueden testear sin DB.
 *
 * INVARIANTE: la edge replica estas tres funciones (es Deno y no puede
 * importar de `src/`). Si cambias el formato del body, el orden canónico
 * o la lógica de dedup, actualiza AMBOS lados.
 */

/** Tope de `messages.body` (CHECK en la tabla). El body del broadcast se
 *  trunca a este largo antes de insertar. */
export const BROADCAST_BODY_MAX = 4000;

/**
 * Convierte los tokens de tag `[[T:type:id:label]]` a su forma humana
 * `#label`, para contextos que NO renderizan chips (notificación in-app,
 * correo). El mensaje replicado en /app/messages conserva los tokens
 * crudos para que el chat los pinte como chips clickeables; pero el bell
 * y el email mostrarían `[[T:...]]` feo — acá los aplanamos a `#label`.
 *
 * Réplica de la regex de `message-tags.ts` (Deno no importa de src/).
 */
export function humanizeTags(body: string): string {
  return body.replace(
    /\[\[T:(?:workshop|exam|project|content|video):[0-9a-f-]+:([^\]]+)\]\]/g,
    (_m, label) => `#${label}`,
  );
}

/**
 * Construye el cuerpo del mensaje de difusión con el prefijo 📢, de modo
 * que se distinga visualmente de un mensaje 1-a-1 normal en /app/messages.
 * Trunca a `BROADCAST_BODY_MAX` para respetar el CHECK de messages.body.
 */
export function buildBroadcastBody(subject: string, body: string): string {
  return `📢 ${subject}\n\n${body}`.slice(0, BROADCAST_BODY_MAX);
}

/**
 * Orden canónico de una conversación: `user_a < user_b` (lexicográfico
 * de UUID). La tabla `conversations` tiene CHECK `user_a < user_b` +
 * UNIQUE `(user_a, user_b)`, así que cualquier par debe normalizarse
 * antes de upsert.
 */
export function canonicalConvPair(a: string, b: string): { user_a: string; user_b: string } {
  return a < b ? { user_a: a, user_b: b } : { user_a: b, user_b: a };
}

/**
 * Dedup de destinatarios a través de varios cursos. Un alumno matriculado
 * en 2+ cursos seleccionados debe recibir UNA sola notificación / correo /
 * mensaje, no uno por curso. Recibe la lista de `user_id`s por curso (con
 * posible solapamiento), descarta vacíos y al `excludeUserId` (el propio
 * sender, defensivo) y devuelve el set único preservando el orden de
 * primera aparición.
 */
export function dedupeRecipients(
  enrollmentsByCourse: ReadonlyArray<ReadonlyArray<string>>,
  excludeUserId?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of enrollmentsByCourse) {
    for (const id of list) {
      if (!id || id === excludeUserId || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Normaliza el input de cursos del request a un array de IDs únicos y no
 * vacíos. Acepta el shape nuevo (`courseIds: string[]`) y el legacy
 * (`courseId: string`) para no romper callers viejos. Devuelve [] si no
 * hay ninguno válido — el caller decide si eso es un 400.
 */
export function normalizeCourseIds(input: { courseId?: unknown; courseIds?: unknown }): string[] {
  const raw: unknown[] = Array.isArray(input.courseIds)
    ? input.courseIds
    : input.courseId != null
      ? [input.courseId]
      : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const id = v.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

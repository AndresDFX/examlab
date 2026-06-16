/**
 * Detección de rebote PERMANENTE de buzón/usuario para auto-supresión.
 *
 * Fuente de verdad de la decisión "¿debo dejar de enviar a esta dirección?".
 * REPLICADA en `supabase/functions/send-email/index.ts` (`isPermanentMailboxError`)
 * — Deno edge no puede importar de `src/`. Si cambias la lógica acá, sincroniza
 * el edge; los tests de este módulo son la fuente de verdad del comportamiento.
 *
 * Regla clave: SÓLO permanentes (5.x.x). Un rebote 4.x es TRANSITORIO (el
 * servidor reintenta) — auto-suprimir por un 4.x bloquearía una dirección que
 * se recupera sola (ej. "452 4.2.2 out of storage TEMPORAL"). Por eso exigimos
 * AMBOS: código permanente Y patrón de buzón/usuario muerto.
 */
export function isPermanentMailboxError(msg: string): boolean {
  const m = (msg ?? "").toLowerCase();
  // Código permanente: enhanced status 5.1.x / 5.2.x, o un 55x crudo.
  const permanent = /\b5\.[12]\.\d\b/.test(m) || /\b55\d\b/.test(m);
  const mailboxIssue =
    /mailbox.*(full|unavailable|disabled)/.test(m) ||
    /over.?quota/.test(m) ||
    /out of storage/.test(m) ||
    /(does not|doesn'?t) exist/.test(m) ||
    /(user|recipient|mailbox|address|account).*(unknown|not found|disabled)/.test(m) ||
    /no such (user|mailbox|recipient|address)/.test(m) ||
    /recipient.*reject/.test(m) ||
    /address rejected/.test(m);
  return permanent && mailboxIssue;
}

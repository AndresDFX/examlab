/**
 * Port TS de la función SQL `compute_members_key(_member_ids UUID[])`.
 *
 * Genera el hash determinístico que la tabla `group_chats.members_key`
 * usa para dedup de chats ad-hoc. Misma selección de miembros → mismo
 * hash → encuentra el chat existente en lugar de crear uno nuevo.
 *
 * Spec (espejo del SQL, mig 20260806000000):
 *   1. Dedup el array de UUIDs.
 *   2. Ordenar ASC alfabéticamente.
 *   3. Join con coma ",".
 *   4. SHA-256.
 *   5. Encode hex lowercase.
 *
 * Frontend lo usa para detección optimista — antes de llamar al RPC
 * podemos verificar si el set actual coincide con un chat ya cargado
 * en memoria. La autoridad final sigue siendo el SQL (la UNIQUE INDEX
 * en `group_chats(members_key)` impide colisiones).
 *
 * INVARIANTE cross-file (registrado en CLAUDE.md):
 *   - SQL: supabase/migrations/20260806000000_group_chats.sql (función
 *     compute_members_key con `extensions.digest(..., 'sha256')`).
 *   - TS: este archivo (usa crypto.subtle.digest("SHA-256", ...)).
 *   - Ambos producen hex lowercase de 64 chars. Si uno cambia
 *     (case, separador, encoding), sincronizar el otro y los tests.
 */

/** Sort + dedup determinístico. UUIDs como string. */
export function canonicalizeMemberIds(memberIds: string[]): string[] {
  return Array.from(new Set(memberIds)).sort();
}

/** Hex lowercase de un ArrayBuffer / Uint8Array. */
function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let hex = "";
  for (const b of arr) hex += b.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Computa el members_key idéntico al SQL `compute_members_key`. Async
 * porque usa `crypto.subtle.digest`, que retorna una promesa en
 * navegadores y Node 18+.
 */
export async function computeMembersKey(memberIds: string[]): Promise<string> {
  const sorted = canonicalizeMemberIds(memberIds);
  const joined = sorted.join(",");
  const data = new TextEncoder().encode(joined);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(digest);
}

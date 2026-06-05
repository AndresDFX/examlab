import { describe, expect, it } from "vitest";
import { canonicalizeMemberIds, computeMembersKey } from "./group-chat-members-key";

const UID_A = "11111111-1111-1111-1111-111111111111";
const UID_B = "22222222-2222-2222-2222-222222222222";
const UID_C = "33333333-3333-3333-3333-333333333333";

describe("canonicalizeMemberIds", () => {
  it("ordena ascendente", () => {
    expect(canonicalizeMemberIds([UID_C, UID_A, UID_B])).toEqual([UID_A, UID_B, UID_C]);
  });

  it("dedup conserva la primera aparición y ordena", () => {
    expect(canonicalizeMemberIds([UID_B, UID_A, UID_B, UID_A])).toEqual([UID_A, UID_B]);
  });

  it("array vacío → array vacío", () => {
    expect(canonicalizeMemberIds([])).toEqual([]);
  });

  it("un solo id", () => {
    expect(canonicalizeMemberIds([UID_A])).toEqual([UID_A]);
  });
});

describe("computeMembersKey", () => {
  it("retorna hex lowercase de 64 chars (sha256)", async () => {
    const key = await computeMembersKey([UID_A, UID_B]);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("es determinístico — misma input → mismo hash", async () => {
    const k1 = await computeMembersKey([UID_A, UID_B, UID_C]);
    const k2 = await computeMembersKey([UID_A, UID_B, UID_C]);
    expect(k1).toBe(k2);
  });

  it("permutaciones del set producen el MISMO hash (orden no importa)", async () => {
    const k1 = await computeMembersKey([UID_A, UID_B, UID_C]);
    const k2 = await computeMembersKey([UID_C, UID_A, UID_B]);
    const k3 = await computeMembersKey([UID_B, UID_C, UID_A]);
    expect(k1).toBe(k2);
    expect(k2).toBe(k3);
  });

  it("dedup interno — duplicates no cambian el hash", async () => {
    const k1 = await computeMembersKey([UID_A, UID_B]);
    const k2 = await computeMembersKey([UID_A, UID_B, UID_A, UID_B]);
    expect(k1).toBe(k2);
  });

  it("sets distintos producen hashes distintos", async () => {
    const k1 = await computeMembersKey([UID_A, UID_B]);
    const k2 = await computeMembersKey([UID_A, UID_C]);
    const k3 = await computeMembersKey([UID_A, UID_B, UID_C]);
    expect(k1).not.toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k2).not.toBe(k3);
  });

  it("hash de set vacío difiere del hash de un solo id", async () => {
    const empty = await computeMembersKey([]);
    const one = await computeMembersKey([UID_A]);
    expect(empty).not.toBe(one);
  });

  it("vector conocido: SHA-256 de UIDs ordenados unidos por coma", async () => {
    // El SQL hace: encode(digest(array_to_string(sorted, ','), 'sha256'), 'hex').
    // Acá replicamos manualmente para confirmar que pegamos lo mismo.
    const sorted = [UID_A, UID_B].sort().join(",");
    const expected = await sha256HexReference(sorted);
    const actual = await computeMembersKey([UID_B, UID_A]);
    expect(actual).toBe(expected);
  });

  it("CONTRATO con SQL — vector verificado contra producción", async () => {
    // Vector empírico: capturé este hash llamando a la RPC
    // `compute_members_key` en runtime (Supabase project uxxpzfsfcnqiwwdxoelm)
    // con input ["00000000-0000-0000-0000-000000000001"]. Si el JS port
    // produce un valor distinto, las dos implementaciones divergieron y
    // el dedup de chats ad-hoc fallaría silencioso (mismo set de miembros
    // produciría chats nuevos en cada compose en lugar de reutilizar).
    const sqlExpected = "7ac1b8d7010bb6cd3a3e84e7f90136b880bbc899e428ece49333372911ab9052";
    const jsActual = await computeMembersKey(["00000000-0000-0000-0000-000000000001"]);
    expect(jsActual).toBe(sqlExpected);
  });
});

/** Helper interno: sha256 hex via crypto.subtle. Sirve como
 *  oracle independiente para el test de "vector conocido" — si el
 *  port cambia su implementación, este oracle sigue produciendo la
 *  misma referencia. */
async function sha256HexReference(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

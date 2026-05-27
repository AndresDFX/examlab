import { describe, it, expect } from "vitest";
import {
  BROADCAST_BODY_MAX,
  buildBroadcastBody,
  canonicalConvPair,
  dedupeRecipients,
  normalizeCourseIds,
  humanizeTags,
} from "./broadcast";

describe("buildBroadcastBody", () => {
  it("prefija con 📢 y separa asunto del cuerpo con doble salto", () => {
    expect(buildBroadcastBody("Asunto", "Cuerpo")).toBe("📢 Asunto\n\nCuerpo");
  });

  it("preserva saltos de línea del cuerpo", () => {
    expect(buildBroadcastBody("A", "línea1\nlínea2")).toBe("📢 A\n\nlínea1\nlínea2");
  });

  it("trunca a BROADCAST_BODY_MAX caracteres", () => {
    const body = "x".repeat(5000);
    const out = buildBroadcastBody("S", body);
    expect(out.length).toBe(BROADCAST_BODY_MAX);
    expect(out.startsWith("📢 S\n\n")).toBe(true);
  });

  it("no trunca cuando está bajo el límite", () => {
    const out = buildBroadcastBody("S", "corto");
    expect(out.length).toBeLessThan(BROADCAST_BODY_MAX);
  });
});

describe("canonicalConvPair", () => {
  it("ordena a<b dejando user_a como el menor lexicográfico", () => {
    expect(canonicalConvPair("a", "b")).toEqual({ user_a: "a", user_b: "b" });
  });

  it("invierte cuando a>b", () => {
    expect(canonicalConvPair("b", "a")).toEqual({ user_a: "a", user_b: "b" });
  });

  it("es idempotente respecto al orden de los argumentos", () => {
    expect(canonicalConvPair("z9", "z1")).toEqual(canonicalConvPair("z1", "z9"));
  });

  it("ordena UUIDs reales lexicográficamente", () => {
    const a = "0a1b2c3d-0000-0000-0000-000000000000";
    const b = "fa1b2c3d-0000-0000-0000-000000000000";
    expect(canonicalConvPair(b, a)).toEqual({ user_a: a, user_b: b });
  });
});

describe("dedupeRecipients", () => {
  it("aplana y dedup a través de cursos", () => {
    const out = dedupeRecipients([
      ["u1", "u2"],
      ["u2", "u3"],
    ]);
    expect(out).toEqual(["u1", "u2", "u3"]);
  });

  it("preserva el orden de primera aparición", () => {
    const out = dedupeRecipients([
      ["u3", "u1"],
      ["u2", "u3"],
    ]);
    expect(out).toEqual(["u3", "u1", "u2"]);
  });

  it("excluye al sender", () => {
    const out = dedupeRecipients([["u1", "sender", "u2"]], "sender");
    expect(out).toEqual(["u1", "u2"]);
  });

  it("descarta strings vacíos", () => {
    const out = dedupeRecipients([["", "u1", ""]]);
    expect(out).toEqual(["u1"]);
  });

  it("devuelve [] para input vacío", () => {
    expect(dedupeRecipients([])).toEqual([]);
    expect(dedupeRecipients([[], []])).toEqual([]);
  });

  it("un alumno en 3 cursos cuenta una sola vez", () => {
    const out = dedupeRecipients([["u1"], ["u1"], ["u1"]]);
    expect(out).toEqual(["u1"]);
  });
});

describe("normalizeCourseIds", () => {
  it("acepta el shape nuevo courseIds[]", () => {
    expect(normalizeCourseIds({ courseIds: ["c1", "c2"] })).toEqual(["c1", "c2"]);
  });

  it("acepta el shape legacy courseId", () => {
    expect(normalizeCourseIds({ courseId: "c1" })).toEqual(["c1"]);
  });

  it("prioriza courseIds sobre courseId cuando vienen ambos", () => {
    expect(normalizeCourseIds({ courseId: "legacy", courseIds: ["c1"] })).toEqual(["c1"]);
  });

  it("dedup + trim + descarta vacíos y no-strings", () => {
    expect(
      normalizeCourseIds({ courseIds: ["c1", " c1 ", "", "c2", 42 as unknown as string] }),
    ).toEqual(["c1", "c2"]);
  });

  it("devuelve [] cuando no hay nada válido", () => {
    expect(normalizeCourseIds({})).toEqual([]);
    expect(normalizeCourseIds({ courseIds: [] })).toEqual([]);
    expect(normalizeCourseIds({ courseId: "" })).toEqual([]);
  });
});

describe("humanizeTags", () => {
  it("convierte un token a #label", () => {
    expect(humanizeTags("[[T:workshop:a1:Taller Final]]")).toBe("#Taller Final");
  });

  it("conserva el texto alrededor del token", () => {
    expect(humanizeTags("Revisen [[T:exam:e1:Parcial 1]] para hoy")).toBe(
      "Revisen #Parcial 1 para hoy",
    );
  });

  it("aplana múltiples tokens", () => {
    expect(humanizeTags("[[T:workshop:a1:T1]] y [[T:project:b1:P1]]")).toBe("#T1 y #P1");
  });

  it("deja el texto sin tokens intacto", () => {
    expect(humanizeTags("mensaje normal sin tags")).toBe("mensaje normal sin tags");
  });

  it("ignora tokens con type desconocido (no matchea la whitelist)", () => {
    expect(humanizeTags("[[T:malware:x:y]]")).toBe("[[T:malware:x:y]]");
  });
});

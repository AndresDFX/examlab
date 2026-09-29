import { describe, it, expect } from "vitest";
import {
  plegarRecuperaciones,
  notaDeTallerConRecuperaciones,
  entregasDeTallerQueDecidenLaNota,
  type FilaDeTaller,
  type ItemResuelto,
  type RecuperacionResuelta,
} from "./nota-con-recuperacion";

const item = (id: string, presento: boolean, nota: number | null): ItemResuelto => ({
  id,
  presento,
  nota,
});
const recu = (
  id: string,
  tipo: RecuperacionResuelta["tipo"],
  presento: boolean,
  nota: number | null,
  extra: Partial<RecuperacionResuelta> = {},
): RecuperacionResuelta => ({
  id,
  presento,
  nota,
  tipo,
  regla: "mayor",
  creadoEn: "2026-02-01T00:00:00Z",
  ...extra,
});

describe("plegarRecuperaciones (núcleo genérico)", () => {
  it("sin recuperaciones devuelve la del original", () => {
    expect(plegarRecuperaciones(item("t", true, 3), [])).toEqual({
      nota: 3,
      fuente: "original",
      idFuente: "t",
    });
  });

  it("no presentó nada → sin nota", () => {
    expect(plegarRecuperaciones(item("t", false, null), [])).toEqual({
      nota: null,
      fuente: null,
      idFuente: null,
    });
  });

  it("supletorio llena la ausencia cuando no presentó el original", () => {
    const r = plegarRecuperaciones(item("t", false, null), [
      recu("s", "supletorio", true, 3.5),
    ]);
    expect(r).toEqual({ nota: 3.5, fuente: "supletorio", idFuente: "s" });
  });

  it("supletorio NO cuenta si presentó el original", () => {
    const r = plegarRecuperaciones(item("t", true, 2), [recu("s", "supletorio", true, 5)]);
    expect(r).toEqual({ nota: 2, fuente: "original", idFuente: "t" });
  });

  it("recuperatorio 'mayor' nunca baja la nota", () => {
    const peor = plegarRecuperaciones(item("t", true, 4), [recu("r", "recuperatorio", true, 2)]);
    expect(peor.nota).toBe(4);
    expect(peor.fuente).toBe("original");
    const mejor = plegarRecuperaciones(item("t", true, 2), [recu("r", "recuperatorio", true, 4)]);
    expect(mejor).toEqual({ nota: 4, fuente: "recuperatorio", idFuente: "r" });
  });

  it("recuperatorio 'reemplaza' sustituye aunque sea menor", () => {
    const r = plegarRecuperaciones(item("t", true, 4), [
      recu("r", "recuperatorio", true, 1, { regla: "reemplaza" }),
    ]);
    expect(r).toEqual({ nota: 1, fuente: "recuperatorio", idFuente: "r" });
  });

  it("pliega en orden de creación", () => {
    const r = plegarRecuperaciones(item("t", false, null), [
      recu("r2", "recuperatorio", true, 4, { creadoEn: "2026-03-01T00:00:00Z" }),
      recu("r1", "recuperatorio", true, 3, { creadoEn: "2026-02-01T00:00:00Z" }),
    ]);
    // r1 llena la ausencia (3), r2 (4) compite por 'mayor' → 4
    expect(r).toEqual({ nota: 4, fuente: "recuperatorio", idFuente: "r2" });
  });

  it("recuperatorio presentado sin nota todavía no cambia la base", () => {
    const r = plegarRecuperaciones(item("t", true, 2), [recu("r", "recuperatorio", true, null)]);
    expect(r).toEqual({ nota: 2, fuente: "original", idFuente: "t" });
  });
});

// ── Wrappers de taller ────────────────────────────────────────────────
const taller = (
  id: string,
  extra: Partial<FilaDeTaller> = {},
): FilaDeTaller => ({ id, ...extra });

describe("notaDeTallerConRecuperaciones", () => {
  const talleres: FilaDeTaller[] = [
    taller("w"),
    taller("wr", {
      parent_workshop_id: "w",
      makeup_kind: "recuperatorio",
      recovery_rule: "mayor",
      created_at: "2026-02-01",
    }),
    taller("ws", {
      parent_workshop_id: "w",
      makeup_kind: "supletorio",
      created_at: "2026-03-01",
    }),
  ];

  it("recuperatorio mejora la nota del original", () => {
    const notas: Record<string, ItemResuelto> = {
      w: item("w", true, 2),
      wr: item("wr", true, 4),
      ws: item("ws", false, null),
    };
    const r = notaDeTallerConRecuperaciones(talleres[0], talleres, (id) => notas[id]);
    expect(r).toEqual({ nota: 4, fuente: "recuperatorio", idFuente: "wr" });
  });

  it("una recuperación en borrador/papelera no cuenta", () => {
    const conBorrador: FilaDeTaller[] = [
      taller("w"),
      taller("wr", {
        parent_workshop_id: "w",
        makeup_kind: "recuperatorio",
        status: "draft",
        created_at: "2026-02-01",
      }),
    ];
    const notas: Record<string, ItemResuelto> = {
      w: item("w", true, 2),
      wr: item("wr", true, 5),
    };
    const r = notaDeTallerConRecuperaciones(conBorrador[0], conBorrador, (id) => notas[id]);
    expect(r.nota).toBe(2);
    expect(r.fuente).toBe("original");
  });
});

describe("entregasDeTallerQueDecidenLaNota", () => {
  const talleres: FilaDeTaller[] = [
    taller("w"),
    taller("wr", {
      parent_workshop_id: "w",
      makeup_kind: "recuperatorio",
      created_at: "2026-02-01",
    }),
  ];

  it("atribuye la entrega al original y se queda con la que decide la nota", () => {
    const entregas = [
      { workshop_id: "w", user_id: "u1" },
      { workshop_id: "wr", user_id: "u1" },
    ];
    // La nota sale del recuperatorio (mayor): solo esa entrega decide.
    const out = entregasDeTallerQueDecidenLaNota(talleres, entregas, (id) =>
      id === "w" ? item("w", true, 2) : item("wr", true, 4),
    );
    expect(out).toEqual([{ tallerOriginal: "w", entrega: { workshop_id: "wr", user_id: "u1" } }]);
  });

  it("sin ninguna entrega finalizada conserva todas (para contar 'en curso')", () => {
    const entregas = [{ workshop_id: "w", user_id: "u1" }];
    const out = entregasDeTallerQueDecidenLaNota(talleres, entregas, () =>
      item("x", false, null),
    );
    expect(out).toHaveLength(1);
    expect(out[0].tallerOriginal).toBe("w");
  });
});

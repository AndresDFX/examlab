/**
 * Pruebas del resumen de firmas.
 *
 * Lo que más importa acá NO son los conteos felices, es el guard de «nunca
 * 0 de 0»: el embed de PostgREST y `report_signatures_of` devuelven vacío SIN
 * error cuando la policy no deja ver las filas, así que un informe con 33 firmas
 * puede llegar a esta función como una lista vacía. Si eso se pinta como
 * «0 firmadas», el docente cree que nadie firmó y vuelve a pedir 33 firmas.
 */
import { describe, expect, it } from "vitest";

import { filasDeFirmantes, hashDivergente, loteDeSolicitud, resumirFirmas } from "./estado-firmas";
import { ranuraHtml, renglonManualHtml } from "./signature-slots";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

/** Un documento que ancla las ranuras de `uids`. */
function doc(...uids: string[]): string {
  return `<div>${uids.map((u) => ranuraHtml(u)).join("")}</div>`;
}

function sol(
  user_id: string,
  extra: Partial<{
    signed_at: string | null;
    requested_at: string | null;
    signed_via: string | null;
    signed_hash: string | null;
  }> = {},
) {
  return {
    user_id,
    signed_at: null,
    requested_at: "2026-09-04T23:35:00Z",
    signed_via: null,
    signed_hash: null,
    ...extra,
  };
}

describe("resumirFirmas", () => {
  it("cuenta contra las RANURAS del documento, no contra las solicitudes", () => {
    const r = resumirFirmas(
      [{ signed_at: "2026-09-05T10:00:00Z" }, { signed_at: null }],
      doc(A, B, C),
    );
    expect(r).toEqual({ clase: "parcial", firmadas: 1, total: 3, sinSolicitar: 1 });
  });

  it("sin ranuras ancladas cae al total de solicitudes", () => {
    const r = resumirFirmas(
      [{ signed_at: "2026-09-05T10:00:00Z" }, { signed_at: null }],
      "<p>documento viejo, sin ranuras</p>",
    );
    expect(r.total).toBe(2);
    expect(r.firmadas).toBe(1);
    expect(r.sinSolicitar).toBe(0);
    expect(r.clase).toBe("parcial");
  });

  it("marca completo cuando están todas", () => {
    const r = resumirFirmas(
      [{ signed_at: "2026-09-05T10:00:00Z" }, { signed_at: "2026-09-06T10:00:00Z" }],
      doc(A, B),
    );
    expect(r.clase).toBe("completo");
  });

  it("más firmas que ranuras sigue siendo completo y no muestra 3 de 2", () => {
    const r = resumirFirmas(
      [
        { signed_at: "2026-09-05T10:00:00Z" },
        { signed_at: "2026-09-06T10:00:00Z" },
        { signed_at: "2026-09-07T10:00:00Z" },
      ],
      doc(A, B),
    );
    // El denominador no se infla con las firmas: es lo que el documento ancla.
    expect(r.total).toBe(2);
    expect(r.clase).toBe("completo");
  });

  it("más solicitudes que ranuras no da sinSolicitar negativo", () => {
    const r = resumirFirmas([{ signed_at: null }, { signed_at: null }], doc(A));
    expect(r.sinSolicitar).toBe(0);
  });

  it("ranuras y ninguna solicitud es 'sin-pedir'", () => {
    expect(resumirFirmas([], doc(A, B, C)).clase).toBe("sin-pedir");
    expect(resumirFirmas([], doc(A, B, C)).total).toBe(3);
  });

  it("una lista AUSENTE (embed que la RLS dejó vacío) no se lee como 'nadie firmó'", () => {
    for (const filas of [null, undefined]) {
      const r = resumirFirmas(filas, doc(A, B, C));
      expect(r.clase).toBe("sin-pedir");
      expect(r.firmadas).toBe(0);
      // Y jamás el denominador en cero.
      expect(r.total).toBe(3);
    }
  });

  it("sin html y sin filas es 'sin-ranuras', nunca 0 de 0 en otra clase", () => {
    const r = resumirFirmas([], null);
    expect(r).toEqual({ clase: "sin-ranuras", firmadas: 0, total: 0, sinSolicitar: 0 });
  });

  it("un documento con SOLO renglones para firmar a mano es 'sin-ranuras'", () => {
    // Hay marcado de firma, pero nada anclado: no hay a quién pedírsela.
    const r = resumirFirmas([], `<div>${renglonManualHtml()}</div>`);
    expect(r.clase).toBe("sin-ranuras");
    expect(r.total).toBe(0);
  });

  it("ninguna clase distinta de 'sin-ranuras' puede tener total 0", () => {
    const casos = [
      resumirFirmas([], null),
      resumirFirmas([], "<p>x</p>"),
      resumirFirmas(null, null),
      resumirFirmas([], `<div>${renglonManualHtml()}</div>`),
    ];
    for (const c of casos) {
      if (c.total === 0) expect(c.clase).toBe("sin-ranuras");
    }
  });
});

describe("filasDeFirmantes", () => {
  const base = {
    anclados: [A, B, C],
    perfiles: [
      { id: A, full_name: "Zulma Álvarez", institutional_email: "z@u.edu" },
      { id: B, full_name: "Ana Bermúdez", institutional_email: "a@u.edu" },
      { id: C, full_name: "Carlos Díaz", institutional_email: "c@u.edu" },
    ],
    idsDocentes: new Set<string>(),
  };

  it("ordena sin_solicitar → pendiente → firmada", () => {
    const filas = filasDeFirmantes({
      ...base,
      // A firmó, B pendiente, C sin solicitar.
      solicitudes: [sol(A, { signed_at: "2026-09-05T10:00:00Z" }), sol(B)],
      firmadas: [
        { id: "f1", user_id: A, nombre: "Zulma Álvarez", signed_at: "2026-09-05T10:00:00Z" },
      ],
    });
    expect(filas.map((f) => f.userId)).toEqual([C, B, A]);
    expect(filas.map((f) => f.estado)).toEqual(["sin_solicitar", "pendiente", "firmada"]);
  });

  it("entre las firmadas, la más reciente primero", () => {
    const filas = filasDeFirmantes({
      ...base,
      anclados: [A, B],
      solicitudes: [
        sol(A, { signed_at: "2026-09-05T10:00:00Z" }),
        sol(B, { signed_at: "2026-09-08T20:56:00Z" }),
      ],
      firmadas: [
        { id: "f1", user_id: A, signed_at: "2026-09-05T10:00:00Z" },
        { id: "f2", user_id: B, signed_at: "2026-09-08T20:56:00Z" },
      ],
    });
    expect(filas.map((f) => f.userId)).toEqual([B, A]);
  });

  it("el docente va primero dentro de su grupo", () => {
    const filas = filasDeFirmantes({
      ...base,
      idsDocentes: new Set([C]),
      solicitudes: [sol(A), sol(B), sol(C)],
      firmadas: [],
    });
    expect(filas[0].userId).toBe(C);
    expect(filas[0].esDocente).toBe(true);
    // Y el resto por nombre, con collation es-CO (Ana antes que Zulma).
    expect(filas.slice(1).map((f) => f.nombre)).toEqual(["Ana Bermúdez", "Zulma Álvarez"]);
  });

  it("un ancla sin perfil entra igual, con el nombre en guion", () => {
    const filas = filasDeFirmantes({
      anclados: [A],
      perfiles: [],
      idsDocentes: new Set<string>(),
      solicitudes: [],
      firmadas: [],
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].nombre).toBe("—");
    expect(filas[0].anclada).toBe(true);
    expect(filas[0].estado).toBe("sin_solicitar");
  });

  it("una solicitud que el documento NO ancla entra con anclada=false", () => {
    const filas = filasDeFirmantes({
      ...base,
      anclados: [A],
      solicitudes: [sol(A), sol(B)],
      firmadas: [],
    });
    const b = filas.find((f) => f.userId === B)!;
    expect(b.anclada).toBe(false);
    expect(b.estado).toBe("pendiente");
  });

  it("estar en las dos consultas no duplica la fila", () => {
    const filas = filasDeFirmantes({
      ...base,
      anclados: [A],
      solicitudes: [sol(A, { signed_at: "2026-09-05T10:00:00Z" })],
      firmadas: [{ id: "f1", user_id: A, signed_at: "2026-09-05T10:00:00Z" }],
    });
    expect(filas).toHaveLength(1);
    expect(filas[0].firmaId).toBe("f1");
  });

  it("docente Y matriculado aparece una sola vez", () => {
    const filas = filasDeFirmantes({
      ...base,
      anclados: [A, A],
      idsDocentes: new Set([A]),
      solicitudes: [sol(A)],
      firmadas: [],
    });
    expect(filas.filter((f) => f.userId === A)).toHaveLength(1);
  });

  it("humaniza el medio y detecta el trazo", () => {
    const png = `data:image/png;base64,${"iVBORw0KGgo".repeat(4)}==`;
    const filas = filasDeFirmantes({
      ...base,
      anclados: [A, B, C],
      solicitudes: [
        sol(A, { signed_at: "2026-09-05T10:00:00Z", signed_via: "link" }),
        sol(B, { signed_at: "2026-09-06T10:00:00Z", signed_via: "app" }),
        sol(C, { signed_via: "vaya-a-saber" }),
      ],
      firmadas: [
        { id: "f1", user_id: A, signed_at: "2026-09-05T10:00:00Z", dibujo: png },
        { id: "f2", user_id: B, signed_at: "2026-09-06T10:00:00Z", dibujo: null },
      ],
    });
    const porId = new Map(filas.map((f) => [f.userId, f]));
    expect(porId.get(A)!.via).toBe("link");
    expect(porId.get(A)!.conDibujo).toBe(true);
    expect(porId.get(B)!.via).toBe("app");
    expect(porId.get(B)!.conDibujo).toBe(false);
    // Un valor que no conocemos no se muestra crudo: se descarta.
    expect(porId.get(C)!.via).toBeNull();
  });
});

describe("loteDeSolicitud", () => {
  it("todas con la misma fecha devuelve esa fecha", () => {
    expect(loteDeSolicitud([sol(A), sol(B), sol(C)])).toBe("2026-09-04T23:35:00Z");
  });

  it("una fecha distinta devuelve null: las fechas son de cada fila", () => {
    expect(loteDeSolicitud([sol(A), sol(B, { requested_at: "2026-09-05T01:00:00Z" })])).toBeNull();
  });

  it("lista vacía devuelve null", () => {
    expect(loteDeSolicitud([])).toBeNull();
  });

  it("sin fecha devuelve null", () => {
    expect(loteDeSolicitud([sol(A, { requested_at: null })])).toBeNull();
  });
});

describe("hashDivergente", () => {
  it("un solo hash entre las firmadas: no divergen", () => {
    expect(
      hashDivergente([
        { signed_at: "2026-09-05T10:00:00Z", signed_hash: "8d2a96fe" },
        { signed_at: "2026-09-06T10:00:00Z", signed_hash: "8d2a96fe" },
      ]),
    ).toBe(false);
  });

  it("dos hashes entre las firmadas: divergen", () => {
    expect(
      hashDivergente([
        { signed_at: "2026-09-05T10:00:00Z", signed_hash: "8d2a96fe" },
        { signed_at: "2026-09-06T10:00:00Z", signed_hash: "0000ffff" },
      ]),
    ).toBe(true);
  });

  it("hashes distintos en filas PENDIENTES no cuentan", () => {
    expect(
      hashDivergente([
        { signed_at: null, signed_hash: "8d2a96fe" },
        { signed_at: null, signed_hash: "0000ffff" },
      ]),
    ).toBe(false);
  });

  it("lista vacía no diverge", () => {
    expect(hashDivergente([])).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { arbolDeRecuperaciones, idsConRecuperaciones, tituloSinTipo } from "./arbol-recuperaciones";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";

type Fila = { id: string; padre: string | null; creado: string; estado?: string };

const acc = {
  id: (f: Fila) => f.id,
  padre: (f: Fila) => f.padre,
  creado: (f: Fila) => f.creado,
};

const fila = (id: string, padre: string | null, creado: string, estado = "published"): Fila => ({
  id,
  padre,
  creado,
  estado,
});

const ids = (xs: readonly Fila[]) => xs.map((x) => x.id);

describe("arbolDeRecuperaciones", () => {
  it("una actividad sin recuperaciones es una fila sin hijas", () => {
    const todas = [fila("p1", null, "2026-09-01")];
    const arbol = arbolDeRecuperaciones(todas, todas, acc);
    expect(ids(arbol.raices)).toEqual(["p1"]);
    expect(arbol.hijas.get("p1")).toBeUndefined();
    expect(arbol.soloPorRecuperacion.size).toBe(0);
  });

  it("las recuperaciones cuelgan de su original y dejan de ser filas propias", () => {
    const todas = [
      fila("p1", null, "2026-09-01"),
      fila("rec", "p1", "2026-09-20"),
      fila("sup", "p1", "2026-09-10"),
      fila("p2", null, "2026-09-05"),
    ];
    const arbol = arbolDeRecuperaciones(todas, todas, acc);
    expect(ids(arbol.raices)).toEqual(["p1", "p2"]);
    // En el orden del pliegue: primero la que se creó primero.
    expect(ids(arbol.hijas.get("p1") ?? [])).toEqual(["sup", "rec"]);
    expect(arbol.hijas.get("p2")).toBeUndefined();
  });

  it("con la misma fecha de creación desempata por id, como el pliegue de la nota", () => {
    const todas = [
      fila("p1", null, "2026-09-01"),
      fila("b", "p1", "2026-09-10T10:00:00+00:00"),
      fila("a", "p1", "2026-09-10T10:00:00+00:00"),
    ];
    const arbol = arbolDeRecuperaciones(todas, todas, acc);
    expect(ids(arbol.hijas.get("p1") ?? [])).toEqual(["a", "b"]);
  });

  it("si solo coincide la recuperación, el original aparece igual y se marca", () => {
    // Filtro «Borradores + Publicados»: el parcial está cerrado y el
    // supletorio publicado. Sin el original, el supletorio no tiene contexto.
    const todas = [fila("p1", null, "2026-09-01", "closed"), fila("sup", "p1", "2026-09-10")];
    const coinciden = todas.filter((f) => f.estado !== "closed");
    const arbol = arbolDeRecuperaciones(todas, coinciden, acc);
    expect(ids(arbol.raices)).toEqual(["p1"]);
    expect(arbol.soloPorRecuperacion.has("p1")).toBe(true);
  });

  it("desplegado muestra TODAS las recuperaciones, aunque alguna no coincida con el filtro", () => {
    const todas = [
      fila("p1", null, "2026-09-01"),
      fila("sup", "p1", "2026-09-10", "closed"),
      fila("rec", "p1", "2026-09-20"),
    ];
    const coinciden = todas.filter((f) => f.estado !== "closed");
    const arbol = arbolDeRecuperaciones(todas, coinciden, acc);
    expect(ids(arbol.hijas.get("p1") ?? [])).toEqual(["sup", "rec"]);
    // El original coincide por sí mismo: no está ahí por la recuperación.
    expect(arbol.soloPorRecuperacion.has("p1")).toBe(false);
  });

  it("un original que no coincide y cuyas recuperaciones tampoco no aparece", () => {
    const todas = [
      fila("p1", null, "2026-09-01", "closed"),
      fila("sup", "p1", "2026-09-10", "closed"),
      fila("p2", null, "2026-09-05"),
    ];
    const coinciden = todas.filter((f) => f.estado !== "closed");
    const arbol = arbolDeRecuperaciones(todas, coinciden, acc);
    expect(ids(arbol.raices)).toEqual(["p2"]);
  });

  it("una recuperación cuyo original no está en la lista sigue siendo una fila", () => {
    // El original está en la papelera: colgarla de él la haría desaparecer.
    const todas = [fila("sup", "en-papelera", "2026-09-10"), fila("p2", null, "2026-09-05")];
    const arbol = arbolDeRecuperaciones(todas, todas, acc);
    expect(ids(arbol.raices).sort()).toEqual(["p2", "sup"]);
    expect(arbol.soloPorRecuperacion.size).toBe(0);
  });

  it("una recuperación de otra recuperación cuelga del original de arriba", () => {
    const todas = [
      fila("p1", null, "2026-09-01"),
      fila("sup", "p1", "2026-09-10"),
      fila("sup-de-sup", "sup", "2026-09-15"),
    ];
    const arbol = arbolDeRecuperaciones(todas, todas, acc);
    expect(ids(arbol.raices)).toEqual(["p1"]);
    expect(ids(arbol.hijas.get("p1") ?? [])).toEqual(["sup", "sup-de-sup"]);
  });

  it("un ciclo en los datos no cuelga ni pierde filas: cada una queda sola", () => {
    const todas = [fila("a", "b", "2026-09-01"), fila("b", "a", "2026-09-02")];
    const arbol = arbolDeRecuperaciones(todas, todas, acc);
    expect(ids(arbol.raices).sort()).toEqual(["a", "b"]);
    expect(arbol.hijas.size).toBe(0);
  });

  it("cada fila aparece una sola vez aunque coincidan ella y varias recuperaciones", () => {
    const todas = [
      fila("p1", null, "2026-09-01"),
      fila("sup", "p1", "2026-09-10"),
      fila("rec", "p1", "2026-09-20"),
    ];
    const arbol = arbolDeRecuperaciones(todas, [todas[1], todas[0], todas[2]], acc);
    expect(ids(arbol.raices)).toEqual(["p1"]);
  });
});

describe("tituloSinTipo", () => {
  it("quita el tipo que ya dice la insignia, con su separador", () => {
    expect(tituloSinTipo("Supletorio — Parcial 1", "Supletorio")).toBe("Parcial 1");
    expect(tituloSinTipo("recuperatorio: Parcial 2", "Recuperatorio")).toBe("Parcial 2");
    expect(tituloSinTipo("Supletorio Imbachi", "Supletorio")).toBe("Imbachi");
  });

  it("no toca un título que no empieza por el tipo como palabra suelta", () => {
    expect(tituloSinTipo("Parcial 1 (supletorio)", "Supletorio")).toBe("Parcial 1 (supletorio)");
    expect(tituloSinTipo("Supletorios del corte", "Supletorio")).toBe("Supletorios del corte");
    // El tipo de la insignia manda: un recuperatorio no pierde un «Supletorio».
    expect(tituloSinTipo("Supletorio — Parcial 1", "Recuperatorio")).toBe("Supletorio — Parcial 1");
  });

  it("nunca deja el título vacío", () => {
    expect(tituloSinTipo("Supletorio", "Supletorio")).toBe("Supletorio");
    expect(tituloSinTipo("Supletorio — ", "Supletorio")).toBe("Supletorio — ");
  });
});

describe("tituloSinTipo ↔ los títulos por defecto de «Crear recuperatorio»", () => {
  // El diálogo nombra la copia con `defaultTitle*` y la sub-fila le quita el
  // tipo con el texto de la insignia (`badge*`). Si alguien cambia uno de los
  // dos, la sub-fila vuelve a mostrar «Supletorio — …» detrás de «Supletorio».
  for (const [idioma, locale] of [
    ["es", es],
    ["en", en],
  ] as const) {
    it(`en ${idioma}, el título por defecto empieza por el texto de la insignia`, () => {
      const r = locale.recuperaciones;
      const conTitulo = (plantilla: string) => plantilla.replace("{{title}}", "Parcial 1");
      expect(tituloSinTipo(conTitulo(r.defaultTitle), r.badgeRecuperatorio)).toBe("Parcial 1");
      expect(tituloSinTipo(conTitulo(r.defaultTitleSupletorio), r.badgeSupletorio)).toBe(
        "Parcial 1",
      );
    });
  }
});

describe("idsConRecuperaciones", () => {
  it("suma las recuperaciones de cada fila, sin repetir", () => {
    const hijas = new Map([["p1", [{ id: "s1" }, { id: "r1" }]]]);
    expect(idsConRecuperaciones(["p1", "p2"], hijas).sort()).toEqual(["p1", "p2", "r1", "s1"]);
    expect(idsConRecuperaciones(["p1", "s1"], hijas).sort()).toEqual(["p1", "r1", "s1"]);
  });
});

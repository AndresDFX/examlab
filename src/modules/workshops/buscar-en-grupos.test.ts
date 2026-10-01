import { describe, expect, it } from "vitest";

import { estudianteCoincide, filtrarTablero } from "./buscar-en-grupos";

const ana = {
  id: "ana",
  full_name: "Ana María Pérez",
  institutional_email: "ana.perez@uniaj.edu.co",
};
const jose = {
  id: "jose",
  full_name: "José Rodríguez",
  institutional_email: "jrodriguez@uniaj.edu.co",
};
const luis = { id: "luis", full_name: "Luis Gómez", institutional_email: "lgomez@uniaj.edu.co" };
const marta = { id: "marta", full_name: "Marta Díaz", institutional_email: "mdiaz@uniaj.edu.co" };

const grupos = [
  { id: "g1", name: "Grupo 1" },
  { id: "g2", name: "Los Analistas" },
];
const porGrupo = new Map([
  ["g1", [jose, luis]],
  ["g2", [marta]],
]);

describe("estudianteCoincide", () => {
  it("busca por nombre o correo, sin tildes y por palabras", () => {
    expect(estudianteCoincide(jose, "jose rodri")).toBe(true);
    expect(estudianteCoincide(jose, "JOSÉ")).toBe(true);
    expect(estudianteCoincide(ana, "perez ana")).toBe(true);
    expect(estudianteCoincide(ana, "ana.perez@")).toBe(true);
    expect(estudianteCoincide(ana, "rodriguez")).toBe(false);
  });
});

describe("filtrarTablero", () => {
  it("sin búsqueda deja todo como está", () => {
    const r = filtrarTablero([ana], porGrupo, grupos, "   ");
    expect(r.activa).toBe(false);
    expect(r.sinGrupo).toEqual([ana]);
    expect(r.porGrupo.get("g1")).toEqual([jose, luis]);
    expect(r.visibles).toBe(4);
  });

  it("filtra «Sin grupo» y los integrantes de cada grupo", () => {
    const r = filtrarTablero([ana], porGrupo, grupos, "luis");
    expect(r.activa).toBe(true);
    expect(r.sinGrupo).toEqual([]);
    expect(r.porGrupo.get("g1")).toEqual([luis]);
    expect(r.visibles).toBe(1);
  });

  it("los grupos sin coincidencias siguen en el mapa (son destino del arrastre)", () => {
    const r = filtrarTablero([ana], porGrupo, grupos, "ana maria");
    expect(r.sinGrupo).toEqual([ana]);
    expect(r.porGrupo.has("g1")).toBe(true);
    expect(r.porGrupo.get("g1")).toEqual([]);
  });

  it("si coincide el nombre del grupo, se muestra completo", () => {
    const r = filtrarTablero([ana], porGrupo, grupos, "grupo 1");
    expect(r.gruposQueCoinciden.has("g1")).toBe(true);
    expect(r.porGrupo.get("g1")).toEqual([jose, luis]);
    expect(r.visibles).toBe(2);
  });

  it("un grupo cuyo nombre coincide no repite a nadie en el conteo", () => {
    // «analistas» coincide con el nombre del grupo g2; Ana no coincide.
    const r = filtrarTablero([ana], porGrupo, grupos, "analistas");
    expect(r.porGrupo.get("g2")).toEqual([marta]);
    expect(r.sinGrupo).toEqual([]);
    expect(r.visibles).toBe(1);
  });

  it("no muta las listas de entrada", () => {
    const libres = [ana];
    const r = filtrarTablero(libres, porGrupo, grupos, "");
    expect(r.sinGrupo).not.toBe(libres);
    expect(r.porGrupo.get("g1")).not.toBe(porGrupo.get("g1"));
  });
});

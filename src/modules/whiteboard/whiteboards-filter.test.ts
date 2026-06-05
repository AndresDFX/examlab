import { describe, expect, it } from "vitest";
import {
  filterWhiteboards,
  sortWhiteboards,
  type WhiteboardListItem,
  type WhiteboardSortableItem,
} from "./whiteboards-filter";

const ITEMS: WhiteboardListItem[] = [
  { id: "1", name: "POO clase 3", description: "Polimorfismo y herencia" },
  { id: "2", name: "Algoritmos", description: null },
  { id: "3", name: "Sin descripción", description: "" },
  { id: "4", name: "Laboratorio", description: "Practica de pasos" },
  { id: "5", name: "Pasos para resolver", description: "Algoritmo guiado" },
];

describe("filterWhiteboards", () => {
  it("query vacía retorna el array intacto (estabilidad de referencia)", () => {
    expect(filterWhiteboards(ITEMS, "")).toBe(ITEMS);
  });

  it("query solo espacios retorna el array intacto", () => {
    expect(filterWhiteboards(ITEMS, "   ")).toBe(ITEMS);
  });

  it("matchea por nombre (case-insensitive)", () => {
    const out = filterWhiteboards(ITEMS, "POO");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("1");
  });

  it("matchea por nombre lowercase aunque la query venga uppercase", () => {
    const out = filterWhiteboards(ITEMS, "ALGORITMOS");
    expect(out.map((w) => w.id)).toEqual(["2"]);
  });

  it("matchea por descripción", () => {
    const out = filterWhiteboards(ITEMS, "herencia");
    expect(out.map((w) => w.id)).toEqual(["1"]);
  });

  it("matchea cuando el término aparece en nombre Y descripción de items distintos", () => {
    const out = filterWhiteboards(ITEMS, "algor");
    expect(out.map((w) => w.id).sort()).toEqual(["2", "5"]);
  });

  it("tolera descriptions null sin lanzar", () => {
    expect(() => filterWhiteboards(ITEMS, "algoritmos")).not.toThrow();
    const out = filterWhiteboards(ITEMS, "algoritmos");
    expect(out.map((w) => w.id)).toContain("2");
  });

  it("trimea la query antes de matchear", () => {
    const out = filterWhiteboards(ITEMS, "  POO  ");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("1");
  });

  it("no matchea cuando no hay coincidencias", () => {
    expect(filterWhiteboards(ITEMS, "javascript")).toEqual([]);
  });

  it("matchea substring (no exige palabra completa)", () => {
    const out = filterWhiteboards(ITEMS, "lab");
    expect(out.map((w) => w.id)).toEqual(["4"]);
  });

  it("preserva el orden del array original", () => {
    const out = filterWhiteboards(ITEMS, "pasos");
    // Item 4 viene antes que item 5 en el input → mismo orden en output.
    expect(out.map((w) => w.id)).toEqual(["4", "5"]);
  });
});

describe("sortWhiteboards", () => {
  const SORTABLE: WhiteboardSortableItem[] = [
    {
      id: "a",
      name: "Banana",
      description: null,
      updated_at: "2026-05-10T10:00:00Z",
      created_at: "2026-04-01T10:00:00Z",
    },
    {
      id: "b",
      name: "alfa",
      description: null,
      updated_at: "2026-05-15T10:00:00Z",
      created_at: "2026-04-05T10:00:00Z",
    },
    {
      id: "c",
      name: "Casa",
      description: null,
      updated_at: null,
      created_at: "2026-03-01T10:00:00Z",
    },
    {
      id: "d",
      name: "ñandú",
      description: null,
      updated_at: "2026-05-12T10:00:00Z",
      created_at: undefined,
    },
  ];

  it("no muta el array de entrada", () => {
    const before = SORTABLE.map((w) => w.id);
    sortWhiteboards(SORTABLE, "name_asc");
    expect(SORTABLE.map((w) => w.id)).toEqual(before);
  });

  it("updated_desc — más recientes primero, nulls al fondo", () => {
    const out = sortWhiteboards(SORTABLE, "updated_desc");
    expect(out.map((w) => w.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("updated_asc — más viejos primero (null = epoch 0, al inicio)", () => {
    const out = sortWhiteboards(SORTABLE, "updated_asc");
    expect(out.map((w) => w.id)).toEqual(["c", "a", "d", "b"]);
  });

  it("created_desc — usa created_at, fallback a 0 si undefined", () => {
    const out = sortWhiteboards(SORTABLE, "created_desc");
    expect(out.map((w) => w.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("name_asc — orden alfabético es-CO, case-insensitive, ñ correcta", () => {
    const out = sortWhiteboards(SORTABLE, "name_asc");
    // alfa (b) < Banana (a) < Casa (c) < ñandú (d)
    expect(out.map((w) => w.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("name_desc — orden alfabético inverso", () => {
    const out = sortWhiteboards(SORTABLE, "name_desc");
    expect(out.map((w) => w.id)).toEqual(["d", "c", "a", "b"]);
  });

  it("array vacío → array vacío", () => {
    expect(sortWhiteboards([], "updated_desc")).toEqual([]);
  });
});

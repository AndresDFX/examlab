/**
 * Tests del set curado de items de librería Excalidraw.
 *
 * Defensa contra regresiones en el shape de los items — Excalidraw es
 * estricto con la estructura de elements (id, type, x/y/width/height,
 * etc.) y un item mal-formado se ignora silenciosamente en el panel
 * "Library", lo cual es difícil de diagnosticar visualmente.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIBRARY_ITEMS,
  LIBRARY_CATEGORIES,
  instantiateLibraryElements,
  shortLibraryItemName,
} from "./excalidraw-libraries";

describe("DEFAULT_LIBRARY_ITEMS", () => {
  it("no está vacío", () => {
    expect(DEFAULT_LIBRARY_ITEMS.length).toBeGreaterThan(0);
  });

  it("cada item tiene id único", () => {
    const ids = DEFAULT_LIBRARY_ITEMS.map((i) => i.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("cada item tiene el shape esperado por Excalidraw", () => {
    for (const item of DEFAULT_LIBRARY_ITEMS) {
      // Excalidraw requiere status, created, elements. name es opcional
      // pero lo usamos para el tooltip del library panel — sin él la UX
      // es pobre.
      expect(typeof item.id).toBe("string");
      expect(item.id.length).toBeGreaterThan(0);
      expect(item.status).toBe("published");
      expect(typeof item.created).toBe("number");
      expect(item.created).toBeGreaterThan(0);
      expect(typeof item.name).toBe("string");
      expect(Array.isArray(item.elements)).toBe(true);
      expect(item.elements.length).toBeGreaterThan(0);
    }
  });

  it("cada element tiene los campos mínimos que Excalidraw espera", () => {
    const validTypes = new Set([
      "rectangle",
      "ellipse",
      "diamond",
      "text",
      "line",
      "arrow",
      "freedraw",
    ]);
    for (const item of DEFAULT_LIBRARY_ITEMS) {
      for (const el of item.elements as Array<Record<string, unknown>>) {
        expect(typeof el.id).toBe("string");
        expect(typeof el.type).toBe("string");
        expect(validTypes.has(el.type as string)).toBe(true);
        expect(typeof el.x).toBe("number");
        expect(typeof el.y).toBe("number");
        expect(typeof el.width).toBe("number");
        expect(typeof el.height).toBe("number");
        // version / seed son required en el formato Excalidraw.
        expect(typeof el.seed).toBe("number");
        expect(typeof el.version).toBe("number");
        // isDeleted=false para evitar que el rendering los oculte.
        expect(el.isDeleted).toBe(false);
      }
    }
  });

  it("incluye al menos un item por cada categoría curada (flowchart, UML, data structures, DB, POO, AWS)", () => {
    const names = DEFAULT_LIBRARY_ITEMS.map((i) => (i.name as string).toLowerCase());
    expect(names.some((n) => n.includes("flowchart"))).toBe(true);
    expect(names.some((n) => n.includes("uml"))).toBe(true);
    expect(names.some((n) => n.includes("estructura"))).toBe(true);
    expect(names.some((n) => n.startsWith("db ·"))).toBe(true);
    expect(names.some((n) => n.startsWith("poo ·"))).toBe(true);
    expect(names.some((n) => n.startsWith("aws ·"))).toBe(true);
  });

  it("cubre los servicios AWS clave (EC2, S3, Lambda, RDS, API Gateway, DynamoDB)", () => {
    const names = DEFAULT_LIBRARY_ITEMS.map((i) => (i.name as string).toLowerCase());
    for (const svc of ["ec2", "s3", "lambda", "rds", "api gateway", "dynamodb"]) {
      expect(names.some((n) => n.includes(svc))).toBe(true);
    }
  });

  it("DB incluye tabla, entidad y relación (componentes ER fundamentales)", () => {
    const names = DEFAULT_LIBRARY_ITEMS.map((i) => (i.name as string).toLowerCase());
    expect(names.some((n) => n.includes("db · tabla"))).toBe(true);
    expect(names.some((n) => n.includes("db · entidad"))).toBe(true);
    expect(names.some((n) => n.includes("db · relación"))).toBe(true);
  });

  it("POO incluye interfaz, abstracta y enum", () => {
    const names = DEFAULT_LIBRARY_ITEMS.map((i) => (i.name as string).toLowerCase());
    expect(names.some((n) => n.includes("interfaz"))).toBe(true);
    expect(names.some((n) => n.includes("abstracta"))).toBe(true);
    expect(names.some((n) => n.includes("enum"))).toBe(true);
  });

  it("cada item con texto tiene fontFamily y text definidos", () => {
    // Defensa contra regresiones del helper makeText — si el campo
    // text queda undefined Excalidraw lo renderea como string "undefined"
    // dentro del shape (bug visible en el library panel).
    for (const item of DEFAULT_LIBRARY_ITEMS) {
      for (const el of item.elements as Array<Record<string, unknown>>) {
        if (el.type === "text") {
          expect(typeof el.text).toBe("string");
          expect((el.text as string).length).toBeGreaterThan(0);
          expect(typeof el.fontFamily).toBe("number");
        }
      }
    }
  });
});

describe("LIBRARY_CATEGORIES", () => {
  it("toda figura del set queda asignada a EXACTAMENTE una categoría", () => {
    const categorizedIds = LIBRARY_CATEGORIES.flatMap((c) => c.items.map((i) => i.id));
    // Sin duplicados entre categorías.
    expect(new Set(categorizedIds).size).toBe(categorizedIds.length);
    // Cobertura total: cada item del set está en alguna categoría.
    const allIds = new Set(DEFAULT_LIBRARY_ITEMS.map((i) => i.id));
    expect(new Set(categorizedIds)).toEqual(allIds);
  });

  it("ninguna categoría está vacía y todas tienen etiqueta", () => {
    for (const cat of LIBRARY_CATEGORIES) {
      expect(cat.items.length).toBeGreaterThan(0);
      expect(typeof cat.label).toBe("string");
      expect(cat.label.length).toBeGreaterThan(0);
    }
  });

  it("POO/UML agrupa la clase UML junto a las figuras POO", () => {
    const poo = LIBRARY_CATEGORIES.find((c) => c.key === "poo");
    const ids = poo!.items.map((i) => i.id);
    expect(ids).toContain("lib-uml-class");
    expect(ids).toContain("lib-poo-interface");
  });
});

describe("shortLibraryItemName", () => {
  it("quita el prefijo de categoría", () => {
    expect(shortLibraryItemName("DB · Entidad (ER)")).toBe("Entidad (ER)");
    expect(shortLibraryItemName("POO · Interfaz")).toBe("Interfaz");
  });
  it("deja el nombre igual si no hay prefijo", () => {
    expect(shortLibraryItemName("Entidad")).toBe("Entidad");
  });
});

describe("instantiateLibraryElements", () => {
  const sample = [
    { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 40, seed: 1, groupIds: [] },
    { id: "b", type: "text", x: 10, y: 10, width: 80, height: 20, seed: 2, groupIds: [], text: "hi" },
  ];

  it("centra la figura en el punto dado (bbox center → center)", () => {
    const out = instantiateLibraryElements(sample, 500, 300);
    const minX = Math.min(...out.map((e) => e.x));
    const maxX = Math.max(...out.map((e) => e.x + e.width));
    const minY = Math.min(...out.map((e) => e.y));
    const maxY = Math.max(...out.map((e) => e.y + e.height));
    expect((minX + maxX) / 2).toBeCloseTo(500);
    expect((minY + maxY) / 2).toBeCloseTo(300);
  });

  it("preserva las posiciones RELATIVAS entre elementos", () => {
    const out = instantiateLibraryElements(sample, 500, 300);
    // El text estaba +10/+10 respecto al rect; debe seguir igual.
    expect(out[1].x - out[0].x).toBe(10);
    expect(out[1].y - out[0].y).toBe(10);
  });

  it("regenera ids (no colisiona con el template ni entre inserciones)", () => {
    const a = instantiateLibraryElements(sample, 0, 0);
    const b = instantiateLibraryElements(sample, 0, 0);
    const ids = [...a, ...b].map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain("a");
    expect(ids).not.toContain("b");
  });

  it("agrupa todos los elementos insertados bajo un mismo groupId nuevo", () => {
    const out = instantiateLibraryElements(sample, 0, 0);
    const groups = out.map((e) => e.groupIds[0]);
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).toMatch(/^grp-/);
  });

  it("no muta el template original", () => {
    const before = JSON.stringify(sample);
    instantiateLibraryElements(sample, 123, 456);
    expect(JSON.stringify(sample)).toBe(before);
  });

  it("array vacío → []", () => {
    expect(instantiateLibraryElements([], 0, 0)).toEqual([]);
  });
});

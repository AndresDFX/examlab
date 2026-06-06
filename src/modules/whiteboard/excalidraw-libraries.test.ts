/**
 * Tests del set curado de items de librería Excalidraw.
 *
 * Defensa contra regresiones en el shape de los items — Excalidraw es
 * estricto con la estructura de elements (id, type, x/y/width/height,
 * etc.) y un item mal-formado se ignora silenciosamente en el panel
 * "Library", lo cual es difícil de diagnosticar visualmente.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_LIBRARY_ITEMS } from "./excalidraw-libraries";

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

  it("incluye al menos un item por cada categoría curada (flowchart, UML, data structures)", () => {
    const names = DEFAULT_LIBRARY_ITEMS.map((i) => (i.name as string).toLowerCase());
    expect(names.some((n) => n.includes("flowchart"))).toBe(true);
    expect(names.some((n) => n.includes("uml"))).toBe(true);
    expect(names.some((n) => n.includes("estructura"))).toBe(true);
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

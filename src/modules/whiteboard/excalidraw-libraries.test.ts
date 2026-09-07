/**
 * Tests del set curado de items de librería Excalidraw.
 *
 * Defensa contra regresiones en el shape de los items — Excalidraw es
 * estricto con la estructura de elements (id, type, x/y/width/height,
 * etc.) y un item mal-formado se ignora silenciosamente en el panel
 * "Library", lo cual es difícil de diagnosticar visualmente.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIBRARY_ITEMS,
  LIBRARY_CATEGORIES,
  instantiateLibraryElements,
  shortLibraryItemName,
  libraryItemPreview,
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

  it("incluye al menos un item por cada categoría curada (flowchart, UML, componentes, data structures, DB, POO, AWS)", () => {
    const names = DEFAULT_LIBRARY_ITEMS.map((i) => (i.name as string).toLowerCase());
    expect(names.some((n) => n.includes("flowchart"))).toBe(true);
    expect(names.some((n) => n.includes("uml"))).toBe(true);
    expect(names.some((n) => n.includes("estructura"))).toBe(true);
    expect(names.some((n) => n.startsWith("db ·"))).toBe(true);
    expect(names.some((n) => n.startsWith("poo ·"))).toBe(true);
    expect(names.some((n) => n.startsWith("aws ·"))).toBe(true);
    expect(names.some((n) => n.startsWith("componentes ·"))).toBe(true);
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

  it("Componentes incluye el vocabulario mínimo del diagrama", () => {
    // Un diagrama de componentes sin las DOS interfaces no se puede dibujar:
    // la provista y la requerida son las que, encajadas, forman el conector
    // de ensamblaje. Y la dependencia punteada es lo que lo distingue de un
    // diagrama de clases.
    const ids = DEFAULT_LIBRARY_ITEMS.map((i) => i.id as string);
    for (const id of [
      "lib-comp-component",
      "lib-comp-interface-provided",
      "lib-comp-interface-required",
      "lib-comp-port",
      "lib-comp-dependency",
      "lib-comp-package",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("la dependencia de componentes es PUNTEADA, y la herencia de POO no", () => {
    // Si las dos se dibujan igual, el diagrama miente: en UML la dependencia
    // es punteada con punta abierta y la herencia sólida con punta triangular.
    const dep = DEFAULT_LIBRARY_ITEMS.find((i) => i.id === "lib-comp-dependency");
    const flecha = (dep!.elements as Array<Record<string, unknown>>).find((e) => e.type === "arrow");
    expect(flecha?.strokeStyle).toBe("dashed");
    expect(flecha?.endArrowhead).toBe("arrow");

    const her = DEFAULT_LIBRARY_ITEMS.find((i) => i.id === "lib-poo-inheritance");
    const flechaHer = (her!.elements as Array<Record<string, unknown>>).find((e) => e.type === "arrow");
    expect(flechaHer?.endArrowhead).toBe("triangle");
    expect(flechaHer?.strokeStyle ?? "solid").toBe("solid");
  });

  it("la interfaz requerida traza una media circunferencia que ABRE a la derecha", () => {
    // La copa se dibuja como polilínea porque Excalidraw no tiene arco. Si
    // los puntos quedaran al revés, la copa abriría al lado contrario y no
    // encajaría con la bolita de la interfaz provista.
    const req = DEFAULT_LIBRARY_ITEMS.find((i) => i.id === "lib-comp-interface-required");
    const arco = (req!.elements as Array<Record<string, unknown>>)
      .filter((e) => e.type === "line")
      .map((e) => e.points as number[][])
      .find((pts) => pts.length > 2);
    expect(arco).toBeTruthy();
    const xs = arco!.map(([x]) => x);
    // El punto más a la IZQUIERDA está en el medio del trazo (es el fondo de
    // la copa); los extremos son los más a la derecha.
    const iMin = xs.indexOf(Math.min(...xs));
    expect(iMin).toBeGreaterThan(0);
    expect(iMin).toBeLessThan(xs.length - 1);
    expect(xs[0]).toBeGreaterThan(xs[iMin]);
    expect(xs[xs.length - 1]).toBeGreaterThan(xs[iMin]);
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

  it("ninguna categoría está vacía y todas tienen etiqueta, descripción e ícono", () => {
    for (const cat of LIBRARY_CATEGORIES) {
      expect(cat.items.length).toBeGreaterThan(0);
      expect(typeof cat.label).toBe("string");
      expect(cat.label.length).toBeGreaterThan(0);
      // La descripción "para qué sirve" y el ícono son la clave de la
      // claridad estilo draw.io — defendemos que no se omitan.
      expect(typeof cat.description).toBe("string");
      expect(cat.description.length).toBeGreaterThan(0);
      expect(typeof cat.icon).toBe("string");
      expect(cat.icon.length).toBeGreaterThan(0);
    }
  });

  it("el ícono de CADA categoría está registrado en CATEGORY_ICONS del editor", () => {
    // Invariante cross-file con fallo SILENCIOSO: el editor resuelve
    // `CATEGORY_ICONS[cat.icon] ?? Shapes`, así que una categoría cuyo ícono no
    // esté en ese mapa NO rompe el build ni ningún otro test — simplemente sale
    // con el ícono genérico y nadie se entera. Es la misma clase de agujero que
    // los `data-tour-*` del onboarding, que se filtran sin error.
    //
    // El mapa se lee del DISCO (mismo patrón que `page-types.test.ts` con su
    // migración) y no se importa: `WhiteboardEditor.tsx` arrastra Excalidraw
    // entero, que no tiene por qué entrar a una prueba de un módulo puro.
    const src = readFileSync("src/modules/whiteboard/WhiteboardEditor.tsx", "utf8");
    const bloque = /const CATEGORY_ICONS[^=]*=\s*\{([^}]*)\}/.exec(src);
    expect(bloque, "no encontré el mapa CATEGORY_ICONS en WhiteboardEditor.tsx").toBeTruthy();
    const registrados = new Set(
      (bloque![1].match(/[A-Za-z][A-Za-z0-9]*/g) ?? []).map((x) => x.trim()),
    );
    // Si el regex dejara de matchear, el Set quedaría vacío y la prueba pasaría
    // en vacío: se exige que haya encontrado varios.
    expect(registrados.size).toBeGreaterThanOrEqual(5);
    for (const cat of LIBRARY_CATEGORIES) {
      expect(
        registrados.has(cat.icon),
        `la categoría "${cat.key}" usa el ícono "${cat.icon}", que no está en CATEGORY_ICONS`,
      ).toBe(true);
    }
  });

  it("el Diagrama de componentes va SEGUNDO, pegado al de clases (los dos son UML)", () => {
    expect(LIBRARY_CATEGORIES[1].key).toBe("componentes");
    expect(LIBRARY_CATEGORIES[1].items.length).toBeGreaterThanOrEqual(6);
    expect(LIBRARY_CATEGORIES[1].icon).toBe("Blocks");
  });

  it("el Diagrama de clases (UML) va PRIMERO y agrupa clase UML + figuras POO", () => {
    expect(LIBRARY_CATEGORIES[0].key).toBe("clases");
    expect(LIBRARY_CATEGORIES[0].label.toLowerCase()).toContain("clase");
    const ids = LIBRARY_CATEGORIES[0].items.map((i) => i.id);
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

describe("libraryItemPreview", () => {
  it("array vacío → sin shapes pero con dimensiones de caja", () => {
    const p = libraryItemPreview([], 84, 56);
    expect(p.shapes).toEqual([]);
    expect(p.width).toBe(84);
    expect(p.height).toBe(56);
  });

  it("un rectángulo se escala DENTRO de la caja (con padding)", () => {
    const p = libraryItemPreview(
      [{ type: "rectangle", x: 0, y: 0, width: 200, height: 80, backgroundColor: "#e7f5ff" }],
      84,
      56,
      5,
    );
    expect(p.shapes).toHaveLength(1);
    const s = p.shapes[0];
    expect(s.kind).toBe("rect");
    if (s.kind === "rect") {
      expect(s.x).toBeGreaterThanOrEqual(5 - 0.01);
      expect(s.y).toBeGreaterThanOrEqual(5 - 0.01);
      expect(s.x + s.w).toBeLessThanOrEqual(84 - 5 + 0.01);
      expect(s.y + s.h).toBeLessThanOrEqual(56 - 5 + 0.01);
      expect(s.fill).toBe("#e7f5ff");
    }
  });

  it("preserva el aspecto (escala uniforme en x e y)", () => {
    // Rect 200x80 (ratio 2.5). Tras escalar debe mantener el ratio ~2.5.
    const p = libraryItemPreview(
      [{ type: "rectangle", x: 0, y: 0, width: 200, height: 80 }],
      84,
      56,
      5,
    );
    const s = p.shapes[0];
    if (s.kind === "rect") {
      expect(s.w / s.h).toBeCloseTo(2.5, 1);
    }
  });

  it("mapea cada tipo de elemento a su primitiva SVG", () => {
    const p = libraryItemPreview([
      { type: "rectangle", x: 0, y: 0, width: 50, height: 50 },
      { type: "ellipse", x: 60, y: 0, width: 40, height: 40 },
      { type: "diamond", x: 0, y: 60, width: 50, height: 50 },
      { type: "arrow", x: 0, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] },
      { type: "text", x: 0, y: 0, width: 50, height: 20, text: "Hola\nmundo", fontSize: 16 },
    ]);
    const kinds = p.shapes.map((s) => s.kind);
    expect(kinds).toContain("rect");
    expect(kinds).toContain("ellipse");
    expect(kinds).toContain("diamond");
    expect(kinds).toContain("polyline");
    expect(kinds).toContain("text");
    const arrow = p.shapes.find((s) => s.kind === "polyline");
    if (arrow && arrow.kind === "polyline") expect(arrow.arrow).toBe(true);
    // El texto solo conserva la PRIMERA línea (legibilidad en miniatura).
    const text = p.shapes.find((s) => s.kind === "text");
    if (text && text.kind === "text") expect(text.text).toBe("Hola");
  });

  it("transparent → fill 'none' (no pinta fondo)", () => {
    const p = libraryItemPreview([
      { type: "rectangle", x: 0, y: 0, width: 50, height: 50, backgroundColor: "transparent" },
    ]);
    const s = p.shapes[0];
    if (s.kind === "rect") expect(s.fill).toBe("none");
  });

  it("genera miniatura no vacía para TODOS los items reales del set", () => {
    for (const item of DEFAULT_LIBRARY_ITEMS) {
      const p = libraryItemPreview(item.elements as Array<Record<string, unknown>>);
      expect(p.shapes.length).toBeGreaterThan(0);
    }
  });
});

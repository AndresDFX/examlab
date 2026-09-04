import { describe, expect, it } from "vitest";

import {
  dataUrlDeImagenValida,
  MAX_DATAURL_CHARS,
  tipoDeImagenAceptado,
} from "./imagen-limites";
// Del edge por ruta relativa: los topes que muestra el diálogo tienen que ser los
// mismos que aplica el servidor.
import {
  MAX_GRUPOS,
  MAX_PARTICIPANTES,
  normalizarLectura,
  TOOL_NAME,
} from "../../../supabase/functions/_shared/grupos-imagen.ts";

describe("tipoDeImagenAceptado", () => {
  it("acepta png, jpg, jpeg y webp", () => {
    for (const n of ["captura.png", "grilla.JPG", "meet.jpeg", "sala.webp"]) {
      expect(tipoDeImagenAceptado(n)).toBe(true);
    }
  });

  it("rechaza lo que no se sabe leer", () => {
    for (const n of ["notas.pdf", "captura.gif", "diagrama.svg", "video.mp4", "", null]) {
      expect(tipoDeImagenAceptado(n)).toBe(false);
    }
  });
});

describe("dataUrlDeImagenValida", () => {
  const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

  it("acepta los tres tipos", () => {
    expect(dataUrlDeImagenValida(png)).toBe(true);
    expect(dataUrlDeImagenValida("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBe(true);
    expect(dataUrlDeImagenValida("data:image/webp;base64,UklGRhoAAABXRUJQ")).toBe(true);
  });

  it("rechaza SVG, que es XML y puede traer scripts", () => {
    expect(dataUrlDeImagenValida("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
  });

  it("rechaza lo que no es un data URL de imagen", () => {
    expect(dataUrlDeImagenValida("https://ejemplo.com/foto.png")).toBe(false);
    expect(dataUrlDeImagenValida("data:text/plain;base64,aG9sYQ==")).toBe(false);
    expect(dataUrlDeImagenValida("")).toBe(false);
    expect(dataUrlDeImagenValida(null)).toBe(false);
  });

  it("rechaza caracteres que no son base64", () => {
    expect(dataUrlDeImagenValida('data:image/png;base64,abc"><script>')).toBe(false);
    expect(dataUrlDeImagenValida("data:image/png;base64,abc def")).toBe(false);
  });

  it("rechaza por tamaño", () => {
    const gigante = "data:image/png;base64," + "A".repeat(MAX_DATAURL_CHARS);
    expect(dataUrlDeImagenValida(gigante)).toBe(false);
  });
});

describe("normalizarLectura", () => {
  it("el nombre de la herramienta es el que el edge fuerza con tool_choice", () => {
    expect(TOOL_NAME).toBe("leer_grupos");
  });

  it("conserva los grupos y participantes legibles", () => {
    const r = normalizarLectura({
      grupos: [
        {
          etiqueta: "Sala 1",
          participantes: [
            { nombre: "Jean Paul Reyes", confianza: "alta" },
            { nombre: "Ana Maria", confianza: "baja" },
          ],
        },
      ],
      sin_grupo: [{ nombre: "David", confianza: "media" }],
      ilegibles: 2,
    });
    expect(r.grupos).toHaveLength(1);
    expect(r.grupos[0].participantes.map((p) => p.nombre)).toEqual([
      "Jean Paul Reyes",
      "Ana Maria",
    ]);
    expect(r.sin_grupo).toHaveLength(1);
    expect(r.ilegibles).toBe(2);
    expect(r.truncado).toBe(false);
  });

  it("descarta ruido de un caracter", () => {
    const r = normalizarLectura({
      grupos: [{ etiqueta: "A", participantes: [{ nombre: "x" }, { nombre: "Ana Maria" }] }],
      sin_grupo: [],
      ilegibles: 0,
    });
    expect(r.grupos[0].participantes.map((p) => p.nombre)).toEqual(["Ana Maria"]);
  });

  it("deduplica DENTRO del grupo pero NO entre grupos", () => {
    // El mismo nombre en dos salas es información que el docente tiene que ver: puede
    // ser una sala compartida o un error de la captura. Resolverlo acá lo escondería.
    const r = normalizarLectura({
      grupos: [
        { etiqueta: "A", participantes: [{ nombre: "Ana" }, { nombre: "ANA" }] },
        { etiqueta: "B", participantes: [{ nombre: "Ana" }] },
      ],
      sin_grupo: [],
      ilegibles: 0,
    });
    expect(r.grupos[0].participantes).toHaveLength(1);
    expect(r.grupos[1].participantes).toHaveLength(1);
  });

  it("descarta un grupo sin nadie legible en vez de crearlo vacío", () => {
    const r = normalizarLectura({
      grupos: [{ etiqueta: "Vacío", participantes: [] }, { etiqueta: "A", participantes: [{ nombre: "Ana" }] }],
      sin_grupo: [],
      ilegibles: 0,
    });
    expect(r.grupos.map((g) => g.etiqueta)).toEqual(["A"]);
  });

  it("pone etiqueta cuando el modelo no la dio", () => {
    const r = normalizarLectura({
      grupos: [{ participantes: [{ nombre: "Ana" }] }],
      sin_grupo: [],
      ilegibles: 0,
    });
    expect(r.grupos[0].etiqueta).toBe("Grupo 1");
  });

  it("marca truncado al pasar el tope de grupos", () => {
    const grupos = Array.from({ length: MAX_GRUPOS + 3 }, (_, i) => ({
      etiqueta: `S${i}`,
      participantes: [{ nombre: `Persona ${i}` }],
    }));
    const r = normalizarLectura({ grupos, sin_grupo: [], ilegibles: 0 });
    expect(r.grupos).toHaveLength(MAX_GRUPOS);
    expect(r.truncado).toBe(true);
  });

  it("marca truncado al pasar el tope de personas", () => {
    const r = normalizarLectura({
      grupos: [
        {
          etiqueta: "A",
          participantes: Array.from({ length: MAX_PARTICIPANTES + 10 }, (_, i) => ({
            nombre: `Persona ${i}`,
          })),
        },
      ],
      sin_grupo: [],
      ilegibles: 0,
    });
    const total = r.grupos.reduce((n, g) => n + g.participantes.length, 0) + r.sin_grupo.length;
    expect(total).toBeLessThanOrEqual(MAX_PARTICIPANTES);
    expect(r.truncado).toBe(true);
  });

  it("no explota con basura", () => {
    // Un modelo puede devolver cualquier cosa: esto no puede tirar una excepción en
    // medio de la clase.
    for (const basura of [null, undefined, {}, { grupos: "no soy un arreglo" }, { grupos: [null] }]) {
      const r = normalizarLectura(basura);
      expect(Array.isArray(r.grupos)).toBe(true);
      expect(Array.isArray(r.sin_grupo)).toBe(true);
      expect(r.ilegibles).toBe(0);
    }
  });

  it("ilegibles nunca es negativo ni fraccionario", () => {
    expect(normalizarLectura({ ilegibles: -5 }).ilegibles).toBe(0);
    expect(normalizarLectura({ ilegibles: 2.7 }).ilegibles).toBe(2);
    expect(normalizarLectura({ ilegibles: "tres" }).ilegibles).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
// Fuente única: los helpers viven en el edge y se importan por ruta relativa
// (misma convención que vtt-transcript.test.ts y el resto de invariantes).
import {
  detectSpeakers,
  normalizarNombre,
  nombreCoincide,
  preseleccionarDocente,
  filtrarTextoDocente,
} from "../../../supabase/functions/_shared/transcript-speakers.ts";

const VTT = `WEBVTT

0001/1-0
00:00:00.120 --> 00:00:03.480
<v JULIAN ANDRES CASTAÑO ESPINOSA>Buenos días, hoy veremos recursividad.</v>

0002/1-0
00:00:03.600 --> 00:00:06.900
<v JULIAN ANDRES CASTAÑO ESPINOSA>Una función recursiva se llama a sí misma.</v>

0003/1-0
00:00:07.000 --> 00:00:09.200
<v María Gómez>¿Profe, y el caso base?</v>

0004/1-0
00:00:09.300 --> 00:00:12.000
<v JULIAN ANDRES CASTAÑO ESPINOSA>Exacto, el caso base detiene la recursión.</v>
`;

describe("detectSpeakers", () => {
  it("lista hablantes únicos en orden de aparición", () => {
    expect(detectSpeakers(VTT)).toEqual([
      "JULIAN ANDRES CASTAÑO ESPINOSA",
      "María Gómez",
    ]);
  });
  it("ignora cues sin hablante y VTT vacío", () => {
    expect(detectSpeakers("WEBVTT\n\n")).toEqual([]);
  });
});

describe("normalizarNombre", () => {
  it("quita acentos (incluida ñ→n), baja a minúsculas y colapsa espacios", () => {
    // La descomposición NFD separa el tilde de la ñ y se quita también: es
    // consistente en los dos lados de la comparación, así que no afecta el match.
    expect(normalizarNombre("  JULIÁN   Castaño ")).toBe("julian castano");
  });
});

describe("nombreCoincide", () => {
  it("empareja nombre corto ⊆ nombre largo de Teams", () => {
    expect(nombreCoincide("JULIAN ANDRES CASTAÑO ESPINOSA", "Julián Castaño")).toBe(true);
  });
  it("es conservador: un solo token exige coincidencia exacta", () => {
    expect(nombreCoincide("Ana María Pérez", "Ana")).toBe(false);
    expect(nombreCoincide("Ana", "Ana")).toBe(true);
  });
  it("no empareja a dos personas distintas", () => {
    expect(nombreCoincide("María Gómez", "Julián Castaño")).toBe(false);
  });
});

describe("preseleccionarDocente", () => {
  it("elige del listado el que coincide con el full_name", () => {
    expect(
      preseleccionarDocente(detectSpeakers(VTT), "Julián Castaño"),
    ).toEqual(["JULIAN ANDRES CASTAÑO ESPINOSA"]);
  });
  it("sin full_name devuelve vacío", () => {
    expect(preseleccionarDocente(["Ana"], null)).toEqual([]);
  });
});

describe("filtrarTextoDocente", () => {
  it("conserva solo lo del docente y abre párrafo tras una interrupción", () => {
    expect(
      filtrarTextoDocente(VTT, ["JULIAN ANDRES CASTAÑO ESPINOSA"]),
    ).toBe(
      "Buenos días, hoy veremos recursividad. Una función recursiva se llama a sí misma.\n" +
        "Exacto, el caso base detiene la recursión.",
    );
  });
  it("sin hablantes del docente devuelve vacío", () => {
    expect(filtrarTextoDocente(VTT, [])).toBe("");
  });
});

import { describe, it, expect } from "vitest";
// Fuente única: el helper vive en el edge y se importa por ruta relativa
// (misma convención que otras invariantes cross-file del repo).
import {
  parseVtt,
  vttToReadableText,
} from "../../../supabase/functions/_shared/vtt-transcript.ts";

const VTT_TEAMS = `WEBVTT

a1b2c3d4-0000-0000-0000-000000000001/1-0
00:00:00.120 --> 00:00:03.480
<v Julián Castaño>Hola a todos, buenos días.</v>

a1b2c3d4-0000-0000-0000-000000000002/1-0
00:00:03.600 --> 00:00:06.900
<v Julián Castaño>Vamos a empezar con el tema de hoy.</v>

a1b2c3d4-0000-0000-0000-000000000003/1-0
00:00:07.000 --> 00:00:09.200
<v María Gómez>Perfecto, profe.</v>
`;

describe("parseVtt", () => {
  it("extrae hablante y texto, ignorando header, GUID y timestamps", () => {
    const cues = parseVtt(VTT_TEAMS);
    expect(cues).toEqual([
      { speaker: "Julián Castaño", text: "Hola a todos, buenos días." },
      { speaker: "Julián Castaño", text: "Vamos a empezar con el tema de hoy." },
      { speaker: "María Gómez", text: "Perfecto, profe." },
    ]);
  });

  it("tolera CRLF y bloques NOTE/STYLE", () => {
    const vtt =
      "WEBVTT\r\n\r\nNOTE algo\r\n\r\n00:00:01.000 --> 00:00:02.000\r\n<v Ana>Uno.</v>\r\n";
    expect(parseVtt(vtt)).toEqual([{ speaker: "Ana", text: "Uno." }]);
  });

  it("cue sin etiqueta <v> queda sin hablante y limpia tags inline", () => {
    const vtt =
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTexto <c.color>suelto</c> sin hablante.";
    expect(parseVtt(vtt)).toEqual([
      { speaker: null, text: "Texto suelto sin hablante." },
    ]);
  });
});

describe("vttToReadableText", () => {
  it("une renglones consecutivos del mismo hablante", () => {
    expect(vttToReadableText(VTT_TEAMS)).toBe(
      "Julián Castaño: Hola a todos, buenos días. Vamos a empezar con el tema de hoy.\n" +
        "María Gómez: Perfecto, profe.",
    );
  });

  it("vuelve a abrir renglón cuando el mismo hablante reaparece tras otro", () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
<v Ana>Hola.</v>

00:00:02.000 --> 00:00:03.000
<v Beto>Chau.</v>

00:00:03.000 --> 00:00:04.000
<v Ana>Volví.</v>`;
    expect(vttToReadableText(vtt)).toBe("Ana: Hola.\nBeto: Chau.\nAna: Volví.");
  });

  it("devuelve string vacío para un VTT sin cues", () => {
    expect(vttToReadableText("WEBVTT\n\n")).toBe("");
  });
});

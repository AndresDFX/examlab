/**
 * Tests para el parser/builder de tags de contenido embebidos en mensajes.
 *
 * Foco crítico:
 *   - Round-trip: build → parse devuelve el mismo tag.
 *   - Edge cases del label: con `]`, con espacios, con tildes, vacío.
 *   - Texto mixto: parsea correctamente cuando hay tags entremedio.
 *   - Body sin tags: devuelve un único segmento `text`.
 *   - UUIDs con prefijos válidos del Postgres `gen_random_uuid()`.
 *   - Rutas correctas según rol (student vs teacher).
 *
 * No testeamos React rendering acá — eso vive en tests de UI cuando se
 * necesiten. La regex de parsing y la construcción del token son lógica
 * pura que merece coverage al 100%.
 */
import { describe, it, expect } from "vitest";
import {
  buildTagToken,
  parseMessageBody,
  tagRoute,
  findActiveTagQuery,
  TAG_TYPE_LABEL,
  type ContentTag,
  type TagType,
} from "./message-tags";

describe("buildTagToken", () => {
  it("construye el token con el formato `[[T:type:id:label]]`", () => {
    const tag: ContentTag = {
      type: "workshop",
      id: "abc-123-def",
      label: "Taller 1",
    };
    expect(buildTagToken(tag)).toBe("[[T:workshop:abc-123-def:Taller 1]]");
  });

  it("sanitiza `]` en el label para no romper el parser", () => {
    // El label viene de la BD (titulos de talleres / examenes); un
    // docente curioso podria poner `]` en el nombre. Si llegara
    // intacto al token, la regex de parseMessageBody lo cortaria en
    // el `]` y devolveria un tag truncado. Reemplazamos `]` → `)`
    // (NO `[` — el `[` no rompe la regex `[^\]]+`).
    const tag: ContentTag = { type: "exam", id: "e1", label: "Parcial [unidad 2]" };
    const token = buildTagToken(tag);
    // El `]` en el label debe haberse reemplazado. El parser confía
    // en que solo los 2 últimos chars del token son `]]`.
    const labelPart = token.slice("[[T:exam:e1:".length, -"]]".length);
    expect(labelPart).not.toContain("]");
    // Round-trip: parse del token debe devolver el tag con el label
    // saneado intacto (no truncado).
    const parsed = parseMessageBody(token);
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { kind: "tag"; tag: ContentTag }).tag.label).toBe("Parcial [unidad 2)");
  });

  it("preserva tildes y caracteres unicode en el label", () => {
    const tag: ContentTag = { type: "project", id: "b1", label: "Diseño básico ñ" };
    expect(buildTagToken(tag)).toBe("[[T:project:b1:Diseño básico ñ]]");
  });

  it("funciona con id corto (no se valida acá; el caller decide)", () => {
    // IDs reales son UUIDs hex de 36 chars; usamos uno corto que
    // matchea la whitelist `[0-9a-f-]+` del parser para validar
    // forma sin generar uno largo en cada test.
    const tag: ContentTag = { type: "content", id: "a", label: "X" };
    expect(buildTagToken(tag)).toBe("[[T:content:a:X]]");
  });
});

describe("parseMessageBody", () => {
  it("devuelve un único segmento texto cuando no hay tags", () => {
    const segments = parseMessageBody("Hola, ¿cómo estás?");
    expect(segments).toEqual([{ kind: "text", text: "Hola, ¿cómo estás?" }]);
  });

  it("devuelve array vacío para body vacío", () => {
    expect(parseMessageBody("")).toEqual([]);
  });

  it("parsea un tag aislado", () => {
    const segments = parseMessageBody("[[T:workshop:abc-123:Taller 1]]");
    expect(segments).toEqual([
      { kind: "tag", tag: { type: "workshop", id: "abc-123", label: "Taller 1" } },
    ]);
  });

  it("parsea texto + tag + texto en orden", () => {
    const body = "Mira [[T:exam:e1:Parcial]] te ayudo";
    const segments = parseMessageBody(body);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: "text", text: "Mira " });
    expect(segments[1]).toEqual({
      kind: "tag",
      tag: { type: "exam", id: "e1", label: "Parcial" },
    });
    expect(segments[2]).toEqual({ kind: "text", text: " te ayudo" });
  });

  it("parsea múltiples tags adyacentes", () => {
    const body = "[[T:workshop:a1:T1]] [[T:project:b1:P1]]";
    const segments = parseMessageBody(body);
    expect(segments).toEqual([
      { kind: "tag", tag: { type: "workshop", id: "a1", label: "T1" } },
      { kind: "text", text: " " },
      { kind: "tag", tag: { type: "project", id: "b1", label: "P1" } },
    ]);
  });

  it("ignora tokens con `type` desconocido — quedan como texto", () => {
    // Si en el futuro alguien intenta `[[T:malware:x:y]]`, la regex no
    // matchea (whitelist de tipos) y el token queda como texto literal.
    // Garantiza que extender tipos requiere update del parser.
    const body = "Prefix [[T:malware:bad:Nope]] suffix";
    const segments = parseMessageBody(body);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({ kind: "text", text: body });
  });

  it("ignora tokens con id que tenga caracteres no-hex", () => {
    // La regex permite a-f, 0-9 y guiones — un id con letra G o
    // simbolos raros NO matchea (defensa contra payloads inválidos).
    const body = "[[T:workshop:NOT-A-UUID:Label]]";
    const segments = parseMessageBody(body);
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("text");
  });

  it("acepta UUIDs reales de Postgres (gen_random_uuid)", () => {
    const realUuid = "550e8400-e29b-41d4-a716-446655440000";
    const segments = parseMessageBody(`[[T:exam:${realUuid}:Mi Examen]]`);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toEqual({
      kind: "tag",
      tag: { type: "exam", id: realUuid, label: "Mi Examen" },
    });
  });

  it("preserva texto entre tags incluyendo saltos de linea", () => {
    const body = "Linea1\n[[T:project:b1:Proyecto]]\nLinea3";
    const segments = parseMessageBody(body);
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: "text", text: "Linea1\n" });
    expect((segments[1] as { kind: "tag"; tag: ContentTag }).tag.id).toBe("b1");
    expect(segments[2]).toEqual({ kind: "text", text: "\nLinea3" });
  });

  it("es idempotente: re-parsear los segmentos no rompe estado global", () => {
    // La regex global `TAG_RE` se reusa entre llamadas — verificamos
    // que el reset de `lastIndex` funciona. Si no, la segunda llamada
    // empezaria a buscar desde donde terminó la primera y daria
    // resultados inconsistentes.
    const body = "[[T:workshop:a1:T1]]";
    const first = parseMessageBody(body);
    const second = parseMessageBody(body);
    expect(first).toEqual(second);
  });

  it("round-trip: build → parse devuelve el mismo tag", () => {
    const original: ContentTag = {
      type: "workshop",
      id: "550e8400-e29b-41d4-a716-446655440000",
      label: "Taller de prueba",
    };
    const token = buildTagToken(original);
    const parsed = parseMessageBody(token);
    expect(parsed).toHaveLength(1);
    expect((parsed[0] as { kind: "tag"; tag: ContentTag }).tag).toEqual(original);
  });
});

describe("tagRoute", () => {
  const types: TagType[] = ["workshop", "exam", "project", "content", "video"];

  it.each(types)("devuelve ruta de estudiante para %s", (type) => {
    const tag: ContentTag = { type, id: "x", label: "L" };
    const route = tagRoute(tag, "student");
    expect(route.startsWith("/app/student/")).toBe(true);
  });

  it.each(types)("devuelve ruta de docente para %s", (type) => {
    const tag: ContentTag = { type, id: "x", label: "L" };
    const route = tagRoute(tag, "teacher");
    expect(route.startsWith("/app/teacher/")).toBe(true);
  });

  it("mapea workshop → /workshops", () => {
    expect(tagRoute({ type: "workshop", id: "x", label: "L" }, "student")).toBe(
      "/app/student/workshops",
    );
    expect(tagRoute({ type: "workshop", id: "x", label: "L" }, "teacher")).toBe(
      "/app/teacher/workshops",
    );
  });

  it("mapea exam → /exams", () => {
    expect(tagRoute({ type: "exam", id: "x", label: "L" }, "student")).toBe("/app/student/exams");
  });

  it("mapea project → /projects", () => {
    expect(tagRoute({ type: "project", id: "x", label: "L" }, "teacher")).toBe(
      "/app/teacher/projects",
    );
  });
});

describe("TAG_TYPE_LABEL", () => {
  it("cubre todos los TagType con etiqueta en español", () => {
    const expected: Record<TagType, string> = {
      workshop: "Taller",
      exam: "Examen",
      project: "Proyecto",
      content: "Contenido",
      video: "Video",
    };
    expect(TAG_TYPE_LABEL).toEqual(expected);
  });
});

describe("findActiveTagQuery", () => {
  it("detecta '#' al inicio del texto", () => {
    expect(findActiveTagQuery("#par", 4)).toEqual({ query: "par", start: 0 });
  });

  it("detecta '#' precedido por espacio", () => {
    // "hola #par" — caret al final (9)
    expect(findActiveTagQuery("hola #par", 9)).toEqual({ query: "par", start: 5 });
  });

  it("query vacío justo tras escribir '#'", () => {
    expect(findActiveTagQuery("hola #", 6)).toEqual({ query: "", start: 5 });
  });

  it("NO dispara cuando el '#' está pegado a una palabra (C#, x#y)", () => {
    expect(findActiveTagQuery("C#", 2)).toBeNull();
    expect(findActiveTagQuery("x#y", 3)).toBeNull();
  });

  it("NO hay mención si hay un espacio entre '#' y el caret", () => {
    // "Taller #1 entrega" — caret tras "entrega" (17): el espacio cierra
    expect(findActiveTagQuery("Taller #1 entrega", 17)).toBeNull();
  });

  it("sí está activa mientras se escribe el nombre tras '#' sin espacio", () => {
    // "Taller #1" caret al final (9): query "1" (literal o selección)
    expect(findActiveTagQuery("Taller #1", 9)).toEqual({ query: "1", start: 7 });
  });

  it("usa el '#' MÁS CERCANO al caret", () => {
    // "#a #b" caret al final (5) → segundo '#'
    expect(findActiveTagQuery("#a #b", 5)).toEqual({ query: "b", start: 3 });
  });

  it("null cuando no hay '#' antes del caret", () => {
    expect(findActiveTagQuery("hola mundo", 10)).toBeNull();
  });

  it("respeta la posición del caret (no usa el largo total)", () => {
    // texto "#parcial" pero caret en 3 → query "pa"
    expect(findActiveTagQuery("#parcial", 3)).toEqual({ query: "pa", start: 0 });
  });
});

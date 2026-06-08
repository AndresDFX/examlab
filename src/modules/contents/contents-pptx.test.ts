import { describe, expect, it } from "vitest";
import {
  parseSlideBlock,
  serializeSlides,
  stripInlineMarkdown,
  type ParsedSlide,
} from "./contents-pptx";

describe("parseSlideBlock — encabezados de slide", () => {
  it("devuelve [] para string vacío", () => {
    expect(parseSlideBlock("")).toEqual([]);
  });

  it("devuelve [] cuando solo hay líneas en blanco", () => {
    expect(parseSlideBlock("\n   \n\t\n")).toEqual([]);
  });

  it('parsea el formato canónico "Slide 1 (Título): contenido"', () => {
    const slides = parseSlideBlock("Slide 1 (Introducción): primera idea");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("Introducción");
    expect(slides[0].bullets).toEqual(["primera idea"]);
    // "Introducción" no matchea portada/cover.
    expect(slides[0].isCover).toBe(false);
  });

  it('parsea variante con guion "Slide 3 - Título"', () => {
    const slides = parseSlideBlock("Slide 3 - Desarrollo del tema");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("Desarrollo del tema");
    // No hay contenido tras el separador → bullets vacíos.
    expect(slides[0].bullets).toEqual([]);
  });

  it('parsea variante "Slide 2: Título" (dos puntos directo)', () => {
    const slides = parseSlideBlock("Slide 2: Objetivos");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("Objetivos");
  });

  it('parsea rango numérico puro "Slide [3]: Título"', () => {
    const slides = parseSlideBlock("Slide [3]: Conclusiones");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("Conclusiones");
  });

  it('rango con guion "Slide [3-N]" — el guion interno corta el título en "N" (comportamiento real del regex)', () => {
    // El regex usa [\d-]+ para el número, y al backtrackear toma el '-'
    // como separador, dejando "N" como título. Documentamos el contrato
    // actual: el rango "[3-N]" NO se interpreta como rango limpio.
    const slides = parseSlideBlock("Slide [3-N]: Conclusiones");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("N");
    expect(slides[0].bullets).toEqual(["Conclusiones"]);
  });

  it("acepta encabezado precedido por viñeta '- Slide ...'", () => {
    const slides = parseSlideBlock("- Slide 4 (Cierre): adios");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("Cierre");
    expect(slides[0].bullets).toEqual(["adios"]);
  });

  it("acepta encabezado precedido por asterisco '* Slide ...'", () => {
    const slides = parseSlideBlock("* Slide 5 (Final): fin");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("Final");
  });

  it("es case-insensitive en la palabra Slide", () => {
    const slides = parseSlideBlock("slide 1 (Tema): contenido");
    expect(slides).toHaveLength(1);
    expect(slides[0].title).toBe("Tema");
  });

  it("marca isCover=true cuando el título contiene 'Portada'", () => {
    const slides = parseSlideBlock("Slide 1 (Portada): bienvenidos");
    expect(slides[0].isCover).toBe(true);
  });

  it("marca isCover=true cuando el título contiene 'cover' (case-insensitive)", () => {
    const slides = parseSlideBlock("Slide 1 (Cover Page): hello");
    expect(slides[0].isCover).toBe(true);
  });
});

describe("parseSlideBlock — acumulación de bullets", () => {
  it("acumula viñetas con guion hasta el siguiente slide", () => {
    const raw = [
      "Slide 1 (Tema): intro",
      "- punto uno",
      "- punto dos",
      "Slide 2 (Otro): segundo",
      "- punto tres",
    ].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides).toHaveLength(2);
    expect(slides[0].bullets).toEqual(["intro", "punto uno", "punto dos"]);
    expect(slides[1].bullets).toEqual(["segundo", "punto tres"]);
  });

  it("limpia los prefijos de viñeta -, *, • del contenido", () => {
    const raw = ["Slide 1 (T): x", "- guion", "* asterisco", "• bullet"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].bullets).toEqual(["x", "guion", "asterisco", "bullet"]);
  });

  it("acepta texto plano (sin viñeta) como bullet del slide actual", () => {
    const raw = ["Slide 1 (T): cabecera", "texto plano sin guion"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].bullets).toEqual(["cabecera", "texto plano sin guion"]);
  });

  it("ignora líneas en blanco entre viñetas", () => {
    const raw = ["Slide 1 (T): a", "", "- b", "   ", "- c"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].bullets).toEqual(["a", "b", "c"]);
  });

  it("descarta viñetas que quedan vacías tras quitar el prefijo", () => {
    // "- " queda vacío tras el strip del prefijo → no se agrega.
    const raw = ["Slide 1 (T): a", "-   ", "- real"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].bullets).toEqual(["a", "real"]);
  });

  it("no agrega bullet inicial cuando el encabezado no trae contenido", () => {
    const slides = parseSlideBlock("Slide 1 (Solo título):");
    expect(slides[0].bullets).toEqual([]);
  });
});

describe("parseSlideBlock — texto antes del primer Slide (cover libre)", () => {
  it("captura texto previo al primer encabezado como cover", () => {
    const raw = ["Mi Curso de Programación", "Slide 1 (Tema): real"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides).toHaveLength(2);
    expect(slides[0]).toMatchObject({
      title: "",
      bullets: ["Mi Curso de Programación"],
      isCover: true,
    });
    expect(slides[1].title).toBe("Tema");
  });

  it("acumula varias líneas pre-slide en el mismo cover libre", () => {
    const raw = ["Línea uno", "Línea dos"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides).toHaveLength(1);
    expect(slides[0].isCover).toBe(true);
    // La primera línea crea el cover; la segunda se le cuelga (sin prefijo).
    expect(slides[0].bullets).toEqual(["Línea uno", "Línea dos"]);
  });
});

describe("parseSlideBlock — bloques de código fenced", () => {
  it("extrae un bloque ```lang ... ``` a codeBlocks con lang", () => {
    const raw = [
      "Slide 1 (Código): mira esto",
      "```python",
      "def foo():",
      "    return 1",
      "```",
    ].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides).toHaveLength(1);
    expect(slides[0].codeBlocks).toHaveLength(1);
    expect(slides[0].codeBlocks![0].lang).toBe("python");
    // La indentación interna se preserva (no se trimea).
    expect(slides[0].codeBlocks![0].code).toBe("def foo():\n    return 1");
  });

  it("fence sin lenguaje deja lang undefined", () => {
    const raw = ["Slide 1 (T): x", "```", "linea", "```"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].codeBlocks![0].lang).toBeUndefined();
    expect(slides[0].codeBlocks![0].code).toBe("linea");
  });

  it("no agrega el contenido del fence a las bullets", () => {
    const raw = ["Slide 1 (T): intro", "```js", "const a = 1;", "```"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].bullets).toEqual(["intro"]);
    expect(slides[0].codeBlocks![0].code).toBe("const a = 1;");
  });

  it("preserva líneas en blanco DENTRO del fence", () => {
    const raw = ["Slide 1 (T): x", "```", "a", "", "b", "```"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].codeBlocks![0].code).toBe("a\n\nb");
  });

  it("acepta el cierre del fence con espacios alrededor", () => {
    const raw = ["Slide 1 (T): x", "```", "code", "   ```   "].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].codeBlocks).toHaveLength(1);
    expect(slides[0].codeBlocks![0].code).toBe("code");
  });

  it("soporta múltiples bloques de código en el mismo slide", () => {
    const raw = [
      "Slide 1 (T): x",
      "```py",
      "a = 1",
      "```",
      "```js",
      "let b = 2;",
      "```",
    ].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].codeBlocks).toHaveLength(2);
    expect(slides[0].codeBlocks![0]).toEqual({ lang: "py", code: "a = 1" });
    expect(slides[0].codeBlocks![1]).toEqual({ lang: "js", code: "let b = 2;" });
  });

  it("emite el código acumulado aunque el fence no se cierre (truncado)", () => {
    const raw = ["Slide 1 (T): x", "```python", "print(1)", "print(2)"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].codeBlocks).toHaveLength(1);
    expect(slides[0].codeBlocks![0].lang).toBe("python");
    expect(slides[0].codeBlocks![0].code).toBe("print(1)\nprint(2)");
  });

  it("crea un slide cover cuando el fence abre antes de cualquier 'Slide'", () => {
    const raw = ["```js", "x();", "```"].join("\n");
    const slides = parseSlideBlock(raw);
    // ensureSlide() crea un slide isCover con title vacío.
    expect(slides).toHaveLength(1);
    expect(slides[0].isCover).toBe(true);
    expect(slides[0].title).toBe("");
    expect(slides[0].codeBlocks![0].code).toBe("x();");
  });

  it("un fence vacío sin cierre NO emite code block (codeBuf vacío)", () => {
    // Solo abre el fence al final sin contenido ni cierre → codeBuf.length === 0.
    const raw = ["Slide 1 (T): x", "```python"].join("\n");
    const slides = parseSlideBlock(raw);
    expect(slides[0].codeBlocks).toBeUndefined();
  });
});

describe("parseSlideBlock — tolerancia con \\r\\n", () => {
  it("normaliza saltos de línea Windows", () => {
    const raw = "Slide 1 (T): a\r\n- b\r\nSlide 2 (U): c";
    const slides = parseSlideBlock(raw);
    expect(slides).toHaveLength(2);
    expect(slides[0].bullets).toEqual(["a", "b"]);
    expect(slides[1].title).toBe("U");
  });
});

describe("serializeSlides — round-trip con parseSlideBlock", () => {
  it("serializa un slide simple con bullets", () => {
    const slides: ParsedSlide[] = [
      { title: "Intro", bullets: ["a", "b"], isCover: false },
    ];
    const out = serializeSlides(slides);
    expect(out).toBe("Slide 1 (Intro):\n- a\n- b");
  });

  it("numera los slides secuencialmente (1-based)", () => {
    const slides: ParsedSlide[] = [
      { title: "Uno", bullets: ["x"] },
      { title: "Dos", bullets: ["y"] },
    ];
    const out = serializeSlides(slides);
    expect(out).toBe("Slide 1 (Uno):\n- x\n\nSlide 2 (Dos):\n- y");
  });

  it("usa 'Portada' como título cuando está vacío y isCover=true", () => {
    const out = serializeSlides([{ title: "", bullets: ["x"], isCover: true }]);
    expect(out).toBe("Slide 1 (Portada):\n- x");
  });

  it("usa 'Sin título' cuando está vacío y NO es cover", () => {
    const out = serializeSlides([{ title: "   ", bullets: ["x"], isCover: false }]);
    expect(out).toBe("Slide 1 (Sin título):\n- x");
  });

  it("filtra bullets vacías o solo-espacios y trimea las válidas", () => {
    const out = serializeSlides([
      { title: "T", bullets: ["  hola  ", "   ", ""] },
    ]);
    expect(out).toBe("Slide 1 (T):\n- hola");
  });

  it("serializa solo el header cuando no hay bullets ni code", () => {
    const out = serializeSlides([{ title: "T", bullets: [] }]);
    expect(out).toBe("Slide 1 (T):");
  });

  it("serializa code blocks tras las bullets con fence + lang", () => {
    const out = serializeSlides([
      {
        title: "T",
        bullets: ["b"],
        codeBlocks: [{ lang: "python", code: "x = 1" }],
      },
    ]);
    expect(out).toBe("Slide 1 (T):\n- b\n```python\nx = 1\n```");
  });

  it("code block sin lang emite fence ``` vacío de lenguaje", () => {
    const out = serializeSlides([
      { title: "T", bullets: [], codeBlocks: [{ code: "code" }] },
    ]);
    expect(out).toBe("Slide 1 (T):\n```\ncode\n```");
  });

  it("tolera slides sin bullets ni codeBlocks definidos (undefined)", () => {
    // bullets es required por el tipo pero usa ?? por defensa; pasamos
    // un objeto con bullets explícitas vacías para no romper el tipo.
    const out = serializeSlides([{ title: "Solo", bullets: [] }]);
    expect(out).toBe("Slide 1 (Solo):");
  });

  it("devuelve '' para arreglo vacío", () => {
    expect(serializeSlides([])).toBe("");
  });

  it("round-trip: parse → serialize → parse preserva título y bullets", () => {
    const raw = ["Slide 1 (Intro): cabecera", "- una", "- dos"].join("\n");
    const first = parseSlideBlock(raw);
    const serialized = serializeSlides(first);
    const second = parseSlideBlock(serialized);
    expect(second).toHaveLength(first.length);
    expect(second[0].title).toBe(first[0].title);
    expect(second[0].bullets).toEqual(first[0].bullets);
  });

  it("round-trip con code block preserva el contenido del código", () => {
    const raw = [
      "Slide 1 (Demo): mira",
      "```python",
      "def f():",
      "    return 2",
      "```",
    ].join("\n");
    const first = parseSlideBlock(raw);
    const reparsed = parseSlideBlock(serializeSlides(first));
    expect(reparsed[0].codeBlocks![0].lang).toBe("python");
    expect(reparsed[0].codeBlocks![0].code).toBe("def f():\n    return 2");
  });
});

describe("stripInlineMarkdown", () => {
  it("devuelve '' para input falsy/vacío", () => {
    expect(stripInlineMarkdown("")).toBe("");
  });

  it("quita prefijos de heading # al inicio de línea", () => {
    expect(stripInlineMarkdown("# Título")).toBe("Título");
    expect(stripInlineMarkdown("### Sub")).toBe("Sub");
  });

  it("no quita # en medio del texto (no es heading)", () => {
    expect(stripInlineMarkdown("color #FF en CSS")).toBe("color #FF en CSS");
  });

  it("convierte imágenes ![alt](src) a su alt", () => {
    expect(stripInlineMarkdown("![logo](http://x/y.png)")).toBe("logo");
  });

  it("convierte imágenes con alt vacío a cadena vacía", () => {
    expect(stripInlineMarkdown("![](http://x/y.png)")).toBe("");
  });

  it("convierte links [text](url) a su texto", () => {
    expect(stripInlineMarkdown("ve a [Google](https://google.com)")).toBe("ve a Google");
  });

  it("quita bold + italic combinado ***text***", () => {
    expect(stripInlineMarkdown("***fuerte***")).toBe("fuerte");
  });

  it("quita bold + italic combinado ___text___", () => {
    expect(stripInlineMarkdown("___fuerte___")).toBe("fuerte");
  });

  it("quita negrita **text**", () => {
    expect(stripInlineMarkdown("**Variable**: contenedor")).toBe("Variable: contenedor");
  });

  it("quita negrita __text__", () => {
    expect(stripInlineMarkdown("__bold__")).toBe("bold");
  });

  it("quita itálica *text*", () => {
    expect(stripInlineMarkdown("esto es *importante*")).toBe("esto es importante");
  });

  it("quita itálica _text_", () => {
    expect(stripInlineMarkdown("un _enfasis_ aquí")).toBe("un enfasis aquí");
  });

  it("quita strikethrough ~~text~~", () => {
    expect(stripInlineMarkdown("~~tachado~~")).toBe("tachado");
  });

  it("quita inline code `code`", () => {
    expect(stripInlineMarkdown("usa `printf` aquí")).toBe("usa printf aquí");
  });

  it("quita tags HTML simples preservando el contenido", () => {
    expect(stripInlineMarkdown("<b>negrita</b>")).toBe("negrita");
    expect(stripInlineMarkdown("<span class='x'>texto</span>")).toBe("texto");
  });

  it("combina varias transformaciones en una sola pasada", () => {
    const input = "## **Título** con `code` y [link](http://x)";
    expect(stripInlineMarkdown(input)).toBe("Título con code y link");
  });

  it("preserva texto sin markdown intacto", () => {
    expect(stripInlineMarkdown("texto normal sin formato")).toBe("texto normal sin formato");
  });
});

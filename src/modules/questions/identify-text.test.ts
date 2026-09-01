import { describe, expect, it } from "vitest";
import {
  MAX_PREGUNTAS_POR_LOTE,
  agruparEnLotes,
  emparejarConSegmentos,
  normalizarEnunciado,
  segmentarPreguntas,
} from "./identify-text";

/** Los textos de los segmentos, para asertar de forma legible. */
const textos = (t: string) => segmentarPreguntas(t).map((s) => s.texto);

describe("segmentarPreguntas — el formato del pedido original", () => {
  const PEDIDO = `Pregunta 1
Si solo despliega codigo y el proveedor gestiona el runtime, que modelo es?
Pregunta 2
SaaS puede ser el modelo dominante de CloudLite App? Cuando si/no?
Pregunta 3
Que es un ADR?`;

  it("detecta las 3 preguntas", () => {
    expect(textos(PEDIDO)).toEqual([
      "Si solo despliega codigo y el proveedor gestiona el runtime, que modelo es?",
      "SaaS puede ser el modelo dominante de CloudLite App? Cuando si/no?",
      "Que es un ADR?",
    ]);
  });

  it("marca los tres cortes como confiables", () => {
    expect(segmentarPreguntas(PEDIDO).every((s) => s.confiable)).toBe(true);
  });

  it("el crudo conserva la marca original (es lo que se manda al modelo)", () => {
    expect(segmentarPreguntas(PEDIDO)[0].crudo.startsWith("Pregunta 1")).toBe(true);
  });

  it("tolera CRLF de Windows y espacio duro de Word", () => {
    const conCrlf = PEDIDO.replace(/\n/g, "\r\n").replace("Pregunta 1", " Pregunta 1");
    expect(textos(conCrlf)).toHaveLength(3);
  });

  it("tolera caracteres invisibles pegados desde el procesador de texto", () => {
    const conZw = PEDIDO.replace("Pregunta 2", "​Pregunta 2");
    expect(textos(conZw)).toHaveLength(3);
  });
});

describe("segmentarPreguntas — otras numeraciones", () => {
  it("numeración con punto", () => {
    expect(textos("1. Primera pregunta larga\n2. Segunda pregunta larga")).toEqual([
      "Primera pregunta larga",
      "Segunda pregunta larga",
    ]);
  });

  it("numeración con paréntesis", () => {
    expect(textos("1) Primera pregunta larga\n2) Segunda pregunta larga")).toHaveLength(2);
  });

  it("numeración con guion y con dos puntos", () => {
    expect(textos("1 - Primera pregunta larga\n2 - Segunda pregunta larga")).toHaveLength(2);
    expect(textos("1: Primera pregunta larga\n2: Segunda pregunta larga")).toHaveLength(2);
  });

  it("letras con paréntesis", () => {
    expect(textos("a) Primera pregunta larga\nb) Segunda pregunta larga")).toEqual([
      "Primera pregunta larga",
      "Segunda pregunta larga",
    ]);
  });

  it("guiones y viñetas", () => {
    expect(textos("- Primera pregunta larga\n- Segunda pregunta larga")).toHaveLength(2);
    expect(textos("• Primera pregunta larga\n• Segunda pregunta larga")).toHaveLength(2);
  });

  it("«Ejercicio N» y «Punto N» también son marcas", () => {
    expect(textos("Ejercicio 1\nUna cosa larga\nEjercicio 2\nOtra cosa larga")).toHaveLength(2);
    expect(textos("Punto 1: una cosa larga\nPunto 2: otra cosa larga")).toHaveLength(2);
  });
});

describe("segmentarPreguntas — enunciados de varias líneas", () => {
  it("las líneas sin marca pertenecen al enunciado anterior", () => {
    const t = `Pregunta 1
Dado el siguiente escenario:
la empresa despliega en la nube
y no administra servidores.
¿Qué modelo es?
Pregunta 2
¿Qué es un ADR?`;
    const s = segmentarPreguntas(t);
    expect(s).toHaveLength(2);
    expect(s[0].texto.split("\n")).toHaveLength(4);
    expect(s[0].texto).toContain("no administra servidores");
  });

  it("las líneas en blanco entre preguntas no crean segmentos vacíos", () => {
    const t = "Pregunta 1\n\n¿Qué es PaaS?\n\n\nPregunta 2\n\n¿Qué es un ADR?\n\n";
    expect(textos(t)).toEqual(["¿Qué es PaaS?", "¿Qué es un ADR?"]);
  });
});

describe("segmentarPreguntas — encabezados sueltos", () => {
  it("descarta un encabezado corto sin pinta de pregunta", () => {
    const t = `Parcial de Arquitectura — 2026-2
1. ¿Qué es un ADR y para qué sirve?
2. ¿Qué es PaaS y en qué se diferencia?`;
    expect(textos(t)).toEqual([
      "¿Qué es un ADR y para qué sirve?",
      "¿Qué es PaaS y en qué se diferencia?",
    ]);
  });

  it("conserva un encabezado que contiene una pregunta", () => {
    const t = `¿Cuál de las siguientes afirmaciones es correcta?
1. La primera afirmación posible
2. La segunda afirmación posible`;
    expect(textos(t)[0]).toContain("afirmaciones es correcta");
    expect(textos(t)).toHaveLength(3);
  });
});

describe("segmentarPreguntas — texto sin marcas", () => {
  it("sin marcas, corta por párrafos separados por línea en blanco", () => {
    const t = "¿Qué es un ADR y para qué sirve?\n\n¿Qué es PaaS y cómo se diferencia de IaaS?";
    const s = segmentarPreguntas(t);
    expect(s).toHaveLength(2);
    expect(s.every((x) => x.confiable)).toBe(false);
  });

  it("un solo párrafo devuelve un único segmento con el texto completo", () => {
    const t = "¿Qué es un ADR?\n¿Y qué es PaaS?";
    const s = segmentarPreguntas(t);
    expect(s).toHaveLength(1);
    expect(s[0].texto).toContain("PaaS");
  });

  it("texto vacío o solo espacios devuelve nada", () => {
    expect(segmentarPreguntas("")).toEqual([]);
    expect(segmentarPreguntas("   \n\n \t ")).toEqual([]);
    expect(segmentarPreguntas(null as unknown as string)).toEqual([]);
  });

  it("una sola marca no alcanza para cortar por marcas", () => {
    const s = segmentarPreguntas("1. ¿Qué es un ADR y para qué sirve exactamente?");
    expect(s).toHaveLength(1);
    expect(s[0].confiable).toBe(false);
  });
});

describe("agruparEnLotes", () => {
  const conMarcas = (n: number) =>
    Array.from(
      { length: n },
      (_, i) => `Pregunta ${i + 1}\nEnunciado número ${i + 1} del parcial.`,
    ).join("\n");

  it("30 preguntas con marca → 4 lotes de a 8 como máximo", () => {
    const s = segmentarPreguntas(conMarcas(30));
    expect(s).toHaveLength(30);
    const lotes = agruparEnLotes(s, MAX_PREGUNTAS_POR_LOTE);
    expect(lotes).toHaveLength(4);
    expect(lotes.map((l) => l.indices.length)).toEqual([8, 8, 8, 6]);
    expect(lotes.flatMap((l) => l.indices)).toEqual(s.map((_, i) => i));
  });

  it("el texto del lote es el crudo de sus segmentos, en orden", () => {
    const s = segmentarPreguntas(conMarcas(3));
    const [lote] = agruparEnLotes(s, 8);
    expect(lote.texto).toContain("Pregunta 1");
    expect(lote.texto).toContain("Pregunta 3");
    expect(lote.texto.indexOf("Pregunta 1")).toBeLessThan(lote.texto.indexOf("Pregunta 2"));
  });

  it("sin marcas confiables devuelve UN solo lote con todo", () => {
    const s = segmentarPreguntas("Bloque uno del examen.\n\nBloque dos del examen.");
    const lotes = agruparEnLotes(s, 1);
    expect(lotes).toHaveLength(1);
    expect(lotes[0].indices).toEqual([0, 1]);
  });

  it("las líneas sin marca viajan con la pregunta a la que pertenecen", () => {
    const t = `Pregunta 1
Primera línea del enunciado
segunda línea del enunciado
Pregunta 2
Otro enunciado cualquiera`;
    const lotes = agruparEnLotes(segmentarPreguntas(t), 1);
    expect(lotes).toHaveLength(2);
    expect(lotes[0].texto).toContain("segunda línea del enunciado");
    expect(lotes[0].texto).not.toContain("Otro enunciado");
  });

  it("sin segmentos no hay lotes", () => {
    expect(agruparEnLotes([], 8)).toEqual([]);
  });

  it("un max inválido cae al default en vez de generar lotes vacíos", () => {
    const s = segmentarPreguntas(conMarcas(10));
    expect(agruparEnLotes(s, 0)).not.toHaveLength(0);
    expect(agruparEnLotes(s, Number.NaN)).not.toHaveLength(0);
  });
});

describe("emparejarConSegmentos", () => {
  const DIEZ = Array.from(
    { length: 10 },
    (_, i) => `Pregunta ${i + 1}\nEnunciado número ${i + 1} del parcial de nube.`,
  ).join("\n");

  it("8 de 10: los 2 sin clasificar salen como huérfanos", () => {
    const s = segmentarPreguntas(DIEZ);
    const enunciados = s.slice(0, 8).map((x) => x.texto);
    const { emparejados, huerfanos } = emparejarConSegmentos(s, enunciados);
    expect(emparejados).toHaveLength(8);
    expect(huerfanos).toEqual([8, 9]);
  });

  it("empareja aunque la IA reescriba el enunciado (tildes, ¿ y ?)", () => {
    const s = segmentarPreguntas("Pregunta 1\nQue es un ADR\nPregunta 2\nQue es PaaS y para que");
    const { huerfanos } = emparejarConSegmentos(s, ["¿Qué es un ADR?", "¿Qué es PaaS y para qué?"]);
    expect(huerfanos).toEqual([]);
  });

  it("sin enunciados, todo es huérfano", () => {
    const s = segmentarPreguntas(DIEZ);
    expect(emparejarConSegmentos(s, []).huerfanos).toHaveLength(10);
  });

  it("no marca huérfano un segmento sin texto comparable", () => {
    expect(
      emparejarConSegmentos([{ texto: "...", crudo: "...", confiable: false }], []).huerfanos,
    ).toEqual([]);
  });
});

describe("normalizarEnunciado", () => {
  it("quita marca, acentos, puntuación y colapsa espacios", () => {
    expect(normalizarEnunciado("Pregunta 3\n¿Qué   es un ADR?")).toBe("que es un adr");
    expect(normalizarEnunciado("  3)  ¿Qué es PaaS?  ")).toBe("que es paas");
  });

  it("usa solo la primera línea (es la que identifica la pregunta)", () => {
    expect(normalizarEnunciado("¿Qué es un ADR?\nExplicá con un ejemplo.")).toBe("que es un adr");
  });

  it("tolera nulos", () => {
    expect(normalizarEnunciado(null as unknown as string)).toBe("");
  });
});

describe("segmentarPreguntas — no se pierde texto del docente", () => {
  it("las opciones de una pregunta cerrada NO se descartan", () => {
    // El caso central del producto: pegar un parcial de opcion multiple ya
    // escrito. La primera version cortaba tambien por `a)` / `-` y despues
    // descartaba el trozo por corto, asi que las CUATRO opciones desaparecian
    // del texto que se le manda al modelo.
    const parcial = [
      "1. Si solo despliega codigo y el proveedor gestiona el runtime, que modelo es?",
      "a) IaaS",
      "b) PaaS",
      "c) SaaS",
      "d) FaaS",
      "",
      "2. Que es un ADR?",
    ].join("\n");
    const segs = segmentarPreguntas(parcial);
    expect(segs).toHaveLength(2);
    expect(segs[0].crudo).toContain("a) IaaS");
    expect(segs[0].crudo).toContain("d) FaaS");
    expect(segs[1].texto).toBe("Que es un ADR?");
  });

  it("ninguna linea del texto pegado queda afuera de los segmentos", () => {
    // Invariante: la union de los `crudo` contiene todas las lineas.
    const texto = [
      "Pregunta 1",
      "Que es IaaS?",
      "- opcion corta",
      "Pregunta 2",
      "Que es PaaS?",
      "a) si",
    ].join("\n");
    const segs = segmentarPreguntas(texto);
    const unido = segs.map((s) => s.crudo).join("\n");
    for (const linea of texto.split("\n").map((l) => l.trim()).filter(Boolean)) {
      expect(unido).toContain(linea);
    }
  });
});

/**
 * El mismo invariante que el bloque de arriba, sobre las líneas que el descarte
 * del preámbulo y el filtro de bloques cortos SÍ estaban borrando. El arreglo
 * anterior se había aplicado a una sola de las dos rutas de segmentación, así
 * que el invariante valía para la vía de marcas y era falso para la de párrafos.
 */
describe("segmentarPreguntas — el enunciado tampoco se pierde", () => {
  /** Todas las líneas no vacías del texto aparecen en la unión de los `crudo`. */
  function nadaPerdido(texto: string) {
    const segs = segmentarPreguntas(texto);
    const unido = segs.map((s) => s.crudo).join("\n");
    const lineas = texto
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    for (const linea of lineas) {
      expect(unido).toContain(linea);
    }
    return segs;
  }

  it("stem IMPERATIVO sin «?» con una sola marca alta: no se descarta", () => {
    // Sin el rescate: usandoAltas=false (una sola marca alta), se corta por las
    // bajas, y el enunciado cae en el preámbulo, que se conservaba solo con «?»
    // o con 120+ caracteres. Al modelo le llegaban cuatro opciones sin pregunta.
    const t = ["1. Seleccione el modelo correcto", "a) IaaS", "b) PaaS", "c) SaaS", "d) FaaS"].join(
      "\n",
    );
    const segs = nadaPerdido(t);
    expect(segs.map((s) => s.crudo).join("\n")).toContain("Seleccione el modelo correcto");
  });

  it("stem terminado en «:» tampoco se descarta", () => {
    const t = [
      "Marque la afirmación verdadera:",
      "a) IaaS es plataforma",
      "b) PaaS es plataforma",
    ].join("\n");
    const segs = nadaPerdido(t);
    expect(segs.map((s) => s.crudo).join("\n")).toContain("Marque la afirmación verdadera:");
  });

  it("una opción huérfana ANTES de la primera marca alta se conserva", () => {
    const t = ["d) FaaS", "1. ¿Cuál es el modelo correcto?", "2. ¿Cuál NO lo es?"].join("\n");
    nadaPerdido(t);
  });

  it("bloque corto entre párrafos se anexa al anterior, no se descarta", () => {
    const t = [
      "Explique qué es la computación en la nube.",
      "",
      "IaaS",
      "",
      "Compare IaaS con PaaS en términos de responsabilidad.",
    ].join("\n");
    const segs = nadaPerdido(t);
    expect(segs).toHaveLength(2);
    expect(segs[0].crudo).toContain("IaaS");
  });

  it("NO regresión: un encabezado de verdad se sigue descartando", () => {
    // La contraparte del rescate. Con DOS marcas altas, un encabezado sin «?»,
    // corto y que no empieza con viñeta ni letra de opción, no es contenido:
    // pegarlo al primer enunciado haría que la reconciliación lo ofreciera como
    // pregunta suelta.
    const t = [
      "Parcial de Arquitectura de Software 2026-2",
      "Nombre: ______",
      "1. ¿Qué es un ADR y para qué sirve?",
      "2. ¿Qué es PaaS y en qué se diferencia?",
    ].join("\n");
    const segs = segmentarPreguntas(t);
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.crudo).join("\n")).not.toContain("Nombre:");
  });
});

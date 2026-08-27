import { describe, expect, it } from "vitest";
import { buildPollResultsHtml, type DatosImpresion, type TextosImpresion } from "./print-results";
import { optionFillPercent } from "./poll-results";

const TEXTOS: TextosImpresion = {
  tituloDoc: "Resultados de encuesta",
  curso: "Curso",
  estado: "Estado",
  abierta: "Abierta",
  cerrada: "Cerrada",
  generado: "Generado",
  respuesta: "respuesta",
  respuestas: "respuestas",
  sinRespuestas: "Sin respuestas todavía",
  cupo: "Cupo",
  cupoLleno: "cupo lleno",
  participante: "participante",
  participantes: "participantes",
  preguntaAbierta: "respuesta abierta",
  sinNombresNota: "Documento sin nombres",
  conNombresNota: "Documento con nombres",
  variasMarcasNota: "admite varias marcas",
};

function datos(over: Partial<DatosImpresion> = {}): DatosImpresion {
  return {
    marca: {
      institucion: "Universidad Antonio José Camacho",
      logoUrl: null,
      colorPrimario: "#1d4ed8",
    },
    titulo: "Encuesta inicial",
    descripcion: null,
    tipo: "single",
    curso: "Bases de Datos II",
    cerrada: false,
    generadoEl: "24 ago 2026, 14:30",
    totalRespuestas: 4,
    opciones: [],
    preguntas: [],
    conNombres: true,
    textos: TEXTOS,
    ...over,
  };
}

describe("buildPollResultsHtml — la marca", () => {
  it("imprime el nombre de la institución y su logo", () => {
    const h = buildPollResultsHtml(
      datos({
        marca: { institucion: "FESNA", logoUrl: "https://x/logo.png", colorPrimario: "#c0392b" },
      }),
    );
    expect(h).toContain("FESNA");
    expect(h).toContain('src="https://x/logo.png"');
    expect(h).toContain("#c0392b");
  });

  it("sin logo NO deja la etiqueta img vacía", () => {
    // Un `<img src="">` pide la página actual y pinta el ícono de imagen rota
    // en el encabezado del documento impreso.
    const h = buildPollResultsHtml(
      datos({ marca: { institucion: "FESNA", logoUrl: null, colorPrimario: null } }),
    );
    expect(h).not.toContain("<img");
  });

  it("un color inválido cae a un gris legible en vez de romper el CSS", () => {
    const h = buildPollResultsHtml(
      datos({ marca: { institucion: "X", logoUrl: null, colorPrimario: "no-es-un-color" } }),
    );
    expect(h).not.toContain("no-es-un-color");
    expect(h).toContain("#334155");
  });

  it("el texto sobre el color de marca contrasta en ambos extremos", () => {
    const oscuro = buildPollResultsHtml(
      datos({ marca: { institucion: "X", logoUrl: null, colorPrimario: "#0b1020" } }),
    );
    const claro = buildPollResultsHtml(
      datos({ marca: { institucion: "X", logoUrl: null, colorPrimario: "#fde68a" } }),
    );
    expect(oscuro).toContain("color: #ffffff");
    expect(claro).toContain("color: #111827");
  });
});

describe("buildPollResultsHtml — el porcentaje coincide con la pantalla", () => {
  it("en encuestas de CUPO mide el llenado del cupo, no la cuota del total", () => {
    // La regla que ya existía en pantalla: un cupo 1/1 se ve al 100%, no al 20%.
    // Si la hoja impresa la recalculara por su cuenta, el docente defendería en
    // una reunión un número que la plataforma no muestra.
    const h = buildPollResultsHtml(
      datos({
        tipo: "slot",
        totalRespuestas: 5,
        opciones: [{ etiqueta: "Lunes 9:00", conteo: 1, cupo: 1, votantes: [] }],
      }),
    );
    const esperado = optionFillPercent({
      pollType: "slot",
      responsesCount: 1,
      maxResponses: 1,
      totalResponses: 5,
    });
    expect(esperado.pct).toBe(100);
    expect(h).toContain("width:100%");
    expect(h).toContain("cupo lleno");
    // Con cupo, el "2/2" ya dice el conteo Y el porcentaje: repetir
    // "1 respuestas … 100%" decía el mismo número tres veces en una línea.
    expect(h).toContain("Cupo 1/1");
    expect(h).not.toContain("1 respuesta ·");
    expect(h).not.toContain("· 100%");
  });

  it("en single mide la cuota sobre el total", () => {
    const h = buildPollResultsHtml(
      datos({
        tipo: "single",
        totalRespuestas: 4,
        opciones: [{ etiqueta: "Sí", conteo: 1, cupo: null, votantes: [] }],
      }),
    );
    expect(h).toContain("width:25%");
  });

  it("sin respuestas no muestra un 0% engañoso ni divide por cero", () => {
    const h = buildPollResultsHtml(
      datos({
        totalRespuestas: 0,
        opciones: [{ etiqueta: "Sí", conteo: 0, cupo: null, votantes: [] }],
      }),
    );
    expect(h).toContain("width:0%");
    expect(h).not.toContain("NaN");
  });

  it("en una MIXTA el denominador es quien respondió ESA pregunta", () => {
    // Una pregunta que la mitad del curso salteó no debe mostrar porcentajes
    // diluidos contra el total general de la encuesta.
    const h = buildPollResultsHtml(
      datos({
        tipo: "mixed",
        totalRespuestas: 100,
        preguntas: [
          {
            texto: "¿Trabajas?",
            tipo: "cerrada",
            multi: false,
            opciones: [{ etiqueta: "Sí", conteo: 1 }],
            abiertas: [],
            totalRespuestas: 2,
          },
        ],
      }),
    );
    expect(h).toContain("width:50%");
  });
});

describe("buildPollResultsHtml — privacidad", () => {
  it("con nombres los lista, y la nota del pie lo dice", () => {
    const h = buildPollResultsHtml(
      datos({
        conNombres: true,
        opciones: [{ etiqueta: "Sí", conteo: 1, cupo: null, votantes: ["Ana Gómez"] }],
      }),
    );
    expect(h).toContain("Ana Gómez");
    expect(h).toContain("Documento con nombres");
  });

  it("en modo anónimo NINGÚN nombre llega al HTML", () => {
    // El caller vacía `votantes` y pone `autor: null`. Este test fija que el
    // módulo no reintroduzca el nombre por otro lado (un title, un alt, un
    // atributo de dato) — la hoja impresa circula en papel.
    const h = buildPollResultsHtml(
      datos({
        tipo: "mixed",
        conNombres: false,
        preguntas: [
          {
            texto: "¿Cómo te sentiste?",
            tipo: "abierta",
            multi: false,
            opciones: [],
            abiertas: [{ autor: null, texto: "Con mucha ansiedad" }],
            totalRespuestas: 1,
          },
        ],
      }),
    );
    expect(h).toContain("Con mucha ansiedad");
    expect(h).not.toContain("Ana");
    // `autor` es además el nombre de una clase CSS que va siempre en el
    // <style>; lo que se afirma es que no se emita el ELEMENTO del autor.
    expect(h).not.toContain('<span class="autor">');
    expect(h).toContain("Documento sin nombres");
  });
});

describe("buildPollResultsHtml — texto del usuario", () => {
  it("escapa el HTML de una respuesta abierta", () => {
    const h = buildPollResultsHtml(
      datos({
        tipo: "mixed",
        preguntas: [
          {
            texto: "Comentarios",
            tipo: "abierta",
            multi: false,
            opciones: [],
            abiertas: [{ autor: "Ana", texto: '<script>alert(1)</script> 5 < 10 & "ok"' }],
            totalRespuestas: 1,
          },
        ],
      }),
    );
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("5 &lt; 10 &amp;");
  });

  it("escapa el título y el nombre de la institución", () => {
    const h = buildPollResultsHtml(
      datos({
        titulo: 'Encuesta "difícil" & <b>rara</b>',
        marca: { institucion: "<i>Inst</i>", logoUrl: null, colorPrimario: null },
      }),
    );
    expect(h).not.toContain("<b>rara</b>");
    expect(h).not.toContain("<i>Inst</i>");
    expect(h).toContain("&lt;b&gt;rara&lt;/b&gt;");
  });

  it("escapa la URL del logo (no permite cerrar el atributo)", () => {
    const h = buildPollResultsHtml(
      datos({
        marca: { institucion: "X", logoUrl: '"><script>alert(1)</script>', colorPrimario: null },
      }),
    );
    expect(h).not.toContain("<script>");
  });

  it("conserva los saltos de línea de una respuesta larga", () => {
    // `white-space: pre-wrap` en la clase `.texto`: sin eso una respuesta de
    // varios párrafos se imprime como un bloque corrido.
    const h = buildPollResultsHtml(datos());
    expect(h).toContain("white-space: pre-wrap");
  });
});

describe("buildPollResultsHtml — que la hoja salga imprimible", () => {
  it("fuerza los colores para que las barras no salgan en blanco", () => {
    const h = buildPollResultsHtml(datos());
    expect(h).toContain("print-color-adjust: exact");
  });

  it("protege la unidad atómica del corte de página, no el bloque entero", () => {
    // Medido con 14 preguntas: prohibir partir la pregunta daba 7 páginas
    // contra 6, dejando hasta una página de blanco en el medio. Lo que no se
    // negocia es una barra o una respuesta cortada, y un título de pregunta
    // solo al pie de la hoja.
    const h = buildPollResultsHtml(datos({ tipo: "mixed" }));
    expect(h).toContain(".fila { margin: 0 0 11px; break-inside: avoid");
    expect(h).toContain("ul.abiertas li");
    expect(h).toMatch(/\.pregunta > h2[^}]*break-after: avoid/);
    // La pregunta entera NO debe llevar la prohibición.
    expect(h).not.toMatch(/\.pregunta \{[^}]*break-inside: avoid/);
  });

  it("declara A4 y un documento HTML completo", () => {
    const h = buildPollResultsHtml(datos());
    expect(h.startsWith("<!doctype html>")).toBe(true);
    expect(h).toContain("@page { size: A4");
    expect(h).toContain('<html lang="es">');
    expect(h.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("una encuesta sin datos imprime el vacío explicado, no una hoja muda", () => {
    const h = buildPollResultsHtml(datos({ opciones: [] }));
    expect(h).toContain("Sin respuestas todavía");
  });

  it("marca las cerradas de varias marcas para que el >100% no parezca un error", () => {
    const h = buildPollResultsHtml(
      datos({
        tipo: "mixed",
        preguntas: [
          {
            texto: "Elegí todas",
            tipo: "cerrada",
            multi: true,
            opciones: [{ etiqueta: "A", conteo: 2 }],
            abiertas: [],
            totalRespuestas: 2,
          },
        ],
      }),
    );
    expect(h).toContain("admite varias marcas");
  });
});

describe("buildPollResultsHtml — concordancia de número", () => {
  it('una sola respuesta no dice "1 respuestas"', () => {
    const h = buildPollResultsHtml(
      datos({
        totalRespuestas: 1,
        opciones: [{ etiqueta: "Sí", conteo: 1, cupo: null, votantes: [] }],
      }),
    );
    expect(h).toContain("1 respuesta ·");
    expect(h).not.toContain("1 respuestas");
    expect(h).toContain("1 participante</p>");
    expect(h).not.toContain("1 participantes");
  });

  it("con varias usa el plural", () => {
    const h = buildPollResultsHtml(
      datos({
        totalRespuestas: 3,
        opciones: [{ etiqueta: "Sí", conteo: 2, cupo: null, votantes: [] }],
      }),
    );
    expect(h).toContain("2 respuestas");
    expect(h).toContain("3 participantes");
  });

  it('cero usa el plural ("0 respuestas", no "0 respuesta")', () => {
    const h = buildPollResultsHtml(
      datos({
        totalRespuestas: 0,
        opciones: [{ etiqueta: "Sí", conteo: 0, cupo: null, votantes: [] }],
      }),
    );
    expect(h).toContain("0 respuestas");
  });

  it("también en las preguntas de una encuesta mixta", () => {
    const h = buildPollResultsHtml(
      datos({
        tipo: "mixed",
        preguntas: [
          {
            texto: "¿Trabajas?",
            tipo: "cerrada",
            multi: false,
            opciones: [{ etiqueta: "Sí", conteo: 1 }],
            abiertas: [],
            totalRespuestas: 1,
          },
        ],
      }),
    );
    expect(h).not.toContain("1 respuestas");
  });
  it("la descripcion se RENDERIZA como markdown, igual que en pantalla", () => {
    // Reportado: el PDF imprimia literalmente los asteriscos de
    // "**solo yo veo tus respuestas**", mientras el alumno en pantalla lo ve en
    // negrita (MarkdownInline). El papel decia una cosa y la pantalla otra.
    const h = buildPollResultsHtml(
      datos({
        descripcion: "Opcional y confidencial: **solo yo veo tus respuestas**, no tus companeros.",
      }),
    );
    expect(h).toContain("<strong>solo yo veo tus respuestas</strong>");
    expect(h).not.toContain("**solo yo veo tus respuestas**");
  });

  it("y la descripcion sigue escapando el HTML que alguien escriba", () => {
    const h = buildPollResultsHtml(datos({ descripcion: "<script>alert(1)</script> **ok**" }));
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
    expect(h).toContain("<strong>ok</strong>");
  });

  it("una respuesta abierta NO se altera: se muestra tal como la escribio el alumno", () => {
    // Renderizar markdown aca convertiria "2 * 3 * 4" en "2 <em>3</em> 4":
    // alterar lo que alguien escribio es peor que mostrarle un asterisco.
    // `tipo: "mixed"` no es decorativo: es el unico que enruta al bloque de
    // PREGUNTAS. Sin eso el override se ignora y el test pasa sin probar nada
    // (fallo que me agarro este mismo assert).
    const h = buildPollResultsHtml(
      datos({
        tipo: "mixed",
        preguntas: [
          {
            texto: "Calculo",
            tipo: "abierta",
            multi: false,
            opciones: [],
            abiertas: [{ autor: null, texto: "2 * 3 * 4 = 24" }],
            totalRespuestas: 1,
          },
        ],
      }),
    );
    expect(h).toContain("2 * 3 * 4 = 24");
    expect(h).not.toContain("<em>");
  });
});

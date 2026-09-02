import { describe, expect, it } from "vitest";
import {
  anonimizarDatos,
  buildPollResultsHtml,
  type DatosImpresion,
  type TextosImpresion,
} from "./print-results";
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
  faltanTitulo: "Faltan por responder",
  faltanResumen: "{{n}} de {{total}} respondieron",
  faltanNadie: "Respondió todo el curso.",
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
        opciones: [
          {
            etiqueta: "Sí",
            conteo: 1,
            cupo: null,
            votantes: [{ nombre: "Ana Gómez", email: "ana.gomez@uni.edu.co" }],
          },
        ],
      }),
    );
    expect(h).toContain("Ana Gómez");
    expect(h).toContain("Documento con nombres");
  });

  it("imprime el CORREO de cada participante junto a su nombre", () => {
    // El correo es lo que vuelve al informe accionable: con el nombre solo, quien
    // lo lee tiene que ir a otra pantalla a buscar a cada persona.
    const h = buildPollResultsHtml(
      datos({
        conNombres: true,
        opciones: [
          {
            etiqueta: "Sí",
            conteo: 2,
            cupo: null,
            votantes: [
              { nombre: "Ana Gómez", email: "ana.gomez@uni.edu.co" },
              { nombre: "Beto Ruiz", email: "beto.ruiz@uni.edu.co" },
            ],
          },
        ],
      }),
    );
    expect(h).toContain("ana.gomez@uni.edu.co");
    expect(h).toContain("beto.ruiz@uni.edu.co");
  });

  it("sin correo cargado imprime solo el nombre, no un hueco ni un 'null'", () => {
    const h = buildPollResultsHtml(
      datos({
        conNombres: true,
        opciones: [
          {
            etiqueta: "Sí",
            conteo: 2,
            cupo: null,
            votantes: [{ nombre: "Ana Gómez", email: null }, { nombre: "Beto Ruiz" }],
          },
        ],
      }),
    );
    expect(h).toContain("Ana Gómez");
    expect(h).toContain("Beto Ruiz");
    expect(h).not.toContain("null");
    expect(h).not.toContain("undefined");
    // Y no queda el contenedor del correo vacío.
    expect(h).not.toMatch(/<span class="pm"><\/span>/);
  });

  it("el correo se ESCAPA igual que el nombre", () => {
    const h = buildPollResultsHtml(
      datos({
        conNombres: true,
        opciones: [
          {
            etiqueta: "Sí",
            conteo: 1,
            cupo: null,
            votantes: [{ nombre: "X", email: "<script>alert(1)</script>@x.co" }],
          },
        ],
      }),
    );
    expect(h).not.toContain("<script>");
    expect(h).toContain("&lt;script&gt;");
  });

  it("el correo del autor sale en las respuestas abiertas", () => {
    const h = buildPollResultsHtml(
      datos({
        tipo: "mixed",
        conNombres: true,
        preguntas: [
          {
            texto: "¿Qué mejorarías?",
            tipo: "abierta",
            multi: false,
            opciones: [],
            abiertas: [
              { autor: "Ana Gómez", email: "ana.gomez@uni.edu.co", texto: "Más ejercicios" },
            ],
            totalRespuestas: 1,
          },
        ],
      }),
    );
    expect(h).toContain("ana.gomez@uni.edu.co");
    expect(h).toContain("Más ejercicios");
  });

  it("en modo anónimo el correo TAMPOCO llega al HTML", () => {
    // El caller vacía los votantes en modo anónimo; este test fija que agregar
    // el correo no abrió una segunda vía para filtrar identidad.
    const h = buildPollResultsHtml(
      datos({
        conNombres: false,
        opciones: [{ etiqueta: "Sí", conteo: 1, cupo: null, votantes: [] }],
      }),
    );
    // Se busca la FORMA de un correo, no el arroba suelto: el CSS del documento
    // tiene `@page` y `@media`, así que `not.toContain("@")` no probaba nada.
    expect(h).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
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
    // Se afirma la PROTECCIÓN, no el margen exacto: fijar los px hacía que
    // cualquier ajuste de densidad rompiera un test que no habla de densidad.
    expect(h).toMatch(/\.fila \{[^}]*break-inside: avoid/);
    expect(h).toContain("ul.abiertas li");
    expect(h).toMatch(/\.pregunta > h2[^}]*break-after: avoid/);
    // La pregunta entera NO debe llevar la prohibición.
    expect(h).not.toMatch(/\.pregunta \{[^}]*break-inside: avoid/);
  });

  it("el separador de participantes no puede abrir un renglón", () => {
    // Medido en el navegador con 23 participantes: con el separador saliendo de
    // un `::after { content: " · " }`, ese espacio de adelante era un punto de
    // corte y quedaban viñetas huérfanas abriendo renglón. Va pegado con espacio
    // duro al participante que termina, así el corte queda del otro lado.
    const h = buildPollResultsHtml(
      datos({
        conNombres: true,
        opciones: [
          {
            etiqueta: "Sí",
            conteo: 2,
            cupo: null,
            votantes: [
              { nombre: "Ana Gómez", email: "ana@uni.edu.co" },
              { nombre: "Beto Ruiz", email: "beto@uni.edu.co" },
            ],
          },
        ],
      }),
    );
    expect(h).toContain('<span class="sep">&#160;·</span>');
    // Y el último no lleva separador colgando.
    expect(h).toMatch(/beto@uni\.edu\.co<\/span><\/span>/);
    // El separador ya NO puede venir de content: con un espacio normal delante.
    expect(h).not.toContain('content: " · "');
  });

  it("una encuesta de opciones y una mixta imprimen con la MISMA densidad", () => {
    // Las dos rutas eran dos copias del mismo bloque, y al compactar la de
    // opciones la mixta quedó con dos renglones por opción: el mismo documento
    // con dos densidades segun el tipo de encuesta. Ahora las dos pasan por
    // `filaOpcion`, y esto lo fija.
    const simple = buildPollResultsHtml(
      datos({
        tipo: "single",
        totalRespuestas: 2,
        opciones: [{ etiqueta: "Sí", conteo: 1, cupo: null, votantes: [] }],
      }),
    );
    const mixta = buildPollResultsHtml(
      datos({
        tipo: "mixed",
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
    // La etiqueta y el conteo comparten renglón en las dos (la clase `cab`).
    expect(simple).toContain('<div class="cab">');
    expect(mixta).toContain('<div class="cab">');
    // Y en las dos el conteo va como span dentro de esa línea, no como párrafo
    // aparte debajo de la barra.
    expect(mixta).not.toMatch(/<p class="meta">1 respuesta/);
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

describe("anonimizarDatos", () => {
  // El correo agregó un SEGUNDO canal de identidad por participante, y el que
  // faltaba limpiar era justamente ese: el correo del autor de una respuesta
  // abierta. No filtraba, pero solo porque el armador no lo pinta sin autor — un
  // detalle del renderizador del que el anonimato no debe depender.
  const conIdentidad = () =>
    datos({
      tipo: "mixed",
      conNombres: true,
      opciones: [
        {
          etiqueta: "Sí",
          conteo: 1,
          cupo: null,
          votantes: [{ nombre: "Ana Gómez", email: "ana@uni.edu.co" }],
        },
      ],
      preguntas: [
        {
          texto: "¿Cómo vas?",
          tipo: "cerrada",
          multi: false,
          totalRespuestas: 1,
          opciones: [{ etiqueta: "Bien", conteo: 1 }],
          abiertas: [],
        },
        {
          texto: "¿Qué mejorarías?",
          tipo: "abierta",
          multi: false,
          totalRespuestas: 1,
          opciones: [],
          abiertas: [{ autor: "Caro Díaz", email: "caro@uni.edu.co", texto: "Más práctica" }],
        },
      ],
    });

  it("vacía los votantes de las opciones de primer nivel", () => {
    expect(anonimizarDatos(conIdentidad()).opciones[0].votantes).toEqual([]);
  });

  it("borra el autor Y su correo de las respuestas abiertas", () => {
    const a = anonimizarDatos(conIdentidad()).preguntas[1].abiertas[0];
    expect(a.autor).toBeNull();
    expect(a.email).toBeNull();
    // El texto de la respuesta se conserva: es el contenido, no la identidad.
    expect(a.texto).toBe("Más práctica");
  });

  it("ningún nombre ni correo sobrevive al HTML final", () => {
    const h = buildPollResultsHtml({ ...anonimizarDatos(conIdentidad()), conNombres: false });
    for (const dato of ["Ana Gómez", "Caro Díaz", "ana@uni.edu.co", "caro@uni.edu.co"]) {
      expect(h).not.toContain(dato);
    }
    expect(h).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });

  it("no muta lo que recibe", () => {
    // El botón imprime dos veces desde el mismo estado (con nombres y sin), así
    // que mutar la entrada dejaría la segunda impresión vacía de nombres.
    const original = conIdentidad();
    anonimizarDatos(original);
    expect(original.opciones[0].votantes).toHaveLength(1);
    expect(original.preguntas[1].abiertas[0].autor).toBe("Caro Díaz");
    expect(original.preguntas[1].abiertas[0].email).toBe("caro@uni.edu.co");
  });

  it("conserva todo lo que NO es identidad", () => {
    const r = anonimizarDatos(conIdentidad());
    expect(r.opciones[0].conteo).toBe(1);
    expect(r.opciones[0].etiqueta).toBe("Sí");
    expect(r.preguntas[0].texto).toBe("¿Cómo vas?");
    expect(r.preguntas[0].totalRespuestas).toBe(1);
  });
});

describe("quiénes eligieron cada opción (encuesta mixta)", () => {
  const conQuienes = (quienes: Array<{ nombre: string; documento?: string | null }>) =>
    datos({
    tipo: "mixed",
    opciones: [],
    preguntas: [
      {
        texto: "¿Desde qué dispositivo vas a ver las clases?",
        tipo: "cerrada" as const,
        multi: false,
        totalRespuestas: quienes.length,
        opciones: [{ etiqueta: "Celular", conteo: quienes.length, quienes }],
        abiertas: [],
      },
    ],
  });

  it("imprime los NOMBRES de quienes eligieron la opción", () => {
    // Antes la hoja decía "Celular: 3" sin decir quiénes, así que para responder un
    // requerimiento por persona había que volver a la pantalla y anotar a mano.
    const html = buildPollResultsHtml(conQuienes([{ nombre: "Ana Gómez" }, { nombre: "Luis Paz" }]));
    expect(html).toContain("Ana Gómez");
    expect(html).toContain("Luis Paz");
  });

  it("imprime el DOCUMENTO junto al nombre cuando está", () => {
    // El requerimiento que originó esto pide "documento de identidad y nombre
    // completos": con el nombre solo hay que ir a buscar cada cédula aparte.
    const html = buildPollResultsHtml(conQuienes([{ nombre: "Ana Gómez", documento: "1144055123" }]));
    expect(html).toContain("1144055123");
  });

  it("un participante sin documento no imprime un hueco ni 'null'", () => {
    const html = buildPollResultsHtml(conQuienes([{ nombre: "Ana Gómez", documento: null }]));
    expect(html).toContain("Ana Gómez");
    expect(html).not.toContain("null");
    expect(html).not.toContain('class="pd"');
  });

  it("el modo SIN NOMBRES los borra, y conserva el conteo", () => {
    // Es la garantía que importa: en una encuesta de bienestar, quién eligió qué es
    // justo lo que no debe circular.
    const datos = conQuienes([{ nombre: "Ana Gómez", documento: "1144055123" }]);
    const html = buildPollResultsHtml({ ...anonimizarDatos(datos), conNombres: false });
    expect(html).not.toContain("Ana Gómez");
    expect(html).not.toContain("1144055123");
    expect(html).toContain("Celular");
  });
});

describe("quiénes faltan por responder", () => {
  const conPendientes = () =>
    datos({
    tipo: "mixed",
    opciones: [],
    preguntas: [],
    pendientes: [
      {
        curso: "Bases de Datos II",
        total: 20,
        respondieron: 9,
        faltan: [
          { nombre: "Pedro Ruiz", documento: "1002003004" },
          { nombre: "Sara Díaz", documento: null },
        ],
      },
      { curso: "Programación II", total: 5, respondieron: 5, faltan: [] },
    ],
  });

  it("la hoja dice CUÁNTOS respondieron y QUIÉNES faltan", () => {
    // Un consolidado que dice "3 sin computador" sobre una encuesta que respondió
    // el 46% del curso no es un consolidado, y quien lo recibe no puede saberlo.
    const html = buildPollResultsHtml(conPendientes());
    expect(html).toContain("Faltan por responder");
    expect(html).toContain("Bases de Datos II");
    expect(html).toContain("9 de 20 respondieron");
    expect(html).toContain("Pedro Ruiz");
    expect(html).toContain("1002003004");
  });

  it("un curso que respondió completo lo dice, no queda vacío", () => {
    const html = buildPollResultsHtml(conPendientes());
    expect(html).toContain("Respondió todo el curso.");
  });

  it("sin la sección, el documento se arma igual que antes", () => {
    const html = buildPollResultsHtml(datos({ tipo: "mixed", opciones: [], preguntas: [] }));
    expect(html).not.toContain("Faltan por responder");
  });

  it("el modo SIN NOMBRES borra los nombres y conserva los conteos", () => {
    // Cuántos faltan no identifica a nadie, y es el dato que hace honesto al papel.
    const html = buildPollResultsHtml({ ...anonimizarDatos(conPendientes()), conNombres: false });
    expect(html).not.toContain("Pedro Ruiz");
    expect(html).not.toContain("1002003004");
    expect(html).toContain("9 de 20 respondieron");
  });
});

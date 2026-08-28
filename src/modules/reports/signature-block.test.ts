import { describe, expect, it } from "vitest";
import { signatureTableHtml } from "./signature-block";
import { renderTemplate } from "./template-engine";

const CONTEXTO = {
  docente: { nombre: "Julián Castaño" },
  fecha_emision: "24 ago 2026",
  estudiantes: [
    { nombre: "Ana María Gómez", codigo: "202112345", documento: "1144194156" },
    { nombre: "Julián Restrepo", codigo: "202154321", documento: "1098765432" },
    { nombre: "Camila Ospina", codigo: "202199999", documento: "1012345678" },
  ],
};

/** Texto visible, para afirmar sobre lo que se IMPRIME y no sobre el markup. */
const plano = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

describe("signatureTableHtml", () => {
  it("genera una fila por estudiante matriculado, no un número fijo", () => {
    // El formato institucional traía 22 filas vacías numeradas a mano: con 31
    // matriculados, nueve firmaban al margen; con 12, sobraban diez renglones.
    const salida = renderTemplate(signatureTableHtml(), CONTEXTO);
    const t = plano(salida);
    expect(t).toContain("1 Ana María Gómez 202112345");
    expect(t).toContain("2 Julián Restrepo 202154321");
    expect(t).toContain("3 Camila Ospina 202199999");
    expect(salida.match(/202\d{6}/g)).toHaveLength(3);
  });

  it("con un curso vacío no deja filas fantasma", () => {
    const salida = renderTemplate(signatureTableHtml(), { ...CONTEXTO, estudiantes: [] });
    expect(salida).not.toMatch(/202\d{6}/);
    expect(salida).toContain("Estudiante"); // la cabecera sí queda
  });

  it("numera desde 1, no desde 0", () => {
    const t = plano(renderTemplate(signatureTableHtml(), CONTEXTO));
    expect(t).toContain("1 Ana");
    expect(t).not.toContain("0 Ana");
  });

  it("no deja variables sin resolver", () => {
    const salida = renderTemplate(signatureTableHtml(), CONTEXTO);
    expect(salida).not.toContain("{{");
  });

  it("la celda de firma tiene alto propio: si no, no hay dónde firmar", () => {
    expect(signatureTableHtml()).toContain("height:30px");
  });

  it("el pie del docente sale con su nombre y la fecha", () => {
    const t = plano(renderTemplate(signatureTableHtml(), CONTEXTO));
    expect(t).toContain("Docente: Julián Castaño");
    expect(t).toContain("Fecha: 24 ago 2026");
  });

  it("se puede apagar el pie del docente", () => {
    const salida = signatureTableHtml({ incluirDocente: false });
    expect(salida).not.toContain("docente.nombre");
  });

  it("la columna de documento es opcional y no está por defecto", () => {
    expect(signatureTableHtml()).not.toContain("{{documento}}");
    expect(signatureTableHtml({ incluirDocumento: true })).toContain("{{documento}}");
  });

  it("los anchos de columna suman 100%", () => {
    for (const op of [
      {},
      { incluirCodigo: false },
      { incluirDocumento: true },
      { incluirCodigo: false, incluirDocumento: true },
    ]) {
      const html = signatureTableHtml(op);
      // solo la PRIMERA tabla (la de firmas); la del docente usa 50/50
      const primera = html.slice(0, html.indexOf("{{#each"));
      // solo los anchos de CELDA: el <table> declara su propio width:100% y
      // contarlo daba 200 (el fallo original de este test, no del código).
      const anchos = [...primera.matchAll(/<td style="[^"]*width:(\d+)%/g)].map((m) =>
        Number(m[1]),
      );
      const suma = anchos.reduce((a, b) => a + b, 0);
      expect(suma, `anchos ${JSON.stringify(anchos)} con ${JSON.stringify(op)}`).toBe(100);
    }
  });

  it("un título vacío no imprime un encabezado en blanco", () => {
    expect(signatureTableHtml({ titulo: "" })).not.toContain("<strong></strong>");
  });
});

describe("filas de cierre: total y vocero", () => {
  it("ninguna de las dos aparece por defecto", () => {
    const html = signatureTableHtml();
    expect(html).not.toContain("{{total_estudiantes}}");
    expect(html).not.toContain("vocero");
    expect(html).not.toContain("Teléfono");
  });

  it("el total usa la variable del contexto, no un número escrito", () => {
    const html = signatureTableHtml({ incluirTotal: true });
    expect(html).toContain("{{total_estudiantes}}");
    expect(html).toContain("Total de estudiantes");
  });

  it("el vocero queda EN BLANCO (se elige en la reunión, no está en la base)", () => {
    const html = signatureTableHtml({ incluirVocero: true });
    expect(html).toContain("Nombre del vocero");
    expect(html).toContain("Teléfono");
    // Sin variable: si se resolviera desde datos, imprimiría a alguien que nadie
    // eligió. Se corta en el cierre de la tabla del LISTADO: más allá está la
    // tabla del docente, que sí lleva {{docente.nombre}} y {{fecha_emision}}.
    const desde = html.indexOf("Nombre del vocero");
    const trozo = html.slice(desde, html.indexOf("</table>", desde));
    expect(trozo).not.toMatch(/\{\{/);
  });

  it("van DENTRO de la tabla del listado, después del cierre del each", () => {
    // Si salieran fuera de la tabla, al imprimir se vería una línea doble entre
    // el listado y las filas de cierre; y un <tr> fuera de <table> lo descarta
    // el parser del navegador.
    const html = signatureTableHtml({ incluirTotal: true, incluirVocero: true });
    const finEach = html.indexOf("{{/each}}");
    const cierreTabla = html.indexOf("</table>", finEach);
    const total = html.indexOf("{{total_estudiantes}}");
    const voc = html.indexOf("Nombre del vocero");
    expect(total).toBeGreaterThan(finEach);
    expect(voc).toBeGreaterThan(finEach);
    expect(total).toBeLessThan(cierreTabla);
    expect(voc).toBeLessThan(cierreTabla);
  });

  it("la tabla sigue balanceada con todas las opciones encendidas", () => {
    const html = signatureTableHtml({
      incluirCodigo: true,
      incluirDocumento: true,
      incluirDocente: true,
      incluirTotal: true,
      incluirVocero: true,
    });
    // Un <tr> fuera de <table> lo tira el parser: se cuenta la profundidad.
    let prof = 0;
    let huerfanas = 0;
    for (const m of html.matchAll(/<\/?(table|tr)\b/gi)) {
      const tag = m[0].toLowerCase();
      if (tag === "<table") prof++;
      else if (tag === "</table") prof--;
      else if (tag === "<tr" && prof <= 0) huerfanas++;
    }
    expect(prof, "tablas sin cerrar").toBe(0);
    expect(huerfanas, "<tr> fuera de <table>").toBe(0);
  });

  it("el colspan de las filas de cierre cubre exactamente el ancho de la tabla", () => {
    // Un colspan corto deja una celda fantasma al final de la fila; uno largo
    // ensancha la tabla y la desborda al imprimir. Se compara contra el número
    // real de columnas de la cabecera.
    for (const op of [
      { incluirCodigo: true, incluirDocumento: false },
      { incluirCodigo: false, incluirDocumento: false },
      { incluirCodigo: true, incluirDocumento: true },
    ]) {
      const html = signatureTableHtml({ ...op, incluirTotal: true, incluirVocero: true });
      const cabecera = html.slice(html.indexOf("<tr>"), html.indexOf("{{#each"));
      const nCols = [...cabecera.matchAll(/<td /g)].length;

      /** Suma de colspans del <tr> que CONTIENE ese texto. */
      const anchoDeFilaCon = (texto: string) => {
        const i = html.indexOf(texto);
        expect(i, `no se encontró "${texto}"`).toBeGreaterThan(-1);
        const inicio = html.lastIndexOf("<tr>", i);
        const fila = html.slice(inicio, html.indexOf("</tr>", i));
        return [...fila.matchAll(/<td([^>]*)>/g)].reduce((acc, m) => {
          const cs = /colspan="(\d+)"/.exec(m[1]);
          return acc + (cs ? Number(cs[1]) : 1);
        }, 0);
      };
      expect(anchoDeFilaCon("Total de estudiantes"), `total con ${JSON.stringify(op)}`).toBe(nCols);
      expect(anchoDeFilaCon("Nombre del vocero"), `vocero con ${JSON.stringify(op)}`).toBe(nCols);
      expect(anchoDeFilaCon("Teléfono"), `teléfono con ${JSON.stringify(op)}`).toBe(nCols);
    }
  });

  it("la etiqueta del vocero abarca al menos dos columnas", () => {
    // El bug que evita: con colspan=1 la celda hereda el ancho de la columna N°
    // (7%) y "Nombre del vocero" se parte en tres líneas. La suma de la fila
    // seguía dando bien —el hueco compensaba—, así que el test de anchos no lo
    // veía: hay que medir la etiqueta, no solo el total.
    const html = signatureTableHtml({ incluirVocero: true });
    for (const etiqueta of ["Nombre del vocero", "Teléfono"]) {
      const i = html.indexOf(etiqueta);
      const celda = html.lastIndexOf("<td", i);
      const cs = /colspan="(\d+)"/.exec(html.slice(celda, i));
      expect(Number(cs?.[1] ?? 1), `colspan de "${etiqueta}"`).toBeGreaterThanOrEqual(2);
    }
  });

  it("el hueco para escribir nunca queda en colspan=0", () => {
    // `colspan="0"` es HTML inválido y los navegadores lo interpretan distinto.
    // Solo puede pasar si la etiqueta se come todas las columnas.
    for (const op of [
      { incluirCodigo: false, incluirDocumento: false },
      { incluirCodigo: true, incluirDocumento: true },
    ]) {
      const html = signatureTableHtml({ ...op, incluirVocero: true, incluirTotal: true });
      expect(html).not.toContain('colspan="0"');
      expect(html).not.toContain('colspan="-');
    }
  });
});

describe("signatureTableHtml — la ranura firmable", () => {
  it("por defecto la celda de Firma trae la ranura anclada al estudiante", () => {
    // Una tabla de firmas existe para que la firmen: la ranura es lo que permite
    // que el estudiante firme desde su propio renglon.
    const h = signatureTableHtml();
    expect(h).toContain("examlab-firma");
    expect(h).toContain('data-firma-uid="{{user_id}}"');
  });

  it("la ranura va DENTRO del each, para que cada fila apunte a su estudiante", () => {
    const h = signatureTableHtml();
    const each = h.slice(h.indexOf("{{#each estudiantes}}"), h.indexOf("{{/each}}"));
    expect(each).toContain('data-firma-uid="{{user_id}}"');
  });

  it("apagada vuelve al recuadro en blanco de antes", () => {
    const h = signatureTableHtml({ firmaDigital: false });
    expect(h).not.toContain("examlab-firma");
    expect(h).toContain("height:30px;>&nbsp;</td>".replace(">&", '">&'));
  });
});

/**
 * Hoja imprimible de los resultados de una encuesta. PURA: recibe datos ya
 * resueltos y devuelve un string de HTML. No toca el DOM, no consulta la base y
 * no lee el reloj — la fecha entra ya formateada.
 *
 * ── Por qué pura, y por qué la fecha viene de afuera ──────────────────
 * Para poder testear el armado sin navegador ni Supabase, que es donde se cuelan
 * los errores que importan: un porcentaje que no coincide con la pantalla, un
 * nombre que se filtra en la versión anónima, una respuesta con `<` que rompe el
 * documento. Y un `new Date()` acá volvería el test dependiente del día — el
 * proyecto ya tiene la regla de no derivar fechas en el render.
 *
 * ── Quién imprime ─────────────────────────────────────────────────────
 * La impresión la hace `printReportHtml` (`src/modules/reports/report-download.ts`),
 * el mismo iframe oculto que usan los informes. No se agrega un segundo
 * mecanismo de impresión al proyecto.
 *
 * ── El porcentaje NO se recalcula acá ─────────────────────────────────
 * Se reusa `optionFillPercent`, el mismo helper que pinta las barras en
 * pantalla. Si se recalculara, la hoja impresa y la pantalla podrían discrepar
 * —en las encuestas de CUPO el porcentaje mide el llenado del cupo, no la cuota
 * sobre el total— y un docente que imprime para una reunión defendería un número
 * que la plataforma no muestra.
 */
import { luminanceOfHex, normalizeHex } from "@/modules/tenants/tenant-colors";
import { optionFillPercent, type PollTypeForResults } from "./poll-results";

/** Marca de la institución para el encabezado del documento. */
export interface MarcaImpresion {
  /** Nombre de la institución. Vacío ⇒ no se imprime la línea. */
  institucion: string;
  /** URL del logo. `null` ⇒ encabezado sin logo (no se deja un hueco). */
  logoUrl: string | null;
  /** Color de marca en hex. `null` o inválido ⇒ gris neutro. */
  colorPrimario: string | null;
}

export interface OpcionImpresion {
  etiqueta: string;
  conteo: number;
  /** Cupo de la opción (solo `slot`). */
  cupo: number | null;
  /** Nombres de quienes eligieron la opción. Vacío en modo anónimo. */
  votantes: string[];
}

export interface PreguntaImpresion {
  texto: string;
  tipo: "abierta" | "cerrada";
  /** Cerrada que admite varias marcas: los porcentajes pueden pasar de 100. */
  multi: boolean;
  opciones: Array<{ etiqueta: string; conteo: number }>;
  /** Respuestas de texto. `autor` es `null` en modo anónimo. */
  abiertas: Array<{ autor: string | null; texto: string }>;
  /** Cuántas personas respondieron ESTA pregunta. */
  totalRespuestas: number;
}

/**
 * Los rótulos entran ya traducidos en vez de importar `i18n` acá: así el módulo
 * sigue siendo puro y los tests no dependen de que el diccionario esté cargado.
 */
export interface TextosImpresion {
  tituloDoc: string;
  curso: string;
  estado: string;
  abierta: string;
  cerrada: string;
  generado: string;
  /** Singular: "1 respuesta". Sin esto la hoja decía "1 respuestas". */
  respuesta: string;
  respuestas: string;
  sinRespuestas: string;
  cupo: string;
  cupoLleno: string;
  /** Singular: "1 participante". */
  participante: string;
  participantes: string;
  preguntaAbierta: string;
  sinNombresNota: string;
  conNombresNota: string;
  variasMarcasNota: string;
}

export interface DatosImpresion {
  marca: MarcaImpresion;
  titulo: string;
  descripcion: string | null;
  /** `mixed` imprime por pregunta; el resto imprime por opción. */
  tipo: PollTypeForResults | "mixed";
  curso: string | null;
  cerrada: boolean;
  /** Fecha ya formateada por `src/shared/lib/format.ts` (es-CO). */
  generadoEl: string;
  /** Total de respuestas de la encuesta (para la cuota en single/multiple). */
  totalRespuestas: number;
  /** Encuestas por opción. Vacío en `mixed`. */
  opciones: OpcionImpresion[];
  /** Encuestas `mixed`. Vacío en el resto. */
  preguntas: PreguntaImpresion[];
  /** Si el documento incluye nombres. Cambia la nota del pie. */
  conNombres: boolean;
  /** Textos ya traducidos: este módulo NO llama a i18next. */
  textos: TextosImpresion;
}

/** Escapa para insertar en HTML. Sin esto, una respuesta con `<` rompe el documento. */
function esc(v: string | null | undefined): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Color de texto legible sobre el color de marca (mismo criterio que la app). */
function textoSobre(hex: string): string {
  return luminanceOfHex(hex) < 0.5 ? "#ffffff" : "#111827";
}

const GRIS_NEUTRO = "#334155";

/** Concordancia de número. El documento se lee, no se tolera "1 respuestas". */
function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

/** Una barra de porcentaje. `pct` ya viene calculado por `optionFillPercent`. */
function barra(pct: number, color: string): string {
  const ancho = Math.max(0, Math.min(100, pct));
  return (
    '<div class="barra">' +
    `<div class="relleno" style="width:${ancho}%;background:${color}"></div>` +
    "</div>"
  );
}

function bloqueOpciones(d: DatosImpresion, color: string): string {
  if (d.opciones.length === 0) {
    return `<p class="vacio">${esc(d.textos.sinRespuestas)}</p>`;
  }
  const tipoParaFill: PollTypeForResults = d.tipo === "mixed" ? "single" : d.tipo;
  return d.opciones
    .map((o) => {
      const fill = optionFillPercent({
        pollType: tipoParaFill,
        responsesCount: o.conteo,
        maxResponses: o.cupo,
        totalResponses: d.totalRespuestas,
      });
      // En una encuesta de CUPO el "2/2" ya dice el conteo Y el porcentaje, así
      // que repetir "2 respuestas … 100%" era decir el mismo número tres veces
      // en la misma línea. Con cupo se muestra la fracción; sin cupo, el conteo
      // y la cuota.
      const meta: string[] = [];
      if (o.cupo != null) {
        meta.push(`${esc(d.textos.cupo)} ${o.conteo}/${o.cupo}`);
        if (fill.full) meta.push(esc(d.textos.cupoLleno));
      } else {
        meta.push(esc(plural(o.conteo, d.textos.respuesta, d.textos.respuestas)));
        if (fill.showPct) meta.push(`${fill.pct}%`);
      }
      const nombres =
        o.votantes.length > 0
          ? `<p class="nombres">${o.votantes.map((n) => esc(n)).join(" · ")}</p>`
          : "";
      return (
        '<section class="fila">' +
        `<h2>${esc(o.etiqueta)}</h2>` +
        barra(fill.pct, color) +
        `<p class="meta">${meta.join(" · ")}</p>` +
        nombres +
        "</section>"
      );
    })
    .join("");
}

function bloquePreguntas(d: DatosImpresion, color: string): string {
  if (d.preguntas.length === 0) {
    return `<p class="vacio">${esc(d.textos.sinRespuestas)}</p>`;
  }
  return d.preguntas
    .map((q, i) => {
      const encabezado =
        `<h2><span class="num">${i + 1}.</span> ${esc(q.texto)}</h2>` +
        `<p class="meta">${esc(plural(q.totalRespuestas, d.textos.respuesta, d.textos.respuestas))}` +
        (q.tipo === "cerrada" && q.multi ? ` · ${esc(d.textos.variasMarcasNota)}` : "") +
        (q.tipo === "abierta" ? ` · ${esc(d.textos.preguntaAbierta)}` : "") +
        "</p>";
      if (q.tipo === "abierta") {
        const items =
          q.abiertas.length === 0
            ? `<p class="vacio">${esc(d.textos.sinRespuestas)}</p>`
            : '<ul class="abiertas">' +
              q.abiertas
                .map(
                  (a) =>
                    "<li>" +
                    (a.autor ? `<span class="autor">${esc(a.autor)}</span>` : "") +
                    `<span class="texto">${esc(a.texto)}</span>` +
                    "</li>",
                )
                .join("") +
              "</ul>";
        return `<section class="pregunta">${encabezado}${items}</section>`;
      }
      // El denominador es quien respondió ESTA pregunta, no la encuesta entera:
      // una pregunta que la mitad del curso salteó no debe mostrar porcentajes
      // diluidos contra el total general.
      const opciones = q.opciones
        .map((o) => {
          const fill = optionFillPercent({
            pollType: "single",
            responsesCount: o.conteo,
            maxResponses: null,
            totalResponses: q.totalRespuestas,
          });
          const meta = [esc(plural(o.conteo, d.textos.respuesta, d.textos.respuestas))];
          if (fill.showPct) meta.push(`${fill.pct}%`);
          return (
            '<section class="fila">' +
            `<h3>${esc(o.etiqueta)}</h3>` +
            barra(fill.pct, color) +
            `<p class="meta">${meta.join(" · ")}</p>` +
            "</section>"
          );
        })
        .join("");
      return `<section class="pregunta">${encabezado}${opciones}</section>`;
    })
    .join("");
}

/** Arma el documento completo, listo para `printReportHtml`. */
export function buildPollResultsHtml(d: DatosImpresion): string {
  const color = normalizeHex(d.marca.colorPrimario) ?? GRIS_NEUTRO;
  const sobreColor = textoSobre(color);
  const t = d.textos;

  const logo = d.marca.logoUrl ? `<img class="logo" src="${esc(d.marca.logoUrl)}" alt="">` : "";
  const institucion = d.marca.institucion
    ? `<p class="institucion">${esc(d.marca.institucion)}</p>`
    : "";

  const subLinea = [
    d.curso ? `${esc(t.curso)}: ${esc(d.curso)}` : "",
    `${esc(t.estado)}: ${esc(d.cerrada ? t.cerrada : t.abierta)}`,
    esc(plural(d.totalRespuestas, t.participante, t.participantes)),
  ]
    .filter(Boolean)
    .join(" · ");

  const cuerpo = d.tipo === "mixed" ? bloquePreguntas(d, color) : bloqueOpciones(d, color);

  // `print-color-adjust: exact` es lo que hace que las barras se impriman: sin
  // eso el navegador "ahorra tinta" y salen en blanco, dejando una hoja de
  // rectángulos vacíos.
  //
  // ── Qué se protege de los cortes de página, y por qué así ───────────
  // La regla NO es "que no se parta una pregunta". Se midió con un documento de
  // 14 preguntas (alto real 4886px, mínimo teórico 5 páginas de A4):
  //
  //   · prohibir partir la pregunta  → 7 páginas
  //   · partir, sin dejar el título huérfano → 6 páginas
  //
  // Prohibirlo empuja al pliego siguiente cada pregunta que no entra completa y
  // deja hasta una página de blanco en el medio; en un informe que se reparte en
  // una reunión, esos huecos se leen como un error de armado. Lo que sí es
  // inaceptable es un título de pregunta solo al pie de una hoja, o una barra o
  // una respuesta cortada a la mitad — eso vuelve el dato ilegible. Así que se
  // protege la unidad ATÓMICA (la fila de una opción, una respuesta abierta) y
  // se mantiene el encabezado pegado a su primera opción.
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>${esc(t.tituloDoc)} — ${esc(d.titulo)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
    color: #111827; font-size: 11pt; line-height: 1.45;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .hoja { padding: 18mm 16mm 22mm; max-width: 210mm; margin: 0 auto; }
  header.marca {
    display: flex; align-items: center; gap: 12px;
    border-bottom: 3px solid ${color}; padding-bottom: 10px; margin-bottom: 16px;
  }
  .logo { height: 44px; width: auto; max-width: 150px; object-fit: contain; }
  .marca .textos { min-width: 0; }
  .institucion { margin: 0; font-size: 12pt; font-weight: 600; }
  .doc { margin: 2px 0 0; font-size: 9pt; letter-spacing: .06em;
         text-transform: uppercase; color: #6b7280; }
  h1 { font-size: 16pt; margin: 0 0 4px; }
  .sub { margin: 0 0 4px; font-size: 9.5pt; color: #4b5563; }
  .desc { margin: 6px 0 0; font-size: 10pt; color: #374151; }
  .resumen { margin: 14px 0 18px; padding: 8px 12px; border-radius: 6px;
             background: ${color}; color: ${sobreColor}; font-size: 10pt; }
  .fila { margin: 0 0 11px; break-inside: avoid; page-break-inside: avoid; }
  .pregunta > h2, .pregunta > .meta { break-after: avoid; page-break-after: avoid; }
  .fila h2, .fila h3 { margin: 0 0 4px; font-size: 10.5pt; font-weight: 600; }
  .barra { height: 9px; border-radius: 999px; background: #e5e7eb; overflow: hidden; }
  .relleno { height: 100%; border-radius: 999px; }
  .meta { margin: 3px 0 0; font-size: 8.5pt; color: #6b7280; }
  .nombres { margin: 3px 0 0; font-size: 9pt; color: #374151; }
  .pregunta { margin: 0 0 18px; padding: 0 0 4px; border-bottom: 1px solid #f1f5f9; }
  .pregunta > h2 { margin: 0 0 2px; font-size: 11.5pt; }
  .num { color: ${color}; font-weight: 700; }
  ul.abiertas { margin: 6px 0 0; padding: 0; list-style: none; }
  ul.abiertas li { margin: 0 0 6px; padding: 6px 9px; border-left: 3px solid ${color};
                   background: #f8fafc; border-radius: 0 4px 4px 0; break-inside: avoid; }
  .autor { display: block; font-size: 8.5pt; font-weight: 600; color: #475569; }
  .texto { display: block; font-size: 10pt; white-space: pre-wrap; }
  .vacio { font-size: 10pt; color: #6b7280; font-style: italic; }
  footer.pie { margin-top: 18px; padding-top: 8px; border-top: 1px solid #e5e7eb;
               font-size: 8pt; color: #6b7280; display: flex;
               justify-content: space-between; gap: 12px; }
  @page { size: A4; margin: 12mm; }
  @media print {
    .hoja { padding: 0; max-width: none; }
    header.marca { break-after: avoid; }
    footer.pie { break-before: avoid; }
  }
</style></head>
<body><div class="hoja">
  <header class="marca">${logo}<div class="textos">${institucion}<p class="doc">${esc(t.tituloDoc)}</p></div></header>
  <h1>${esc(d.titulo)}</h1>
  <p class="sub">${subLinea}</p>
  ${d.descripcion ? `<p class="desc">${esc(d.descripcion)}</p>` : ""}
  <div class="resumen">${esc(t.generado)}: ${esc(d.generadoEl)}</div>
  ${cuerpo}
  <footer class="pie"><span>${esc(d.conNombres ? t.conNombresNota : t.sinNombresNota)}</span><span>${esc(d.titulo)}</span></footer>
</div></body></html>`;
}

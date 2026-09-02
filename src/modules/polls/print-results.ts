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
/**
 * La DESCRIPCIÓN se renderiza como markdown; el resto del documento, no.
 *
 * No es una decisión de gusto: en pantalla el alumno ve la descripción por
 * `MarkdownInline` (app.student.polls.tsx) y el resto en texto plano. El PDF
 * imprimía la descripción escapada, así que salía literalmente
 * `**solo yo veo tus respuestas**` con los asteriscos — el papel decía una cosa
 * y la pantalla otra. Renderizar SOLO la descripción cierra esa diferencia sin
 * abrir una nueva.
 *
 * El texto de las preguntas y las respuestas abiertas se quedan escapados a
 * propósito: no se renderizan en pantalla, y en una respuesta de alumno un
 * `2 * 3 * 4` se volvería `2 <em>3</em> 4` — alterar lo que alguien escribió es
 * peor que mostrarle un asterisco.
 */
import { markdownInlineToHtml } from "@/shared/lib/markdown-inline-html";

/** Marca de la institución para el encabezado del documento. */
export interface MarcaImpresion {
  /** Nombre de la institución. Vacío ⇒ no se imprime la línea. */
  institucion: string;
  /** URL del logo. `null` ⇒ encabezado sin logo (no se deja un hueco). */
  logoUrl: string | null;
  /** Color de marca en hex. `null` o inválido ⇒ gris neutro. */
  colorPrimario: string | null;
}

/**
 * Un participante del informe. El CORREO es lo que vuelve al documento
 * accionable: con el nombre solo, quien lee tiene que ir a buscar a cada persona
 * en otra pantalla para escribirle. `email` es nullable porque un perfil puede no
 * tenerlo cargado, y en ese caso se imprime solo el nombre — no un hueco ni un
 * "null".
 */
export interface ParticipanteImpresion {
  nombre: string;
  email?: string | null;
  /**
   * Documento de identidad. Se imprime cuando está porque hay trámites que lo
   * piden por nombre Y documento —el consolidado de recursos tecnológicos que la
   * vicerrectoría pide por curso es exactamente ese caso— y sin él quien recibe la
   * hoja tiene que ir a buscar 20 cédulas a otra pantalla.
   *
   * Nullable: un perfil puede no tenerlo cargado, y ahí se imprime solo el nombre
   * en vez de un hueco o un "null".
   */
  documento?: string | null;
}

/** Quiénes NO respondieron, por curso. Lo que dice si la lista está completa. */
export interface PendientesImpresion {
  curso: string;
  /** Con acceso a la encuesta por este curso. */
  total: number;
  /** Cuántos ya respondieron. */
  respondieron: number;
  /** Quiénes faltan. Vacío en modo anónimo (los conteos se conservan). */
  faltan: ParticipanteImpresion[];
}

export interface OpcionImpresion {
  etiqueta: string;
  conteo: number;
  /** Cupo de la opción (solo `slot`). */
  cupo: number | null;
  /** Nombres de quienes eligieron la opción. Vacío en modo anónimo. */
  votantes: ParticipanteImpresion[];
}

export interface PreguntaImpresion {
  texto: string;
  tipo: "abierta" | "cerrada";
  /** Cerrada que admite varias marcas: los porcentajes pueden pasar de 100. */
  multi: boolean;
  /**
   * `quienes` es quién eligió esa opción. Antes la hoja de una encuesta mixta
   * decía "Celular: 3" sin decir QUIÉNES, así que para responder un requerimiento
   * por persona había que volver a la pantalla y anotar a mano. Vacío en modo
   * anónimo.
   */
  opciones: Array<{ etiqueta: string; conteo: number; quienes?: ParticipanteImpresion[] }>;
  /** Respuestas de texto. `autor` es `null` en modo anónimo. */
  abiertas: Array<{ autor: string | null; email?: string | null; texto: string }>;
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
  /** Título de la sección de quienes no respondieron. */
  faltanTitulo: string;
  /** "N de M respondieron" del encabezado de cada curso. */
  faltanResumen: string;
  /** Cuando un curso respondió completo. */
  faltanNadie: string;
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
  /**
   * Quiénes faltan por responder, por curso. Opcional: sin esto el documento se
   * arma igual que antes.
   *
   * Importa que esté EN LA HOJA y no solo en pantalla: un consolidado que dice
   * "3 estudiantes sin computador" sobre una encuesta que respondió el 46% del
   * curso no es un consolidado, y quien lo recibe no tiene forma de saberlo.
   */
  pendientes?: PendientesImpresion[];
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

/**
 * Lista de participantes con su correo, en flujo continuo.
 *
 * El correo va JUNTO al nombre y no en una columna aparte: una tabla de dos
 * columnas para 23 personas ocupa 23 renglones, y en flujo continuo entran 3 o 4
 * por renglón. Es lo que permite agregar el dato sin que el informe crezca.
 *
 * Sin correo se imprime solo el nombre. Un "—" o un paréntesis vacío por cada
 * perfil sin correo cargado ensucia la lista y no informa nada.
 */
function listaParticipantes(gente: readonly ParticipanteImpresion[]): string {
  if (gente.length === 0) return "";
  const ultimo = gente.length - 1;
  const items = gente
    .map((g, i) => {
      const nombre = `<span class="pn">${esc(g.nombre)}</span>`;
      // El documento primero y el correo después: quien usa la hoja para un
      // trámite busca por documento, y quien la usa para escribirle busca el correo.
      const doc = g.documento ? `<span class="pd">${esc(g.documento)}</span>` : "";
      const mail = g.email ? `<span class="pm">${esc(g.email)}</span>` : "";
      // El separador se PEGA al participante que termina, con espacio duro
      // (&#160;), y el corte de línea queda del otro lado. Así se comporta como
      // una coma: nunca amanece solo al inicio de un renglón. Antes salía de un
      // ::after con content " · " y ese espacio de adelante era justo el punto
      // por donde el navegador partía — en la medición del curso de 23 personas
      // dejaba viñetas huérfanas abriendo renglón.
      const sep = i < ultimo ? `<span class="sep">&#160;·</span>` : "";
      return `<span class="p">${nombre}${doc}${mail}${sep}</span>`;
    })
    .join(" ");
  return `<p class="nombres">${items}</p>`;
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
      return filaOpcion({
        etiqueta: o.etiqueta,
        meta,
        pct: fill.pct,
        color,
        nivel: "h2",
        participantes: o.votantes,
      });
    })
    .join("");
}

/**
 * Una opción con su barra: etiqueta y conteo en la MISMA línea (etiqueta a la
 * izquierda, conteo a la derecha), la barra debajo y los participantes al final.
 *
 * Está compartida entre las encuestas de opciones y las preguntas cerradas de una
 * mixta porque eran dos copias, y al compactar una la otra quedó con los dos
 * renglones por opción — el mismo documento con dos densidades según el tipo de
 * encuesta. Lo que cambia entre las dos es el nivel del título (la mixta ya usa
 * un h2 para la pregunta, así que la opción baja a h3) y que en la mixta no hay
 * votantes por opción: su tipo es `{ etiqueta, conteo }`.
 */
function filaOpcion(a: {
  etiqueta: string;
  meta: string[];
  pct: number;
  color: string;
  nivel: "h2" | "h3";
  participantes?: readonly ParticipanteImpresion[];
}): string {
  return (
    '<section class="fila">' +
    '<div class="cab">' +
    `<${a.nivel}>${esc(a.etiqueta)}</${a.nivel}>` +
    `<span class="meta">${a.meta.join(" · ")}</span>` +
    "</div>" +
    barra(a.pct, a.color) +
    (a.participantes ? listaParticipantes(a.participantes) : "") +
    "</section>"
  );
}

/**
 * Quiénes faltan por responder, por curso.
 *
 * Va DESPUÉS de los resultados y no antes: lo primero que se busca en la hoja es
 * el dato, y esto es la advertencia de cuánto le falta. Pero va en la hoja, no
 * aparte, porque separarlos es cómo un consolidado parcial termina circulando
 * como si fuera completo.
 */
function bloquePendientes(d: DatosImpresion): string {
  const cursos = d.pendientes ?? [];
  if (cursos.length === 0) return "";
  const secciones = cursos
    .map((c) => {
      const resumen = d.textos.faltanResumen
        .replace("{{n}}", String(c.respondieron))
        .replace("{{total}}", String(c.total));
      const cuerpo =
        c.faltan.length === 0 && c.respondieron >= c.total
          ? `<p class="vacio">${esc(d.textos.faltanNadie)}</p>`
          : listaParticipantes(c.faltan);
      return (
        '<section class="fila">' +
        '<div class="cab">' +
        `<h3>${esc(c.curso)}</h3>` +
        `<span class="meta">${esc(resumen)}</span>` +
        "</div>" +
        cuerpo +
        "</section>"
      );
    })
    .join("");
  return `<section class="pregunta pendientes"><h2>${esc(d.textos.faltanTitulo)}</h2>${secciones}</section>`;
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
                    // Autor y correo en el MISMO renglón: eran dos, y con el
                    // correo aparte habrían sido tres por respuesta.
                    (a.autor
                      ? `<span class="autor">${esc(a.autor)}` +
                        (a.email ? `<span class="pm">${esc(a.email)}</span>` : "") +
                        "</span>"
                      : "") +
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
          return filaOpcion({
            etiqueta: o.etiqueta,
            meta,
            pct: fill.pct,
            color,
            nivel: "h3",
            participantes: o.quienes,
          });
        })
        .join("");
      return `<section class="pregunta">${encabezado}${opciones}</section>`;
    })
    .join("");
}

/**
 * Quita del documento TODO dato de identidad, para el modo "sin nombres".
 *
 * Vive acá y es pura para que se pueda probar: la garantía de anonimato era un
 * comentario en el botón de imprimir, y con el correo pasó a haber DOS canales de
 * identidad por participante donde antes había uno. Los tres lugares con identidad
 * son los votantes de cada opción, y el autor y el correo de cada respuesta
 * abierta. Las opciones de una pregunta del mixto no entran: su tipo es
 * `{ etiqueta, conteo }`, no llevan a nadie.
 *
 * Se BORRA el dato, no se confía en que el armador no lo pinte: hoy el correo del
 * autor solo se imprime si hay autor, pero eso es un detalle del renderizador y
 * el anonimato no puede depender de que nadie lo cambie.
 */
export function anonimizarDatos<
  T extends Partial<Pick<DatosImpresion, "pendientes">> &
    Pick<DatosImpresion, "opciones" | "preguntas">,
>(d: T): T {
  return {
    ...d,
    opciones: d.opciones.map((o) => ({ ...o, votantes: [] })),
    preguntas: d.preguntas.map((q) => ({
      ...q,
      abiertas: q.abiertas.map((a) => ({ ...a, autor: null, email: null })),
      // Quién eligió cada opción es identidad igual que un votante: en una
      // encuesta de bienestar es la parte que NO debe circular.
      opciones: q.opciones.map((o) => ({ ...o, quienes: [] })),
    })),
    // De los pendientes se borran los NOMBRES y se conservan los CONTEOS: cuántos
    // faltan no identifica a nadie, y es justamente el dato que hace honesto al
    // documento.
    ...(d.pendientes
      ? { pendientes: d.pendientes.map((c) => ({ ...c, faltan: [] })) }
      : {}),
  };
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
  /* ── Densidad ─────────────────────────────────────────────────────
     El correo de cada participante hace crecer el documento, así que la maqueta
     se ajustó para que el informe NO ocupe más que antes. Los cuatro números
     salen de MEDIR el alto real del documento con 23 participantes repartidos en
     5 opciones (el volumen de un curso), cada uno aislando una cosa:

       873 px   maqueta anterior, sin correos ....... el punto de partida
       717 px   esta maqueta, sin correos ........... lo que aporta la maqueta
       868 px   esta maqueta, con los 23 correos .... el resultado
       960 px   esta maqueta, correo al tamaño del
                nombre ............................. lo que aporta el .pm chico

     O sea: se agregó el correo y el documento NO quedó más largo que cuando no lo
     tenía. Lo que lo paga es sacar un renglón por opción — la etiqueta y el conteo
     van en la MISMA línea (la clase .cab), no uno debajo del otro — y que el correo
     vaya a 7,5pt. Los ajustes de aire por sí solos no habrían alcanzado.

     De esos 868, unos 16 px los cuesta pegar el separador al participante que
     termina (ver listaParticipantes): al no poder partirse, algún par nombre+correo
     que antes cerraba el renglón ahora baja entero. Se paga a gusto: la alternativa
     era la viñeta huérfana abriendo renglón, que sí se ve como un error.

     Ojo: este bloque vive dentro de un template literal, así que acá NO se pueden
     usar acentos graves — cierran el literal y el archivo deja de compilar. Ya
     rompió el build dos veces mientras se escribía esto. */
  .resumen { margin: 9px 0 11px; padding: 6px 10px; border-radius: 6px;
             background: ${color}; color: ${sobreColor}; font-size: 9.5pt; }
  .fila { margin: 0 0 8px; break-inside: avoid; page-break-inside: avoid; }
  .pregunta > h2, .pregunta > .meta { break-after: avoid; page-break-after: avoid; }
  .cab { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .fila h2, .fila h3 { margin: 0; font-size: 10.5pt; font-weight: 600; }
  .barra { height: 6px; border-radius: 999px; background: #e5e7eb; overflow: hidden;
           margin-top: 3px; }
  .relleno { height: 100%; border-radius: 999px; }
  .meta { font-size: 8.5pt; color: #6b7280; white-space: nowrap; }
  /* Los participantes van en flujo continuo, no uno por renglón: así entran 3 o
     4 por línea y el correo cabe sin duplicar el alto. El nombre y el correo van
     cada uno sin partirse; el separador lo emite listaParticipantes.
     (Ojo: este bloque vive dentro de un template literal, así que acá NO se
     pueden usar acentos graves — cierran el literal y el archivo deja de
     compilar.) */
  .nombres { margin: 3px 0 0; font-size: 9pt; color: #374151; line-height: 1.35; }
  .nombres .sep { color: #9ca3af; }
  .nombres .pn { white-space: nowrap; }
  .pm { font-size: 7.5pt; color: #6b7280; margin-left: 3px; white-space: nowrap; }
  /* El documento de identidad: monoespaciado y tabular para poder cotejar una
     columna de cédulas de un vistazo, que es para lo que se usa la hoja. */
  .pd { font-size: 8pt; color: #374151; margin-left: 4px; white-space: nowrap;
        font-variant-numeric: tabular-nums;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .pendientes { border-top: 2px solid #e5e7eb; margin-top: 18px; padding-top: 10px; }
  .pregunta { margin: 0 0 12px; padding: 0 0 3px; border-bottom: 1px solid #f1f5f9; }
  .pregunta > h2 { margin: 0 0 2px; font-size: 11.5pt; }
  .num { color: ${color}; font-weight: 700; }
  ul.abiertas { margin: 4px 0 0; padding: 0; list-style: none; }
  ul.abiertas li { margin: 0 0 4px; padding: 4px 8px; border-left: 3px solid ${color};
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
  ${d.descripcion ? `<p class="desc">${markdownInlineToHtml(d.descripcion)}</p>` : ""}
  <div class="resumen">${esc(t.generado)}: ${esc(d.generadoEl)}</div>
  ${cuerpo}
  ${bloquePendientes(d)}
  <footer class="pie"><span>${esc(d.conNombres ? t.conNombresNota : t.sinNombresNota)}</span><span>${esc(d.titulo)}</span></footer>
</div></body></html>`;
}

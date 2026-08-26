/**
 * Bloque de FIRMAS para una plantilla de informe. PURO: devuelve HTML.
 *
 * ── Qué resuelve ──────────────────────────────────────────────────────
 * Un acta o un acuerdo se imprime para firmarse. Hasta ahora el docente que
 * quería una lista de firmas tenía que dibujar la tabla a mano en el editor y
 * dejar N filas vacías "a ojo": si el curso tenía 31 matriculados y la tabla
 * traía 22 renglones, nueve personas firmaban al margen. El formato
 * institucional del Acuerdo Pedagógico venía exactamente así — 22 filas vacías
 * numeradas a mano.
 *
 * Este bloque usa `{{#each estudiantes}}`, que el motor de plantillas ya
 * soporta y el contexto de scope `curso` ya provee: la tabla sale con una fila
 * por matriculado, numerada, con nombre y código, y la celda de Firma en blanco
 * para firmar sobre el papel.
 *
 * ── Por qué vive acá y no inline en el editor ─────────────────────────
 * Lo usan dos lugares: la caja "Firmas" del editor de plantillas y la
 * plantilla global del Acuerdo Pedagógico (sembrada por migración). Tenerlo en
 * un módulo evita que el botón inserte una tabla y la plantilla sembrada tenga
 * otra, que es como empiezan las divergencias que nadie nota hasta que dos
 * informes de la misma institución se ven distintos.
 *
 * Esa divergencia ya existía y por eso hay más opciones que antes: la plantilla
 * sembrada trae a mano el total de asistentes y las filas de vocero y teléfono
 * (el formato institucional DO-F-021 las pide), y el botón insertaba una tabla
 * sin nada de eso. Quien quería el formato completo tenía que dibujar esas tres
 * filas otra vez.
 */

/** Estilo de celda compartido, para que la tabla se vea como las del formato. */
const CELDA = "padding:4px 6px;border:1px solid #444;";
const CABECERA = `${CELDA}background-color:#d9d9d9;`;
const FUENTE = 'style="font-size:9pt"';

export interface OpcionesFirmas {
  /** Título encima de la tabla. Vacío ⇒ no se imprime encabezado. */
  titulo?: string;
  /** Columna con el código del estudiante. */
  incluirCodigo?: boolean;
  /** Columna con el documento de identidad. */
  incluirDocumento?: boolean;
  /** Fila final para el docente, con su nombre y la fecha de emisión. */
  incluirDocente?: boolean;
  /**
   * Fila con el total de asistentes, resuelta por `{{total_estudiantes}}`.
   *
   * Es el conteo de MATRICULADOS, no de quienes efectivamente asistieron: el
   * contexto no sabe quién estaba en el salón. Se llama "asistentes" porque así
   * lo pide el formato; el docente lo corrige a mano si difiere.
   */
  incluirTotal?: boolean;
  /** Filas de vocero y teléfono, en blanco para llenar a mano. */
  incluirVocero?: boolean;
}

/**
 * Tabla de firmas de los estudiantes del curso.
 *
 * El alto fijo de la celda de Firma (30px) es deliberado: sin él, la fila se
 * colapsa a la altura del texto y no queda espacio material donde firmar.
 */
export function signatureTableHtml(op: OpcionesFirmas = {}): string {
  const {
    titulo = "Listado de estudiantes",
    incluirCodigo = true,
    incluirDocumento = false,
    incluirDocente = true,
    incluirTotal = false,
    incluirVocero = false,
  } = op;

  // Las columnas de dato tienen ancho FIJO y "Estudiante" absorbe el resto, de
  // modo que la suma siempre da 100 sin importar qué columnas estén activas.
  // Repartir proporcionalmente daba 105 con la columna de documento encendida
  // (lo detectó el test), y una tabla que suma más de 100 se desborda al
  // imprimir. Estudiante es la flexible a propósito: los nombres varían y el
  // resto son campos de largo conocido.
  const ANCHO_NUMERO = 7;
  const ANCHO_CODIGO = 18;
  const ANCHO_DOCUMENTO = 18;
  const ANCHO_FIRMA = 25;
  const anchoEstudiante =
    100 -
    ANCHO_NUMERO -
    ANCHO_FIRMA -
    (incluirCodigo ? ANCHO_CODIGO : 0) -
    (incluirDocumento ? ANCHO_DOCUMENTO : 0);

  const columnas: Array<{ th: string; td: string; ancho: number }> = [
    { th: "N°.", td: "{{@number}}", ancho: ANCHO_NUMERO },
    { th: "Estudiante", td: "{{nombre}}", ancho: anchoEstudiante },
  ];
  if (incluirCodigo) columnas.push({ th: "Código", td: "{{codigo}}", ancho: ANCHO_CODIGO });
  if (incluirDocumento)
    columnas.push({ th: "Documento", td: "{{documento}}", ancho: ANCHO_DOCUMENTO });
  const anchoFirma = ANCHO_FIRMA;

  const cabecera =
    columnas
      .map(
        (c) =>
          `<td style="${CABECERA}width:${c.ancho}%;"><p style="text-align:center">` +
          `<span ${FUENTE}><strong>${c.th}</strong></span></p></td>`,
      )
      .join("") +
    `<td style="${CABECERA}width:${anchoFirma}%;"><p style="text-align:center">` +
    `<span ${FUENTE}><strong>Firma</strong></span></p></td>`;

  const fila =
    columnas.map((c) => `<td style="${CELDA}"><span ${FUENTE}>${c.td}</span></td>`).join("") +
    `<td style="${CELDA}height:30px;">&nbsp;</td>`;

  const encabezado = titulo
    ? `<p style="text-align:center"><span ${FUENTE}><strong>${titulo}</strong></span></p>`
    : "";

  // Total y vocero van DENTRO de la misma tabla, después del `{{/each}}`: son
  // filas de cierre del listado, no una tabla aparte. Sacarlas a otra tabla
  // rompería la continuidad de bordes al imprimir (se vería una línea doble).
  const nCols = columnas.length + 1;
  const celdaEtiqueta = (texto: string, ancho: number) =>
    `<td colspan="${ancho}" style="${CELDA}"><span ${FUENTE}>${texto}</span></td>`;

  const total = incluirTotal
    ? "<tr>" +
      celdaEtiqueta("Total de estudiantes", Math.max(1, nCols - 1)) +
      `<td style="${CELDA}"><p style="text-align:center">` +
      `<span ${FUENTE}>{{total_estudiantes}}</span></p></td>` +
      "</tr>"
    : "";

  // En blanco a propósito: el vocero se elige en la reunión, no está en la base.
  //
  // La etiqueta abarca DOS columnas (N° + Estudiante) y no una: con una sola
  // hereda el ancho de la columna N° —7%— y "Nombre del vocero" se parte en tres
  // líneas. Es el mismo colspan que usa el formato institucional sembrado. Con
  // `Math.min` se cubre el caso de una tabla de pocas columnas, donde 2 dejaría
  // la fila sin espacio para escribir.
  const anchoEtiqueta = Math.min(2, Math.max(1, nCols - 1));
  const filaEnBlanco = (etiqueta: string) =>
    "<tr>" +
    celdaEtiqueta(etiqueta, anchoEtiqueta) +
    `<td colspan="${nCols - anchoEtiqueta}" style="${CELDA}height:24px;">&nbsp;</td>` +
    "</tr>";
  const vocero = incluirVocero
    ? filaEnBlanco("Nombre del vocero") + filaEnBlanco("Teléfono")
    : "";

  const docente = incluirDocente
    ? '<table style="border-collapse:collapse;width:100%;margin-top:18px;table-layout:fixed;">' +
      "<tr>" +
      `<td style="${CELDA}width:50%;height:52px;vertical-align:bottom;">` +
      `<span ${FUENTE}>Docente: {{docente.nombre}}</span></td>` +
      `<td style="${CELDA}width:50%;height:52px;vertical-align:bottom;">` +
      `<span ${FUENTE}>Fecha: {{fecha_emision}}</span></td>` +
      "</tr></table>"
    : "";

  return (
    encabezado +
    '<table style="border-collapse:collapse;width:100%;table-layout:fixed;">' +
    `<tr>${cabecera}</tr>` +
    "{{#each estudiantes}}" +
    `<tr>${fila}</tr>` +
    "{{/each}}" +
    total +
    vocero +
    "</table>" +
    docente
  );
}

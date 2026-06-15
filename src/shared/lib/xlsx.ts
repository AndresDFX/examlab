/**
 * Exportación a Excel (.xlsx) SIN dependencias — pure JS.
 *
 * ¿Por qué a mano? El bundle del front NO tiene una librería de Excel
 * (`xlsx`/SheetJS pesa ~1MB; `fflate` no está en dependencies del front, solo
 * se usa en edges Deno). Un .xlsx es simplemente un ZIP de partes XML (OOXML),
 * así que armamos un ZIP mínimo (método STORE, sin compresión + CRC32) con las
 * 5 partes que Excel/LibreOffice/Google Sheets necesitan. Mismo enfoque que el
 * script `scripts/gen-demo-users-xlsx.py`, portado al navegador.
 *
 * Política de tipos de celda:
 *   - Si el valor es un `number` de JS → celda numérica (`t="n"`), así Excel
 *     suma/ordena de verdad (notas, conteos).
 *   - Cualquier otra cosa → celda de texto (`t="inlineStr"`). NO intentamos
 *     adivinar números desde strings: convertir "001"/cédulas/teléfonos a
 *     número corrompería el dato (ceros a la izquierda, notación científica).
 *     Quien quiera columnas numéricas pasa `number` en las filas.
 *
 * API espejo de `csv.ts` para que migrar un export sea trivial:
 *   toXLSX(rows, columns?, sheetName?) → Uint8Array
 *   downloadXLSX(filename, data)
 */

// ─────────────────────────── CRC32 ───────────────────────────
// Tabla perezosa (se calcula una vez). ZIP exige CRC32 incluso en STORE.
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ─────────────────────────── ZIP (STORE) ───────────────────────────
interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Construye un ZIP mínimo sin compresión (método 0 = STORE). */
function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;

    // Local file header (30 bytes + nombre) + datos.
    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // firma
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // método STORE
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // comp size
    lv.setUint32(22, size, true); // uncomp size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra len
    local.set(nameBytes, 30);
    local.set(e.data, 30 + nameBytes.length);
    locals.push(local);

    // Central directory header (46 bytes + nombre).
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // método
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // offset del local header
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((a, c) => a + c.length, 0);
  const centralOffset = offset;

  // End of central directory record (22 bytes).
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disco
  ev.setUint16(6, 0, true); // disco con central dir
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment len

  // Concatenar todo.
  const total =
    locals.reduce((a, l) => a + l.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}

// ─────────────────────────── OOXML ───────────────────────────
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Letra de columna estilo Excel: 0 → A, 25 → Z, 26 → AA. */
function colLetter(n: number): string {
  let s = "";
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cellXml(ref: string, value: any, styleIndex?: number): string {
  // Atributo de estilo (`s="N"`, índice en cellXfs de styles.xml). Sólo se
  // emite cuando el caller pidió un estilo para esta celda; sin él el output
  // queda byte-idéntico al del writer sin estilos.
  const s = styleIndex != null && styleIndex > 0 ? ` s="${styleIndex}"` : "";
  if (value === null || value === undefined || value === "") {
    return `<c r="${ref}"${s}/>`;
  }
  // Número de JS (y finito) → celda numérica.
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"${s} t="n"><v>${value}</v></c>`;
  }
  // Resto → texto inline (preserva ceros a la izquierda, UUIDs, etc.).
  const esc = xmlEscape(String(value));
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc}</t></is></c>`;
}

/**
 * Opciones EXCLUSIVAS de Excel (no tienen equivalente en CSV).
 *
 * `groupHeader`: agrega UNA fila extra ARRIBA del encabezado de columnas.
 * Mapea NOMBRE DE COLUMNA (la misma key del header) → etiqueta de grupo
 * (ej. el nombre del corte al que pertenece esa columna). Las columnas que
 * no aparezcan en el mapa quedan en blanco en esa fila. Cuando se pasa,
 * el encabezado de columnas baja a la fila 2 y los datos arrancan en la 3;
 * sin él, el comportamiento es idéntico al de antes (header en fila 1).
 *
 * AUTO-MERGE de la fila de grupo: cuando hay `groupHeader`, las celdas
 * CONTIGUAS que comparten la MISMA etiqueta no vacía se combinan en una sola
 * (genera `<mergeCells>`), igual que el "Combinar y centrar" de Excel. Así un
 * corte que abarca varias columnas (sus items + asistencia) muestra UNA sola
 * etiqueta centrada. Reglas:
 *   - Una corrida es un tramo MAXIMO de ≥2 columnas adyacentes con la misma
 *     etiqueta no vacía → se emite un `<mergeCell ref="B1:E1"/>`.
 *   - Etiquetas vacías o corridas de longitud 1 NO se combinan.
 *   - Excel exige que sólo la celda SUPERIOR-IZQUIERDA del rango lleve el valor;
 *     el resto del tramo se escribe como celda vacía (sino Excel pide "reparar").
 *   - El caller NO calcula rangos A1: el merge se infiere de la geometría de
 *     columnas que ya vive acá (donde está `colLetter`). El caller sólo debe
 *     garantizar que las columnas del mismo grupo queden CONTIGUAS.
 *   - Sin corridas combinables → no se emite el bloque `<mergeCells>` (la salida
 *     queda byte-idéntica al comportamiento de #9, groupHeader sin merge).
 */
export interface XlsxOptions {
  groupHeader?: Record<string, string>;
  /**
   * Estilos de celda EXCLUSIVOS de Excel (color de relleno + negrita). El
   * writer arma `xl/styles.xml` a partir de este arreglo y deja disponibles
   * los índices `1..N` (en orden) para usar en {@link cellStyle},
   * {@link headerStyle} y {@link groupHeaderStyle}. El índice 0 está reservado
   * para "sin estilo" (default de Excel) y NUNCA debe pasarse.
   *
   * `styles.xml` SÓLO se incluye en el ZIP cuando este arreglo está presente
   * Y algún estilo termina aplicándose; el camino sin estilos queda
   * byte-idéntico al del writer original (5 partes, celdas sin `s=`).
   */
  styles?: XlsxStyle[];
  /**
   * Devuelve el índice de cellXfs (1-based en {@link styles}) para colorear la
   * celda de datos de la columna `colKey` en la fila `rowIndex` (0-based dentro
   * de `rows`), dado su `value` crudo. `undefined`/`0` = sin estilo.
   */
  cellStyle?: (colKey: string, rowIndex: number, value: unknown) => number | undefined;
  /** Índice de cellXfs a aplicar a TODAS las celdas del encabezado de columnas. */
  headerStyle?: number;
  /** Índice de cellXfs a aplicar a las celdas de la fila de grupo de corte. */
  groupHeaderStyle?: number;
}

/**
 * Descriptor de alto nivel de un estilo de celda. El writer lo traduce a las
 * entradas de `fonts`/`fills`/`cellXfs` de `xl/styles.xml`.
 *
 * `fill`: color de fondo en ARGB de 8 hex (ej. `"FFD9EAD3"` = verde suave). El
 * primer byte es alpha (`FF` opaco). `bold`: texto en negrita.
 */
export interface XlsxStyle {
  fill?: string;
  bold?: boolean;
  /** Alineación horizontal de la celda. Útil para celdas combinadas
   *  (mergeCells): por defecto el texto queda a la izquierda; "center" lo
   *  centra a lo ancho del merge. */
  align?: "left" | "center" | "right";
}

/**
 * Arma `xl/styles.xml` (OOXML) a partir de los {@link XlsxStyle} del caller.
 *
 * Estructura y ORDEN exigidos por el esquema (CT_Stylesheet):
 *   <styleSheet> <fonts> <fills> <borders> <cellStyleXfs> <cellXfs> </styleSheet>
 *
 * Índices reservados por la spec de Excel:
 *   - fonts[0]   = fuente default; fonts[1] = negrita (si algún estilo la usa).
 *   - fills[0]   = none; fills[1] = gray125 (OBLIGATORIO — Excel reserva los 2
 *                  primeros patrones, sino corrompe los colores). Los rellenos
 *                  personalizados arrancan en el índice 2.
 *   - borders[0] = borde vacío (default).
 *   - cellStyleXfs[0] = xf base default.
 *   - cellXfs[0] = xf default (sin estilo); cellXfs[1..N] = un xf por cada
 *                  XlsxStyle del caller, en el MISMO orden → el índice que el
 *                  caller usa en `s="N"` (vía cellStyle/headerStyle/…) es
 *                  `posición-en-styles + 1`.
 */
function buildStylesXml(styles: XlsxStyle[]): string {
  // ── fonts ── index 0 default, index 1 bold (sólo si se usa).
  const usesBold = styles.some((st) => st.bold);
  const fonts: string[] = [
    '<font><sz val="11"/><name val="Calibri"/></font>', // 0 default
  ];
  const BOLD_FONT_IDX = 1;
  if (usesBold) fonts.push('<font><b/><sz val="11"/><name val="Calibri"/></font>'); // 1 bold

  // ── fills ── 0 none, 1 gray125 (reservados), 2.. rellenos sólidos del caller.
  const fills: string[] = [
    '<fill><patternFill patternType="none"/></fill>', // 0
    '<fill><patternFill patternType="gray125"/></fill>', // 1
  ];
  // Cada color único → un fill solid. Dedup para no repetir el mismo color.
  const fillIndexByColor = new Map<string, number>();
  const fillIdxForColor = (rgb: string): number => {
    const key = rgb.toUpperCase();
    const found = fillIndexByColor.get(key);
    if (found != null) return found;
    const idx = fills.length;
    fills.push(`<fill><patternFill patternType="solid"><fgColor rgb="${key}"/></patternFill></fill>`);
    fillIndexByColor.set(key, idx);
    return idx;
  };

  // ── cellXfs ── 0 default, 1..N por estilo del caller.
  const cellXfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  for (const st of styles) {
    const fontId = st.bold ? BOLD_FONT_IDX : 0;
    const fillId = st.fill ? fillIdxForColor(st.fill) : 0;
    const applyFont = st.bold ? ' applyFont="1"' : "";
    const applyFill = st.fill ? ' applyFill="1"' : "";
    const applyAlign = st.align ? ' applyAlignment="1"' : "";
    const attrs = `numFmtId="0" fontId="${fontId}" fillId="${fillId}" borderId="0" xfId="0"${applyFont}${applyFill}${applyAlign}`;
    // Con alineación el <xf> lleva un hijo <alignment/> (no self-closing).
    cellXfs.push(
      st.align
        ? `<xf ${attrs}><alignment horizontal="${st.align}"/></xf>`
        : `<xf ${attrs}/>`,
    );
  }

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
    `<fills count="${fills.length}">${fills.join("")}</fills>` +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${cellXfs.length}">${cellXfs.join("")}</cellXfs>` +
    "</styleSheet>"
  );
}

/**
 * Serializa filas a un .xlsx (Uint8Array).
 * @param rows     filas como objetos { columna: valor }
 * @param columns  orden/whitelist de columnas (default: claves de la 1ª fila)
 * @param sheetName nombre de la hoja (default "Datos")
 * @param options  opciones sólo-Excel (ver {@link XlsxOptions})
 */
export function toXLSX(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: Record<string, any>[],
  columns?: string[],
  sheetName = "Datos",
  options?: XlsxOptions,
): Uint8Array {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);
  const groupHeader = options?.groupHeader;
  // Cuando hay fila de grupo, el encabezado de columnas baja una fila.
  const headerRowNum = groupHeader ? 2 : 1;

  // ── Estilos (opcional) ── Sólo entran en juego si el caller pasó `styles`.
  // `usedStyles` rastrea si ALGÚN estilo terminó aplicándose: si nadie usó
  // estilo, NO incluimos `xl/styles.xml` y el output queda byte-idéntico al
  // del writer sin estilos (5 partes, celdas sin `s=`).
  const styleDefs = options?.styles;
  const cellStyleFn = options?.cellStyle;
  const headerStyle = options?.headerStyle;
  const groupHeaderStyle = options?.groupHeaderStyle;
  let usedStyles = false;
  // Resuelve el índice de estilo a aplicar a una celda. Devuelve undefined si
  // no hay estilos definidos o el índice cae fuera de rango (defensivo).
  const resolveStyle = (idx: number | undefined): number | undefined => {
    if (!styleDefs || idx == null || idx <= 0 || idx > styleDefs.length) return undefined;
    usedStyles = true;
    return idx;
  };

  // Rangos de celdas a combinar en la fila de grupo (ej. "B1:E1"). Se llena
  // sólo cuando hay groupHeader y existen corridas contiguas combinables.
  const mergeRefs: string[] = [];
  // Índices de columna cuya celda de grupo debe quedar VACIA por estar
  // CUBIERTA por un merge (todo el tramo menos su primera columna). Excel
  // exige que sólo la celda superior-izquierda del rango lleve el valor.
  const coveredGroupCols = new Set<number>();

  const sheetRows: string[] = [];
  // Fila 1 (sólo si hay groupHeader): etiquetas de grupo. Columnas sin
  // entrada en el mapa → celda vacía (mismo path que null/undefined/"").
  if (groupHeader) {
    // Detectar corridas de columnas adyacentes con la MISMA etiqueta no vacía.
    // Recorre izquierda→derecha; cada tramo de longitud ≥2 produce un merge y
    // marca como "cubiertas" todas sus columnas menos la primera.
    let i = 0;
    while (i < cols.length) {
      const label = groupHeader[cols[i]] ?? "";
      if (!label) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < cols.length && (groupHeader[cols[j]] ?? "") === label) j++;
      // [i, j) es un tramo maximal con la misma etiqueta no vacía.
      if (j - i >= 2) {
        mergeRefs.push(`${colLetter(i)}1:${colLetter(j - 1)}1`);
        for (let k = i + 1; k < j; k++) coveredGroupCols.add(k);
      }
      i = j;
    }

    // La fila de grupo recibe `groupHeaderStyle` (sólo en celdas con etiqueta;
    // las cubiertas por un merge o vacías quedan sin estilo, igual que Excel).
    const groupStyleIdx = resolveStyle(groupHeaderStyle);
    const groupCells = cols
      .map((c, ci) => {
        const label = coveredGroupCols.has(ci) ? "" : (groupHeader[c] ?? "");
        return cellXml(`${colLetter(ci)}1`, label, label ? groupStyleIdx : undefined);
      })
      .join("");
    sheetRows.push(`<row r="1">${groupCells}</row>`);
  }
  // Encabezados de columna (fila 1 sin groupHeader, fila 2 con él) — texto.
  const headerStyleIdx = resolveStyle(headerStyle);
  const headerCells = cols
    .map((c, ci) => cellXml(`${colLetter(ci)}${headerRowNum}`, c, headerStyleIdx))
    .join("");
  sheetRows.push(`<row r="${headerRowNum}">${headerCells}</row>`);
  // Filas de datos (arrancan justo después del encabezado). Sin groupHeader
  // esto colapsa al `ri + 2` de siempre (byte-idéntico al comportamiento previo).
  rows.forEach((r, ri) => {
    const rowNum = ri + headerRowNum + 1;
    const cells = cols
      .map((c, ci) => {
        const styleIdx = cellStyleFn ? resolveStyle(cellStyleFn(c, ri, r[c])) : undefined;
        return cellXml(`${colLetter(ci)}${rowNum}`, r[c], styleIdx);
      })
      .join("");
    sheetRows.push(`<row r="${rowNum}">${cells}</row>`);
  });

  // `<mergeCells>` es hermano de `<sheetData>` y, por el orden del esquema
  // OOXML (CT_Worksheet), DEBE ir DESPUES de `</sheetData>`. `count` tiene que
  // coincidir con el nº de hijos `<mergeCell>` o Excel pide "reparar". Cuando
  // no hay rangos, no emitimos nada → salida byte-idéntica a la de #9.
  const mergeCellsXml = mergeRefs.length
    ? `<mergeCells count="${mergeRefs.length}">` +
      mergeRefs.map((r) => `<mergeCell ref="${r}"/>`).join("") +
      "</mergeCells>"
    : "";

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<sheetData>" +
    sheetRows.join("") +
    "</sheetData>" +
    mergeCellsXml +
    "</worksheet>";

  // styles.xml SÓLO se materializa si algún estilo se aplicó (ver `usedStyles`).
  // Cuando no, la salida queda byte-idéntica a la del writer sin estilos.
  const includeStyles = usedStyles && !!styleDefs;
  const stylesXml = includeStyles ? buildStylesXml(styleDefs!) : "";

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    (includeStyles
      ? '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      : "") +
    "</Types>";

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    "</Relationships>";

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${xmlEscape(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
    "</workbook>";

  const wbRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    // styles.xml se referencia desde el workbook (rId2) sólo cuando existe.
    (includeStyles
      ? '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      : "") +
    "</Relationships>";

  const enc = new TextEncoder();
  const parts: ZipEntry[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
  ];
  // 6ª parte sólo cuando hay estilos aplicados.
  if (includeStyles) parts.push({ name: "xl/styles.xml", data: enc.encode(stylesXml) });
  return zipStore(parts);
}

/** Dispara la descarga de un .xlsx en el navegador. */
export function downloadXLSX(filename: string, data: Uint8Array) {
  // Copia a un ArrayBuffer "limpio" para el Blob (evita problemas si `data`
  // es una vista sobre un buffer más grande).
  const blob = new Blob([data.slice()], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

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
function cellXml(ref: string, value: any): string {
  if (value === null || value === undefined || value === "") {
    return `<c r="${ref}"/>`;
  }
  // Número de JS (y finito) → celda numérica.
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}" t="n"><v>${value}</v></c>`;
  }
  // Resto → texto inline (preserva ceros a la izquierda, UUIDs, etc.).
  const s = xmlEscape(String(value));
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${s}</t></is></c>`;
}

/**
 * Serializa filas a un .xlsx (Uint8Array).
 * @param rows     filas como objetos { columna: valor }
 * @param columns  orden/whitelist de columnas (default: claves de la 1ª fila)
 * @param sheetName nombre de la hoja (default "Datos")
 */
export function toXLSX(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rows: Record<string, any>[],
  columns?: string[],
  sheetName = "Datos",
): Uint8Array {
  const cols = columns ?? (rows.length ? Object.keys(rows[0]) : []);

  const sheetRows: string[] = [];
  // Fila 1: encabezados (siempre texto).
  const headerCells = cols
    .map((c, ci) => cellXml(`${colLetter(ci)}1`, c))
    .join("");
  sheetRows.push(`<row r="1">${headerCells}</row>`);
  // Filas de datos.
  rows.forEach((r, ri) => {
    const rowNum = ri + 2;
    const cells = cols
      .map((c, ci) => cellXml(`${colLetter(ci)}${rowNum}`, r[c]))
      .join("");
    sheetRows.push(`<row r="${rowNum}">${cells}</row>`);
  });

  const sheet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    "<sheetData>" +
    sheetRows.join("") +
    "</sheetData></worksheet>";

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
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
    "</Relationships>";

  const enc = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
  ]);
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

// CSV helpers — pure JS, no deps
export function toCSV(rows: Record<string, any>[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const escape = (v: any) => {
    if (v === null || v === undefined) return "";
    let s = String(v);
    // CSV injection: una celda que empieza con = + - @ (o tab/CR) se evalúa como
    // FÓRMULA al abrir el CSV en Excel/Sheets → exfiltración (HYPERLINK/WEBSERVICE)
    // o DDE. Datos controlados por el usuario (nombres, feedback, preguntas) se
    // exportan acá. Prefijamos apóstrofo para neutralizar, SIN romper números
    // legítimos (ej. "-5" o "4,5") que algunas columnas de nota exportan.
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+([.,]\d+)?$/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols.join(",");
  const body = rows.map((r) => cols.map((c) => escape(r[c])).join(",")).join("\n");
  return `${header}\n${body}`;
}

export function downloadCSV(filename: string, csv: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Decodifica los bytes de un CSV respetando el charset. `File.text()` y
 * `TextDecoder("utf-8")` asumen UTF-8, pero Excel en Windows (es-CO) guarda
 * "CSV delimitado por comas" en Windows-1252/Latin-1 → tildes y ñ salían como
 * mojibake ("Cárdenas" → "CÃ¡rdenas") en profiles/certificados/actas.
 * Intentamos UTF-8 estricto; si los bytes NO son UTF-8 válido, es un CSV
 * Latin-1 de Excel → windows-1252. Quitamos el BOM inicial si viene.
 */
export function decodeCsvBuffer(buf: ArrayBuffer): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("windows-1252").decode(buf);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM defensivo
  return text;
}

/** Lee un `File` de CSV y lo decodifica con detección de charset (UTF-8 con
 *  fallback a Windows-1252). Ver `decodeCsvBuffer`. */
export async function readCsvFile(file: File): Promise<string> {
  return decodeCsvBuffer(await file.arrayBuffer());
}

export function parseCSV(text: string): Record<string, string>[] {
  // Parser RFC 4180 char-a-char: el estado de comillas cruza saltos de línea,
  // así que un campo entrecomillado con `\n` interno (ej. defense_notes de
  // varias líneas) se preserva en vez de romper la fila. (Antes se hacía
  // split("\n") ANTES de parsear comillas → corrompía el round-trip.)
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const records: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  const endField = () => {
    row.push(cur);
    cur = "";
  };
  const endRecord = () => {
    endField();
    // Saltar líneas en blanco (una sola celda vacía / solo espacios) — mismo
    // comportamiento que el filtro `l.trim()` anterior.
    if (!(row.length === 1 && row[0].trim() === "")) records.push(row);
    row = [];
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"' && src[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRecord();
    else cur += ch;
  }
  // Flush del último registro si el texto no termina en salto de línea.
  if (cur !== "" || row.length > 0) endRecord();
  if (!records.length) return [];
  const headers = records[0].map((h) => h.trim());
  return records.slice(1).map((vals) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = (vals[i] ?? "").trim();
    });
    return obj;
  });
}

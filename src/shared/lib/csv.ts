// CSV helpers — pure JS, no deps
export function toCSV(rows: Record<string, any>[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns ?? Object.keys(rows[0]);
  const escape = (v: any) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
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

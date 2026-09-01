/**
 * Diferencias entre la plantilla BASE de la plataforma y la copia que el docente
 * personalizó para su curso.
 *
 * ── Para qué ──────────────────────────────────────────────────────────
 * Una plantilla personalizada es una COPIA: el día que la plataforma corrige la
 * base —un dato mal puesto, una sección nueva, el logo— la copia del docente se
 * queda atrás y nadie se enteraría. Con esto el docente puede ver QUÉ cambió
 * antes de decidir si trae los cambios (que pisan su edición) o los ignora.
 *
 * ── Por qué un diff propio y no una librería ──────────────────────────
 * El lockfile es `bun.lock` y cualquier dependencia nueva obliga a regenerarlo y
 * a commitear los dos archivos. Para comparar dos cuerpos de plantilla —cientos
 * de líneas, no un repositorio— alcanza la subsecuencia común más larga por
 * líneas, que son treinta líneas de código y cero dependencias.
 *
 * PURO: sin React, sin DOM, sin consultas. Los rótulos los pone la pantalla.
 */

export type TipoLinea = "igual" | "agregada" | "quitada";

export interface LineaDiff {
  tipo: TipoLinea;
  texto: string;
}

/** Tope de líneas por lado: la comparación es cuadrática. */
const MAX_LINEAS = 600;

/**
 * Parte el HTML en líneas comparables.
 *
 * Los editores del proyecto guardan el cuerpo como una sola línea larga de HTML
 * (el editor visual no mete saltos), así que comparar por saltos de línea daría
 * "todo cambió" incluso con una coma de diferencia. Se corta ANTES de cada
 * etiqueta de bloque para que cada párrafo, fila o celda sea su propia línea.
 */
export function lineasComparables(html: string | null | undefined): string[] {
  if (!html) return [];
  return html
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, MAX_LINEAS);
}

/**
 * Diff por líneas entre `base` y `propia`.
 *
 * "agregada" = está en la personalizada y no en la base (lo que escribió el
 * docente). "quitada" = está en la base y no en la personalizada (lo que se
 * perdería, o lo que la plataforma agregó después).
 */
export function diffPlantillas(
  base: string | null | undefined,
  propia: string | null | undefined,
): LineaDiff[] {
  const a = lineasComparables(base);
  const b = lineasComparables(propia);

  // Subsecuencia común más larga, por longitudes.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: LineaDiff[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ tipo: "igual", texto: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ tipo: "quitada", texto: a[i] });
      i++;
    } else {
      out.push({ tipo: "agregada", texto: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ tipo: "quitada", texto: a[i++] });
  while (j < m) out.push({ tipo: "agregada", texto: b[j++] });
  return out;
}

/** Cuántas líneas cambiaron. 0 = las dos plantillas dicen lo mismo. */
export function contarCambios(d: ReadonlyArray<LineaDiff>): {
  agregadas: number;
  quitadas: number;
} {
  return {
    agregadas: d.filter((l) => l.tipo === "agregada").length,
    quitadas: d.filter((l) => l.tipo === "quitada").length,
  };
}

/**
 * Deja SOLO las líneas que cambiaron, con unas pocas de contexto alrededor.
 *
 * Un diff completo de una plantilla son cientos de líneas iguales y las tres que
 * importan quedan enterradas.
 */
export function soloCambios(
  d: ReadonlyArray<LineaDiff>,
  contexto = 1,
): LineaDiff[] {
  const marcadas = new Set<number>();
  d.forEach((l, idx) => {
    if (l.tipo === "igual") return;
    for (let k = idx - contexto; k <= idx + contexto; k++) {
      if (k >= 0 && k < d.length) marcadas.add(k);
    }
  });
  return d.filter((_, idx) => marcadas.has(idx));
}

/**
 * ¿La plantilla base cambió DESPUÉS de que se creó/editó la personalizada?
 *
 * Comparar fechas y no contenidos: es lo único que se puede saber sin traerse las
 * dos plantillas enteras, y el listado ya trae `updated_at` de las dos.
 */
export function baseMasNueva(
  actualizadaBase: string | null | undefined,
  actualizadaPropia: string | null | undefined,
): boolean {
  if (!actualizadaBase || !actualizadaPropia) return false;
  const b = new Date(actualizadaBase).getTime();
  const p = new Date(actualizadaPropia).getTime();
  if (!Number.isFinite(b) || !Number.isFinite(p)) return false;
  return b > p;
}

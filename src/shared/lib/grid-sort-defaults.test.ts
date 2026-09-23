import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Convención: TODA grilla de listado abre ordenada por su FECHA DE CREACIÓN,
 * de lo más reciente a lo más viejo.
 *
 * Se lee el código del disco —igual que `page-types.test.ts` con su migración—
 * porque acá hay DOS modos de falla que no dan ningún error:
 *
 *  1. Un `defaultSort.key` que no existe en el mapa `columns`: `useTableSort`
 *     hace `if (!accessor) return items` y la grilla sale sin ordenar. No hay
 *     excepción, no hay warning, y la lista se ve «casi bien» porque conserva el
 *     orden que trajo la query.
 *  2. Una grilla nueva que copia el patrón viejo y ordena alfabéticamente. Nadie
 *     lo nota hasta que alguien crea algo y no lo encuentra.
 */

const RAICES = ["src/routes", "src/modules"];

/** Rejilla que NO ordena por fecha, con el motivo. Agregar acá es una decisión,
 *  no un atajo: si una grilla nueva no cumple, casi siempre es que le falta el
 *  accessor. */
const SIN_FECHA: Record<string, string> = {
  "src/modules/admin/ErrorsPanel.tsx":
    "Sus filas son GRUPOS de errores (agregados), no registros: no tienen fecha de creación. " +
    "Ordena por frecuencia, que es el criterio de triage, y la única fecha del grupo " +
    "(`lastSeen`) ni siquiera es columna visible.",
  "src/modules/statistics/PendingStudentsPanel.tsx":
    "Es un ranking: la fila es un estudiante con su conteo de pendientes, calculado. " +
    "No hay ninguna fecha que ordenar.",
};

/** Claves que cuentan como «fecha de creación de la fila». */
const CLAVES_DE_CREACION = new Set([
  "created_at",
  "issued_at", // certificados: emitir ES crear
  "deleted_at", // papelera: la fila nace cuando algo se borra
  "generado", // actas: `generated_at`
  "matriculado_at", // mis estudiantes: la fila nace con la matrícula
]);

function archivosConGrillas(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".tsx") && fs.readFileSync(p, "utf8").includes("useTableSort("))
        out.push(p.replace(/\\/g, "/"));
    }
  };
  for (const r of RAICES) walk(r);
  return out.sort();
}

/** Recorta el bloque `{ … }` que empieza en `desde`, contando llaves. */
function bloque(src: string, desde: number): string {
  let nivel = 0;
  for (let i = desde; i < src.length; i++) {
    if (src[i] === "{") nivel++;
    else if (src[i] === "}") {
      nivel--;
      if (nivel === 0) return src.slice(desde, i + 1);
    }
  }
  return "";
}

/** Fuera comentarios y literales de texto ANTES de buscar claves.
 *  Sin esto, un comentario como `// Institución: el nombre…` se lee como una
 *  columna llamada `Institución`, y un texto con `:` adentro también. */
function sinRuido(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*/g, " ")
    .replace(/`(?:[^`\\]|\\.)*`/g, '""')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, '""');
}

/** Claves de PRIMER nivel de un literal `{ a: …, b: … }`. */
function clavesDeNivel1(literal: string): string[] {
  const src = sinRuido(literal);
  const out: string[] = [];
  let nivel = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{" || c === "(" || c === "[") {
      nivel++;
      continue;
    }
    if (c === "}" || c === ")" || c === "]") {
      nivel--;
      continue;
    }
    if (nivel !== 1) continue;
    const m = /^([A-Za-z_][\w]*)\s*:/.exec(src.slice(i));
    if (!m) continue;
    // Debe ser el comienzo de una entrada: lo anterior es `{` o `,`.
    const antes = src.slice(0, i).trimEnd();
    const ultimo = antes[antes.length - 1];
    if (ultimo === "{" || ultimo === ",") out.push(m[1]);
    i += m[0].length - 1;
  }
  return out;
}

interface Grilla {
  archivo: string;
  columnas: string[];
  defaultKey: string | null;
  defaultDir: string | null;
}

function leerGrillas(archivo: string): Grilla[] {
  const src = fs.readFileSync(archivo, "utf8");
  const out: Grilla[] = [];
  for (const m of src.matchAll(/useTableSort[\s\S]{0,80}?\bcolumns:\s*\{/g)) {
    const iCols = src.indexOf("{", m.index! + m[0].length - 1);
    const cols = bloque(src, iCols);
    const columnas = clavesDeNivel1(cols);
    const resto = src.slice(iCols + cols.length, iCols + cols.length + 600);
    const d = resto.match(/defaultSort:\s*\{\s*key:\s*"([^"]+)",\s*dir:\s*"(asc|desc)"/);
    out.push({
      archivo,
      columnas,
      defaultKey: d ? d[1] : null,
      defaultDir: d ? d[2] : null,
    });
  }
  return out;
}

const GRILLAS = archivosConGrillas().flatMap(leerGrillas);

describe("orden por defecto de las grillas", () => {
  it("encuentra todas las grillas del proyecto", () => {
    // Si este número cae en picada es que el parseo se rompió y el resto de los
    // asserts pasarían sobre una lista vacía, que es lo peor que puede pasar.
    expect(GRILLAS.length).toBeGreaterThanOrEqual(20);
  });

  // El piso de arriba NO alcanza como red: perder UNA grilla de veinticinco
  // deja el conteo en 24 y sigue pasando. Y una grilla que el extractor no
  // entiende desaparece de los otros asserts sin decir nada — la misma falla
  // muda que este test existe para cazar, pero una capa más arriba. Pasa si
  // alguien arma las opciones aparte (`const opts = {...}; useTableSort(x, opts)`).
  it("todo archivo con `useTableSort` aporta al menos una grilla analizada", () => {
    const analizados = new Set(GRILLAS.map((g) => g.archivo));
    const mudos = archivosConGrillas().filter((f) => !analizados.has(f));
    expect(mudos).toEqual([]);
  });

  it("el `defaultSort` apunta a una columna que EXISTE", () => {
    const rotas = GRILLAS.filter(
      (g) => g.defaultKey && !g.columnas.includes(g.defaultKey),
    ).map((g) => `${g.archivo} → "${g.defaultKey}" no está en columns: [${g.columnas.join(", ")}]`);
    expect(rotas).toEqual([]);
  });

  it("toda grilla abre por fecha de creación, descendente", () => {
    const fuera = GRILLAS.filter((g) => !SIN_FECHA[g.archivo]).filter(
      (g) => !g.defaultKey || !CLAVES_DE_CREACION.has(g.defaultKey) || g.defaultDir !== "desc",
    ).map((g) => `${g.archivo} → ${g.defaultKey}:${g.defaultDir}`);
    expect(fuera).toEqual([]);
  });

  it("la lista de excepciones no acumula archivos que ya no existen", () => {
    const muertas = Object.keys(SIN_FECHA).filter((f) => !fs.existsSync(f));
    expect(muertas).toEqual([]);
  });
});

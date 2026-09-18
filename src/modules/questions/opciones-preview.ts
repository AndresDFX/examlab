/**
 * Qué opciones tiene una pregunta de selección y CUÁLES son las correctas,
 * para mostrárselas al docente en las listas de autoría.
 *
 * ── Por qué es un módulo y no el `.map()` de cada pantalla ────────────
 * Estaba escrito inline solo en la lista de exámenes, y ahí comparaba
 * `idx === options.correct_index` con `===` estricto y sin mirar
 * `correct_indices`. Consecuencias medibles: una `cerrada` cuyo
 * `correct_index` viajó como texto (`"2"`, que es una forma que SÍ vive en
 * producción — ver `parseOptionIndex`) se pintaba sin ninguna opción marcada,
 * y una `cerrada_multi` se pintaba SIEMPRE sin marcar, porque su clave no es
 * `correct_index` sino `correct_indices`. Las listas de taller y de proyecto
 * ni siquiera pintaban las opciones: el docente veía el enunciado y nada más.
 *
 * ── La invariante que este módulo protege ─────────────────────────────
 * Lo que el docente ve marcado como correcto tiene que ser lo que el
 * calificador cuenta como correcto. Por eso NO reimplementa la lectura de la
 * clave: importa `parseOptionIndex` / `parseOptionIndices` de
 * `deterministic-scoring.ts`, que es el módulo que puntúa de verdad. Si esa
 * lectura cambia, la vista cambia con ella y no queda una segunda
 * interpretación divergente.
 *
 * ── `sinClave` no es un detalle cosmético ─────────────────────────────
 * Una pregunta de selección sin respuesta correcta utilizable puntúa 0
 * SIEMPRE, sin error y sin constraint que lo impida: el problema aparece
 * recién cuando el estudiante ya entregó. La lista de autoría es el único
 * momento en que el docente puede arreglarlo barato, así que se reporta acá.
 */
import { parseOptionIndex, parseOptionIndices } from "@/modules/grading/deterministic-scoring";

export interface OpcionPreview {
  /** «A», «B», … y el número a secas si alguien pasa de 26 opciones. */
  letra: string;
  texto: string;
  correcta: boolean;
}

export interface PreviewOpciones {
  opciones: OpcionPreview[];
  /** `cerrada_multi`: se marcan varias. */
  multiple: boolean;
  /** No hay ninguna respuesta correcta utilizable: la pregunta valdría 0 siempre. */
  sinClave: boolean;
  minSelecciones: number | null;
  maxSelecciones: number | null;
}

const TIPOS_CON_OPCIONES: readonly string[] = ["cerrada", "cerrada_multi"];

export function tieneOpciones(type: string): boolean {
  return TIPOS_CON_OPCIONES.includes(type);
}

function letraDe(i: number): string {
  return i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
}

function numeroOpcional(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `null` cuando no hay nada que previsualizar: el tipo no es de selección, o
 * no trae opciones. Devolver `null` y no una lista vacía deja que la pantalla
 * decida entre «no aplica» (no pinta nada) y «aplica pero está vacío», que en
 * una pregunta de selección es un error de autoría distinto.
 */
export function previsualizarOpciones(type: string, options: unknown): PreviewOpciones | null {
  if (!tieneOpciones(type)) return null;
  const o = (options ?? null) as Record<string, unknown> | null;
  const crudas = Array.isArray(o?.choices) ? (o!.choices as unknown[]) : null;
  if (!crudas || crudas.length === 0) return null;

  const multiple = type === "cerrada_multi";
  // La clave se lee EXACTAMENTE por tipo, igual que quien puntúa: `cerrada` mira
  // SOLO `correct_index` y `cerrada_multi` SOLO `correct_indices`, en los dos
  // lados (`deterministic-scoring.ts` del cliente y su espejo del edge).
  //
  // Hubo acá un fallback que, si la fila traía la clave del OTRO tipo, la usaba
  // igual «para no dejar la pregunta sin marcar». Estaba mal y de la peor forma:
  // pintaba una opción en verde que el calificador puntúa 0 —quien la eligiera
  // sacaría cero igual— y de paso apagaba el aviso de `sinClave`, que es justo
  // lo que esa fila necesita que se vea. Una fila así está rota; el trabajo de
  // esta vista es delatarla, no disimularla.
  const indices = new Set<number>();
  if (multiple) {
    for (const n of parseOptionIndices(o?.correct_indices)) indices.add(n);
  } else {
    const uno = parseOptionIndex(o?.correct_index);
    if (uno !== null) indices.add(uno);
  }

  const opciones = crudas.map((c, i) => ({
    letra: letraDe(i),
    texto: typeof c === "string" ? c : String(c ?? ""),
    correcta: indices.has(i),
  }));

  // Un índice fuera de rango no marca nada, así que la pregunta puntúa 0 igual
  // que si no hubiera clave. Se cuenta sobre lo que quedó marcado DE VERDAD.
  const sinClave = opciones.every((op) => !op.correcta);

  return {
    opciones,
    multiple,
    sinClave,
    minSelecciones: multiple ? numeroOpcional(o?.min_selections) : null,
    maxSelecciones: multiple ? numeroOpcional(o?.max_selections) : null,
  };
}

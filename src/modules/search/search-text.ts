/**
 * Normalización, coincidencia y ranking de texto para el buscador global (⌘K).
 *
 * PURO: sin React, sin Supabase, sin `Date.now()`. Vive aparte del componente
 * para poder testearlo sin DOM (y porque el mismo criterio lo usan dos
 * consumidores: el filtro de MÓDULOS en el cliente y el re-filtro de los
 * resultados que vuelven del servidor).
 *
 * ── Por qué existe `ilikePatternFor` ──────────────────────────────────────
 * `ILIKE` en Postgres NO es insensible a acentos: `'Matemáticas' ILIKE
 * '%matematicas%'` es FALSE, y `unaccent` no está instalado en el proyecto.
 * En es-CO la gente escribe sin tildes (y los títulos reales están llenos de
 * ellas: "Programación", "Cálculo", "Diseño", "Análisis"), así que buscar por
 * `ilike` crudo falla justo en los casos más comunes.
 *
 * La salida: en LIKE, `_` significa "un carácter cualquiera". Reemplazando las
 * letras que PUEDEN llevar diacrítico por `_`, el patrón del servidor pasa a
 * ser un SUPERCONJUNTO del literal (`_` también matchea la letra sin tilde),
 * así que una sola consulta cubre ambos casos. La precisión la pone después el
 * cliente con `matchesQuery`, que sí normaliza los acentos de verdad.
 *
 * El precio es sobre-traer filas, y por eso el aflojado se aplica SOLO cuando
 * la consulta tiene al menos `LOOSE_MIN_LENGTH` caracteres: con 2-3 letras el
 * patrón quedaría tan laxo (`%c_s_%`) que el `limit` se llenaría de basura y
 * escondería el acierto real. Con 4+ el patrón sigue siendo selectivo.
 */

/** Marcas diacríticas que deja sueltas `normalize("NFD")`. */
const DIACRITICS = /[\u0300-\u036f]/g;

/**
 * Letras que en español pueden aparecer con diacrítico (á é í ó ú ü ñ ç).
 * Son las que se reemplazan por `_` en el patrón laxo.
 */
const ACCENTABLE = new Set(["a", "e", "i", "o", "u", "n", "c"]);

/** Desde acá se afloja el patrón del servidor. Ver el encabezado. */
export const LOOSE_MIN_LENGTH = 4;

/** Mínimo de caracteres para disparar una búsqueda contra el servidor. */
export const MIN_QUERY_LENGTH = 2;

/**
 * minúsculas + sin acentos + espacios colapsados.
 *
 * "Programación  I" → "programacion i" · "Diseño" → "diseno".
 */
export function normalizeForSearch(input: string | null | undefined): string {
  return (input ?? "")
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Palabras de la consulta, ya normalizadas. Vacío si la consulta es vacía. */
export function queryTokens(query: string | null | undefined): string[] {
  const n = normalizeForSearch(query);
  return n.length === 0 ? [] : n.split(" ").filter(Boolean);
}

/**
 * ¿El texto contiene TODAS las palabras de la consulta?
 *
 * Por palabras y no por substring completo para que "paradigmas prog" encuentre
 * "Paradigmas de Programación" — el usuario recuerda dos palabras, no el título
 * literal. Consulta vacía ⇒ true (no filtra nada).
 */
export function matchesQuery(
  haystack: string | null | undefined,
  query: string | null | undefined,
): boolean {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return true;
  const h = normalizeForSearch(haystack);
  if (h.length === 0) return false;
  return tokens.every((t) => h.includes(t));
}

/**
 * Menor = más relevante. Escala discreta a propósito: un score continuo
 * (tipo fuzzy) es imposible de explicar cuando el usuario pregunta "¿por qué
 * este salió primero?".
 *
 *   0 título exacto · 1 empieza con la consulta · 2 empieza una palabra
 *   3 la contiene en cualquier parte · 4 contiene todas las palabras sueltas
 *   5 no coincide
 */
export function relevanceScore(
  title: string | null | undefined,
  query: string | null | undefined,
): number {
  const h = normalizeForSearch(title);
  const q = normalizeForSearch(query);
  if (q.length === 0) return 3;
  if (h === q) return 0;
  if (h.startsWith(q)) return 1;
  // Inicio de palabra sin regex: evita escapar la consulta del usuario.
  if (h.includes(` ${q}`)) return 2;
  if (h.includes(q)) return 3;
  return matchesQuery(h, q) ? 4 : 5;
}

/**
 * Ordena por relevancia y desempata alfabéticamente en es-CO.
 *
 * No muta la entrada. El desempate alfabético existe para que dos búsquedas
 * iguales devuelvan SIEMPRE el mismo orden: una lista que se reordena sola
 * entre pulsaciones hace que el usuario le pegue Enter a otra cosa.
 */
export function sortByRelevance<T>(
  items: readonly T[],
  query: string | null | undefined,
  getTitle: (item: T) => string,
): T[] {
  return [...items]
    .map((item, i) => ({ item, i, score: relevanceScore(getTitle(item), query) }))
    .sort(
      (a, b) =>
        a.score - b.score ||
        getTitle(a.item).localeCompare(getTitle(b.item), "es-CO", {
          numeric: true,
          sensitivity: "base",
        }) ||
        a.i - b.i,
    )
    .map((w) => w.item);
}

/**
 * Patrón para `.ilike(col, pattern)` de PostgREST.
 *
 * Además de la insensibilidad a acentos (ver encabezado), sanea la entrada:
 * TODO carácter fuera de `[a-z0-9 ]` — incluidos los comodines `%` y `_` y los
 * separadores `,` `(` `)` que romperían un `.or(...)` — se reemplaza por `_`.
 * Así la consulta del usuario nunca se interpreta como sintaxis.
 */
export function ilikePatternFor(query: string | null | undefined): string {
  const n = normalizeForSearch(query);
  const loose = n.length >= LOOSE_MIN_LENGTH;
  let out = "";
  for (const ch of n) {
    const safe = /[a-z0-9 ]/.test(ch);
    out += !safe || (loose && ACCENTABLE.has(ch)) ? "_" : ch;
  }
  return `%${out}%`;
}

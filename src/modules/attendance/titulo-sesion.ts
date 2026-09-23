/**
 * Resumir el título de una sesión para una lista angosta.
 *
 * En la pantalla PÚBLICA de asistencia, un código que cubre tres clases pinta
 * tres títulos completos, y en los cursos reales eso es un muro de texto: hoy
 * hay títulos de **140 caracteres** («Sesión 8 — Sesión doble · Documentación y
 * QA (Javadoc y pruebas) + Refactorización con IA y persistencia de archivos
 * (Clases 8 y 9)»). El estudiante entra a marcar asistencia, no a leer el
 * temario.
 *
 * ── Por qué un helper y no un `truncate` de CSS a secas ────────────────
 * Un corte por ancho parte donde caiga —«Sesión 8 — Sesión doble · Documenta…»—
 * mientras que estos títulos tienen juntas naturales que sí significan algo. Y
 * el tope en caracteres es lo que se puede **probar**: el de CSS depende del
 * ancho real y de la fuente, así que no hay test que lo fije.
 * El `truncate` se deja igual como red de seguridad para un título sin espacios.
 *
 * ── Las reglas, y por qué son genéricas ───────────────────────────────
 * Se miran 152 títulos reales de tres cursos distintos. NO se asume el formato
 * de ninguno: cada regla es inofensiva para un título que no la cumpla.
 *
 *  1. Se saca un paréntesis FINAL («(Clases 8 y 9)», «(Clase 10)»). Un
 *     paréntesis al final es una acotación por definición; el que no lo tenga
 *     no cambia.
 *  2. Se corta en el primer « + », que es como se unen DOS temas en una misma
 *     clase. Queda el primero, que es con el que la clase se recuerda. No se
 *     corta en « · »: en «Sesión doble · Tema» ese punto separa la ETIQUETA del
 *     tema, y cortar ahí deja «Sesión doble», que dice menos que el título.
 *  3. Recién entonces, tope de caracteres en un borde de palabra.
 *
 * El «Sesión N —» del principio se conserva a propósito: es como los
 * estudiantes nombran la clase, y la fecha de al lado no lo reemplaza.
 *
 * Devuelve también el texto completo, porque lo resumido va SIEMPRE con el
 * original a un `title=` de distancia: resumir no puede ser perder.
 */
export interface TituloResumido {
  /** Lo que se pinta. */
  corto: string;
  /** El título tal cual vino, para el `title=` del elemento. */
  completo: string;
  /** `true` si `corto` dice menos que `completo` (hay algo más que mostrar). */
  recortado: boolean;
}

/** Tope por defecto: entra en una línea a 390 px al lado de la columna de fecha. */
export const TOPE_TITULO_SESION = 46;

/** Une dos temas de la misma clase. Solo este: ver la regla 2 del encabezado. */
const UNION_DE_TEMAS = " + ";

/** Paréntesis al final del título, con o sin espacio antes. */
const ACOTACION_FINAL = /\s*\([^()]*\)\s*$/;

export function resumirTituloDeSesion(
  titulo: string | null | undefined,
  max: number = TOPE_TITULO_SESION,
): TituloResumido | null {
  const completo = (titulo ?? "").trim();
  if (!completo) return null;

  let corto = completo.replace(ACOTACION_FINAL, "").trim();

  const union = corto.indexOf(UNION_DE_TEMAS);
  if (union > 0) corto = corto.slice(0, union).trim();

  // Un tope que no sea al menos un puñado de caracteres no resume: destruye.
  const tope = Math.max(1, Math.floor(max));
  if (corto.length > tope) {
    const cortado = corto.slice(0, tope);
    // Borde de palabra, pero solo si queda algo legible: con una primera
    // palabra larguísima, cortar en el espacio dejaría la cadena vacía.
    const espacio = cortado.lastIndexOf(" ");
    corto = (espacio > tope * 0.5 ? cortado.slice(0, espacio) : cortado).trim();
    // La puntuación que queda colgando al final de un corte no aporta nada.
    corto = corto.replace(/[\s·+,;:—-]+$/, "");
    corto += "…";
  }

  return { corto, completo, recortado: corto !== completo };
}

/**
 * «Curso · Grupo», sin repetir el grupo cuando el nombre del curso YA lo trae.
 *
 * En producción los cursos se llaman `Introduccion a la Ingenieria-2026-2-SB141C`
 * y su grupo es `SB141C`, así que la cabecera decía
 * «Introduccion a la Ingenieria-2026-2-SB141C · SB141C». Repetir el dato no
 * agrega información y en un teléfono empuja el bloque a una tercera línea.
 */
export function encabezadoDeCurso(
  nombre: string | null | undefined,
  grupo: string | null | undefined,
): string {
  const n = (nombre ?? "").trim();
  const g = (grupo ?? "").trim();
  if (!g) return n;
  if (!n) return g;
  // Comparación laxa: el nombre puede traerlo pegado con guiones y en otra caja.
  return n.toLowerCase().includes(g.toLowerCase()) ? n : `${n} · ${g}`;
}

/**
 * Tope para cuando VARIOS títulos van seguidos en una misma frase («También
 * quedaste marcado en 2 sesiones más: X, Y»). Más corto que el de la lista
 * porque ahí cada título tiene su propia línea y acá comparten una.
 */
export const TITULO_EN_FRASE = 34;

/**
 * Mezcla DETERMINÍSTICA de preguntas para el examen con `shuffle_enabled`.
 *
 * Bug que arregla: la pantalla de toma hacía
 *   qs.sort(() => Math.random() - 0.5)
 * en CADA carga del componente. Si el alumno recargaba la página a mitad del
 * examen, las preguntas se RE-ORDENABAN → el índice de navegación apuntaba a
 * otra pregunta y la experiencia se rompía. Además ese patrón sort+random NO
 * es una permutación uniforme.
 *
 * Solución: un Fisher-Yates sembrado con un seed estable por (examen, alumno).
 * Misma semilla en cada recarga → MISMO orden (estable). Semilla distinta por
 * alumno → orden distinto entre alumnos (el objetivo anti-copia del shuffle).
 * No requiere persistir nada en la DB.
 *
 * Helper PURO (sin React, sin Math.random, sin Date) → testeable.
 */

/** Hash xfnv1a → entero 32-bit sin signo, para sembrar el PRNG. */
function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  }
  return h >>> 0;
}

/** PRNG mulberry32 — rápido, determinístico, suficiente para barajar. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Devuelve una copia barajada de `items` de forma determinística según `seed`.
 * NO muta el arreglo de entrada. Mismo (items, seed) → mismo resultado siempre.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice();
  const rng = mulberry32(hashSeed(seed));
  // Fisher-Yates: permutación uniforme.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Seed canónico por (examen, alumno) usado por la pantalla de toma. */
export function examShuffleSeed(examId: string, userId: string): string {
  return `${examId}:${userId}`;
}

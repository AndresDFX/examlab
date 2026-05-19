/**
 * Helpers para el nombre único (`display_name`) de `generated_contents`.
 *
 * Reglas:
 *   - Único por docente, case-insensitive ("Semana 5" === "semana 5").
 *   - No vacío (al menos un caracter no-whitespace).
 *   - Cuando el docente intenta crear uno que ya existe, sugerimos un
 *     sufijo "(2)", "(3)", … incrementando hasta encontrar libre.
 *
 * Lógica pura, sin Supabase, para que sea testeable.
 */

/**
 * Normaliza un display_name para comparación: trim + lower-case. Tiene
 * que coincidir EXACTAMENTE con el predicado del UNIQUE INDEX SQL
 * (`lower(display_name)`) para que la UI prediga el resultado del DB.
 */
export function normalizeDisplayName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Verifica si dos display_names son "iguales" según el criterio de
 * unicidad (case-insensitive + trim).
 */
export function displayNamesEqual(a: string, b: string): boolean {
  return normalizeDisplayName(a) === normalizeDisplayName(b);
}

/**
 * Valida un display_name antes de persistir. Devuelve null si está OK o
 * un string con el motivo de rechazo (mostrable al usuario).
 *
 * Reglas:
 *   - No puede ser vacío / solo whitespace.
 *   - Máx 120 caracteres (suficiente para "Curso completo de Python — Universidad XYZ, Cohorte 2026-I").
 */
export function validateDisplayName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "El nombre no puede estar vacío.";
  if (trimmed.length > 120) return "El nombre es demasiado largo (máx 120 caracteres).";
  return null;
}

/**
 * Dado un nombre deseado y la lista de nombres ya existentes para ese
 * docente, devuelve un nombre garantizado único. Si el deseado ya está
 * libre, lo devuelve tal cual (trim aplicado). Si choca, agrega " (2)",
 * " (3)", … hasta encontrar uno libre.
 *
 * Si el nombre deseado YA tiene un sufijo " (N)", lo respetamos como
 * parte del base — no anidamos " (2) (2)".
 *
 * Ejemplos:
 *   suggestUnique("Semana 5", ["Semana 5"])             → "Semana 5 (2)"
 *   suggestUnique("Semana 5", ["Semana 5", "Semana 5 (2)"]) → "Semana 5 (3)"
 *   suggestUnique("Tema A", [])                          → "Tema A"
 *   suggestUnique("Tema A (2)", ["Tema A (2)"])          → "Tema A (3)"
 */
export function suggestUniqueDisplayName(
  desired: string,
  existing: readonly string[],
): string {
  const cleaned = desired.trim();
  if (cleaned.length === 0) return cleaned; // delegamos al validador
  const taken = new Set(existing.map(normalizeDisplayName));
  if (!taken.has(normalizeDisplayName(cleaned))) return cleaned;

  // ¿El deseado ya termina en " (N)"? Si sí, partimos del base y
  // arrancamos desde N+1 — evita "Foo (2) (2)".
  const m = cleaned.match(/^(.*?)\s*\((\d+)\)\s*$/);
  const base = m ? m[1].trim() : cleaned;
  let start = m ? Number(m[2]) + 1 : 2;

  // Tope defensivo: 9999 candidatos. Si el docente tiene >9999 con el
  // mismo nombre algo anda muy mal — devolvemos el último intento para
  // que la DB rechace con su 23505 y la UI lo muestre.
  for (let i = start; i < 10_000; i += 1) {
    const candidate = `${base} (${i})`;
    if (!taken.has(normalizeDisplayName(candidate))) return candidate;
  }
  return `${base} (${start})`;
}

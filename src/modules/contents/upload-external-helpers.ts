/**
 * Helpers PUROS extraídos de `UploadExternalContentDialog.tsx` para
 * testearlos sin montar el dialog ni mockear Supabase Storage.
 *
 * Si cambia el shape de tags o el set de extensiones aceptadas en
 * storage, sincronizar acá y mantener el test verde.
 */

export type ContentMode = "curso_completo" | "material_individual";
export type ContentModality = "teorica" | "practica" | "teorico_practica";
export type ContentTag = "teorico" | "practico" | "examen";

/**
 * Deriva la modalidad desde el set de tags compositivos.
 *
 * - Si el docente marcó `teorico` Y `practico`, la modalidad es mixta.
 * - Solo `practico` → `practica`.
 * - Solo `teorico` → `teorica` (default por seguridad cuando no
 *   matchea ninguno, ej. `["examen"]` o `[]`).
 *
 * El default a "teorica" preserva compat con queries y edges legacy
 * que leen `generated_contents.modality` y esperan un valor no-null.
 */
export function tagsToModality(tags: ContentTag[]): ContentModality {
  const hasT = tags.includes("teorico");
  const hasP = tags.includes("practico");
  if (hasT && hasP) return "teorico_practica";
  if (hasP) return "practica";
  return "teorica";
}

/**
 * Slugifica un nombre de archivo para que sea seguro en storage.
 *
 *  - Quita acentos (NFD + strip combining marks).
 *  - Lowercase.
 *  - Convierte cualquier secuencia no-[a-z0-9._-] a `-`.
 *  - Quita guiones colgantes al inicio/fin.
 *  - Trunca el BASE a 80 chars (la extensión NO cuenta).
 *  - Conserva la extensión original (lowercased).
 *  - Sin nombre base válido → `"archivo"` + ext.
 *
 * Notas:
 *  - El regex Unicode `̀-ͯ` matchea el rango "Combining
 *    Diacritical Marks" — quita los acentos que `normalize("NFD")`
 *    separa del char base.
 *  - Archivos sin extensión (ej. `Makefile`) quedan sin ext.
 *  - Archivos cuyo nombre empieza por `.` (ej. `.env`) NO se tratan
 *    como "extensión sola" porque `lastIndexOf > 0`; quedan como base
 *    `.env` con ext "" — vacío → `archivo` se devuelve. (Edge case;
 *    el dialog ya bloquea por whitelist antes de llegar acá.)
 */
/**
 * Rango válido de "duración por clase" en minutos. Espejo del CHECK
 * constraint de `generated_contents.duration_minutes`
 * (migración 20260509200000: `>= 10 AND <= 480`). El default 60 es la
 * clase universitaria estándar.
 */
export const DURATION_MIN = 10;
export const DURATION_MAX = 480;
export const DURATION_DEFAULT = 60;

/**
 * Clampa una duración (en minutos) al rango válido [10, 480].
 *
 * `null`/`undefined`/`NaN` caen al default 60 — usado al COMMIT (blur o
 * submit). NO usar en cada keystroke: clampar mientras el usuario teclea
 * en un `<input type="number">` controlado corrompe la entrada de
 * valores de varios dígitos (escribir "185" terminaba en 400/480 porque
 * cada dígito intermedio se clampaba y el `value` controlado pisaba el
 * DOM). El patrón correcto es: guardar el string crudo mientras se
 * escribe y clampar SOLO al salir del campo.
 */
export function clampDuration(value: number | null | undefined): number {
  if (value == null || Number.isNaN(value)) return DURATION_DEFAULT;
  return Math.max(DURATION_MIN, Math.min(DURATION_MAX, value));
}

/**
 * Parsea el string crudo de un input de duración a un número clampeado.
 * String vacío / no numérico → default. Usado al hacer blur del campo.
 */
export function parseDurationInput(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed === "") return DURATION_DEFAULT;
  const n = Number(trimmed);
  if (Number.isNaN(n)) return DURATION_DEFAULT;
  return clampDuration(n);
}

export function slugifyFilename(name: string): string {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : "";
  const cleanBase = base
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${cleanBase || "archivo"}${ext.toLowerCase()}`;
}

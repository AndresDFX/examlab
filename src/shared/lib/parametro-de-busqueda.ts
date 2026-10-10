/**
 * Lee un parámetro de la query como TEXTO.
 *
 * TanStack Router parsea la query con JSON.parse: `?code=446320` llega como el
 * NÚMERO 446320, y un `typeof v === "string"` lo descarta en silencio. Pasó con
 * el enlace público de asistencia: abría con el código vacío en todo curso cuyo
 * código no empieza por 0 (`074664` sobrevive solo porque no es JSON válido y
 * llega como texto). Por eso un número o un booleano se devuelven con String().
 */
export function parametroComoTexto(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return String(v);
  return undefined;
}

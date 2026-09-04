/**
 * Límites y validación de la imagen que se manda a leer.
 *
 * ── Por qué se reduce y se re-codifica a JPEG ─────────────────────────────
 * Una captura de una grilla de videollamada a 1920×1080 en PNG pesa ~1,0–1,5 MB en
 * base64; la misma en JPEG con calidad 0,8 pesa ~0,2–0,3 MB. No hay un tope de cuerpo
 * documentado en las edges de este proyecto, y el del gateway no se puede verificar
 * desde acá: conviene quedar holgadamente por debajo en vez de descubrir el techo con
 * un error en medio de una clase.
 *
 * La pérdida de calidad no importa para esto: lo que se lee son nombres en un rótulo,
 * no un documento escaneado.
 */

/** Lado máximo en píxeles tras reducir. Suficiente para leer los nombres. */
export const MAX_LADO_PX = 1600;

/** Tope del data URL, en caracteres. */
export const MAX_DATAURL_CHARS = 1_500_000;

export const TIPOS_IMAGEN_ACEPTADOS = ["image/png", "image/jpeg", "image/webp"] as const;

const EXTENSIONES = /\.(png|jpe?g|webp)$/i;

/** ¿El archivo elegido tiene una extensión de imagen que se sabe manejar? */
export function tipoDeImagenAceptado(nombre: string | null | undefined): boolean {
  return EXTENSIONES.test((nombre ?? "").trim());
}

/**
 * Data URL de imagen ESTRICTO.
 *
 * Estricto a propósito: el string se manda al proveedor de IA, y aceptar
 * `data:image/svg+xml` —que es XML con scripts— o un base64 con caracteres raros es
 * la clase de laxitud que después hay que arreglar. Mismo criterio que la validación
 * del dibujo de firma del módulo de informes.
 */
export function dataUrlDeImagenValida(s: string | null | undefined): boolean {
  const v = (s ?? "").trim();
  if (!v || v.length > MAX_DATAURL_CHARS) return false;
  return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(v);
}

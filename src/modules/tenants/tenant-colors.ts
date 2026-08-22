/**
 * Matemática de color de la marca de una institución — PURA y sin React.
 *
 * Por qué vive acá y no dentro de `TenantThemeProvider`: estas funciones las
 * necesita también la **vista previa** del formulario de institución
 * (`TenantBrandPreview`), para mostrar cómo va a quedar la app ANTES de
 * guardar. Copiarlas hubiera creado una invariante cross-file de las que este
 * proyecto ya tiene demasiadas: la vista previa mostraría un color y el theme
 * real pintaría otro, y nadie se enteraría hasta que un rector reclame que su
 * marca no es la que eligió. Un solo módulo, un solo cálculo.
 *
 * `TenantThemeProvider` las importa de acá; no las redefine.
 */

/** Normaliza `3B82F6` / `#3b82f6` / `  #3B82F6  ` a `#3b82f6`. `null` si no es un hex de 6 dígitos. */
export function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const withHash = v.startsWith("#") ? v : `#${v}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(withHash)) return null;
  return withHash;
}

/**
 * Luminancia sRGB relativa (0..1). Usada para decidir si el texto
 * sobre el color debe ser blanco u oscuro.
 */
export function luminanceOfHex(hex: string): number {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const toLin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const r = toLin((n >> 16) & 255);
  const g = toLin((n >> 8) & 255);
  const b = toLin(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Mezcla un hex con blanco/negro por porcentaje (0..1). Usado para
 * derivar `--primary-glow` (versión más brillante del primario, igual
 * que el default `oklch(0.65 ...)` vs `oklch(0.55 ...)` del theme).
 */
export function tintHex(hex: string, mix: number, toward: "white" | "black"): string {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const target = toward === "white" ? 255 : 0;
  const lerp = (c: number) => Math.round(c + (target - c) * mix);
  const nr = lerp(r),
    ng = lerp(g),
    nb = lerp(b);
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${toHex(nr)}${toHex(ng)}${toHex(nb)}`;
}

/**
 * "Wash" — versión muy suave del color para usar como background del
 * área principal en LIGHT mode. Mezclamos 92% con blanco para que el
 * color asome sutilmente sin competir con el contenido.
 *
 * Para DARK mode usar `darkVariant` — esa función trabaja en HSL y
 * preserva el hue/saturación del color de marca pero baja la
 * lightness, dando un "tinte de marca" sobre un fondo oscuro. Antes
 * usábamos mezcla con negro acá también, pero secundarios claros
 * (blanco, crema) terminaban en gris neutro porque al perder canal
 * de color no quedaba info de marca.
 */
export function washHex(hex: string): string {
  return tintHex(hex, 0.92, "white");
}

/**
 * Convierte un hex a HSL. Devuelve `[hue 0-360, sat 0-100, lit 0-100]`.
 * Algoritmo estándar; el método CSS `color()` no está soportado en
 * todos los browsers que necesitamos. Si el hex es inválido, devuelve
 * `[0, 0, 0]` (negro) — el caller decide qué hacer.
 */
export function hexToHsl(hex: string): [number, number, number] {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h * 360, s * 100, l * 100];
}

/** HSL → hex. Algoritmo estándar; usado por darkVariant. */
export function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const a = sN * Math.min(lN, 1 - lN);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = lN - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/**
 * Genera la variante DARK de un color de marca: preserva hue +
 * saturación pero fija la lightness a un valor muy oscuro (default 8%).
 * Resultado: si la marca es `#F54927` (rojo brillante, h~13°), en dark
 * mode el fondo es `#3a0e05` (rojo MUY oscuro pero con tinte de marca);
 * si la marca es `#3B82F6` (azul, h~217°), el fondo es `#04193e` (azul
 * oscuro). Así dark mode también respeta la marca, no se desactiva.
 *
 * Caso especial achromático (gris/blanco/negro, saturación < 5%): no
 * hay hue que preservar, devolvemos un gris oscuro neutro. Antes esto
 * generaba un "wash" gris confuso para usuarios que pusieron blanco
 * como secundario — ahora cae al default dark sano sin sorpresas.
 */
export function darkVariant(hex: string, lightness: number): string {
  const [h, s] = hexToHsl(hex);
  if (s < 5) {
    // Achromático → gris oscuro neutro. La saturación cero garantiza
    // que h sea irrelevante.
    return hslToHex(0, 0, lightness);
  }
  // Cap de saturación: con saturación 100% al 8% de lightness los
  // colores se ven casi negro sólido sin matiz reconocible. Bajamos
  // a 60-75% para que el matiz se "lea" como rojo/azul/etc.
  const cappedSat = Math.min(s, 70);
  return hslToHex(h, cappedSat, lightness);
}

/**
 * Color de texto legible sobre un fondo: blanco si el fondo es oscuro,
 * casi-negro si es claro. El umbral 0.55 es el mismo que usa el provider
 * para `--sidebar-*-foreground`; si se cambia, se cambia acá y vale para
 * el theme real y para la vista previa a la vez.
 */
export function readableTextOn(hex: string): string {
  return luminanceOfHex(hex) < 0.55 ? "#ffffff" : "#0a0a0a";
}

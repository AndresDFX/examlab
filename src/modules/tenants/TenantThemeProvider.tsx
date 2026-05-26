/**
 * TenantThemeProvider — sobrescribe los tokens de color del theme con
 * los colores del tenant activo, para que TODO el design system los use
 * (botones primary, focus rings, badges, links, etc.).
 *
 * IMPORTANTE: este proyecto usa Tailwind v4 con tokens **OKLCH**
 * (`--primary: oklch(0.55 0.22 265)`). Antes intentamos setear HSL
 * tipo `--primary: 220 50% 30%` — no funcionaba porque el CSS espera
 * `oklch(...)` o un color CSS válido. La solución correcta es setear el
 * color como valor CSS válido directamente (hex, oklch, rgb), que la
 * propiedad `background-color: var(--color-primary)` interpreta sin
 * conversión.
 *
 * Tokens que sobrescribimos:
 *   --primary, --primary-foreground, --primary-glow, --ring
 *   --sidebar-primary, --sidebar-primary-foreground, --sidebar-ring
 *   --secondary, --secondary-foreground, --accent, --accent-foreground
 *   --brand-primary, --brand-secondary (hex puro para opt-in)
 *
 * Foreground (texto sobre el color de fondo) se calcula por luminancia
 * sRGB: blanco si el color es oscuro, negro si es claro. Evita texto
 * blanco ilegible sobre un primary amarillo.
 *
 * Si el tenant NO tiene colores → no sobrescribimos nada y queda el
 * theme default OKLCH azul/violeta.
 */
import { useEffect } from "react";
import { useTenant } from "@/modules/tenants/use-tenant";

function normalizeHex(value: string | null | undefined): string | null {
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
function luminanceOfHex(hex: string): number {
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
function tintHex(hex: string, mix: number, toward: "white" | "black"): string {
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

function setColorVar(root: HTMLElement, name: string, hex: string | null) {
  if (!hex) {
    root.style.removeProperty(name);
    return;
  }
  // Setea el hex DIRECTAMENTE — el theme acepta cualquier valor CSS
  // de color válido (hex, oklch, rgb) porque las propiedades CSS lo
  // usan como `background-color: var(--color-primary)` sin envolver
  // en hsl()/oklch(). Antes intentábamos formato HSL "H S% L%" pero
  // el CSS no lo parsea porque las vars NO están dentro de hsl(...).
  root.style.setProperty(name, hex);
}

function setForegroundVar(root: HTMLElement, name: string, hex: string | null) {
  if (!hex) {
    root.style.removeProperty(name);
    return;
  }
  const lum = luminanceOfHex(hex);
  // Umbral 0.55 — ligeramente sobre el clásico 0.5 para que colores
  // medios (amarillos, verdes claros) tomen texto oscuro.
  const fg = lum < 0.55 ? "#ffffff" : "#0a0a0a";
  root.style.setProperty(name, fg);
}

export function TenantThemeProvider({ children }: { children: React.ReactNode }) {
  const { tenant } = useTenant();

  useEffect(() => {
    const root = document.documentElement;
    const primary = normalizeHex(tenant?.primary_color);
    const secondary = normalizeHex(tenant?.secondary_color);

    // ── Primary y sus derivados ──
    setColorVar(root, "--primary", primary);
    setForegroundVar(root, "--primary-foreground", primary);
    // primary-glow: variante más brillante (mezcla 15% con blanco si
    // el color es oscuro, o 15% con negro si es claro). El theme
    // default tiene un glow distinto al base — replicamos esa semántica.
    if (primary) {
      const isDark = luminanceOfHex(primary) < 0.5;
      root.style.setProperty(
        "--primary-glow",
        tintHex(primary, 0.18, isDark ? "white" : "black"),
      );
    } else {
      root.style.removeProperty("--primary-glow");
    }
    setColorVar(root, "--ring", primary);
    setColorVar(root, "--sidebar-primary", primary);
    setForegroundVar(root, "--sidebar-primary-foreground", primary);
    setColorVar(root, "--sidebar-ring", primary);

    // ── Secondary ──
    setColorVar(root, "--secondary", secondary);
    setForegroundVar(root, "--secondary-foreground", secondary);
    setColorVar(root, "--accent", secondary);
    setForegroundVar(root, "--accent-foreground", secondary);

    // ── Hex directo para usos puntuales (style={{ color: 'var(--brand-primary)' }}) ──
    if (primary) root.style.setProperty("--brand-primary", primary);
    else root.style.removeProperty("--brand-primary");
    if (secondary) root.style.setProperty("--brand-secondary", secondary);
    else root.style.removeProperty("--brand-secondary");
  }, [tenant?.primary_color, tenant?.secondary_color]);

  return <>{children}</>;
}

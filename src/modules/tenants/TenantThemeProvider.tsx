/**
 * TenantThemeProvider — sobrescribe los tokens HSL del shadcn theme con
 * los colores del tenant activo, para que TODO el design system los use
 * (botones primary, focus rings, badges, links, etc.).
 *
 * Cómo funciona:
 *   - shadcn/Tailwind expone `--primary: <H> <S>% <L>%` y todo componente
 *     usa `hsl(var(--primary))` indirectamente via clases (`bg-primary`,
 *     `text-primary`, `border-primary`...). Sobrescribir ese token cambia
 *     la app entera de golpe.
 *   - Convertimos el hex del tenant a HSL y seteamos `--primary`,
 *     `--ring`, `--sidebar-primary` (para que el sidebar también respete
 *     el color institucional) y los homólogos `--secondary` con el
 *     secondary_color.
 *   - Foreground (texto sobre el color) lo decidimos por luminancia: si
 *     el color es oscuro → foreground blanco, si es claro → foreground
 *     negro. Eso evita que un primary amarillo deje texto blanco
 *     ilegible encima de un botón.
 *   - También exponemos `--brand-primary` / `--brand-secondary` en hex
 *     puro por si alguien quiere usar `style={{ color: 'var(--brand-primary)' }}`
 *     directo (sin pasar por HSL).
 *
 * Si el tenant NO tiene colores → no sobrescribimos nada y queda el
 * theme default de shadcn (azul / violeta).
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

/** Convierte #RRGGBB a [H, S%, L%]. Devuelve null si no parsea. */
function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
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
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * Para texto sobre fondo del color: si la luminancia percibida del
 * color es < 0.55 → foreground blanco; sino negro. Usa fórmula sRGB
 * estándar para luminancia relativa.
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

function setHslVar(root: HTMLElement, name: string, hex: string | null) {
  if (!hex) {
    root.style.removeProperty(name);
    return;
  }
  const hsl = hexToHsl(hex);
  if (!hsl) return;
  root.style.setProperty(name, `${hsl.h} ${hsl.s}% ${hsl.l}%`);
}

function setForegroundVar(root: HTMLElement, name: string, hex: string | null) {
  if (!hex) {
    root.style.removeProperty(name);
    return;
  }
  const lum = luminanceOfHex(hex);
  // Umbral 0.55 — ligeramente sobre el clásico 0.5 para que colores
  // medios (amarillos, verdes claros) tomen texto oscuro.
  const fg = lum < 0.55 ? "0 0% 100%" : "0 0% 0%";
  root.style.setProperty(name, fg);
}

export function TenantThemeProvider({ children }: { children: React.ReactNode }) {
  const { tenant } = useTenant();

  useEffect(() => {
    const root = document.documentElement;
    const primary = normalizeHex(tenant?.primary_color);
    const secondary = normalizeHex(tenant?.secondary_color);

    // Tokens HSL del shadcn theme — afectan TODO el design system.
    // Si tenant no tiene color, removeProperty deja que tome el default.
    setHslVar(root, "--primary", primary);
    setForegroundVar(root, "--primary-foreground", primary);
    setHslVar(root, "--ring", primary);
    setHslVar(root, "--sidebar-primary", primary);
    setForegroundVar(root, "--sidebar-primary-foreground", primary);
    setHslVar(root, "--sidebar-ring", primary);

    setHslVar(root, "--secondary", secondary);
    setForegroundVar(root, "--secondary-foreground", secondary);

    // Hex directo para usos puntuales (`var(--brand-primary)`).
    if (primary) root.style.setProperty("--brand-primary", primary);
    else root.style.removeProperty("--brand-primary");
    if (secondary) root.style.setProperty("--brand-secondary", secondary);
    else root.style.removeProperty("--brand-secondary");
  }, [tenant?.primary_color, tenant?.secondary_color]);

  return <>{children}</>;
}

/**
 * TenantThemeProvider — sobrescribe los tokens de color del theme con
 * los colores del tenant activo, para que TODO el design system los use
 * (botones primary, focus rings, badges, links, fondos, sidebar).
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
 *   Identidad:
 *     --primary, --primary-foreground, --primary-glow, --ring
 *     --secondary, --secondary-foreground, --accent, --accent-foreground
 *     --brand-primary, --brand-secondary (hex puro para opt-in)
 *
 *   Sidebar (background = color principal del tenant):
 *     --sidebar, --sidebar-foreground
 *     --sidebar-primary (active item), --sidebar-primary-foreground
 *     --sidebar-accent (hover), --sidebar-accent-foreground
 *     --sidebar-border, --sidebar-ring
 *
 *   Fondos del resto de la app (mezcla suave del color secundario para
 *   no abrumar — el secundario puro como fondo de toda la app es muy
 *   saturado y compite con el contenido):
 *     --background, --foreground
 *     --card, --card-foreground (sutil)
 *     --muted, --muted-foreground
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

/**
 * "Wash" — versión muy suave del color para usar como background del
 * área principal. El secundario puro como `--background` quemaría los
 * ojos del usuario; mezclamos 92% con blanco (light) o 88% con negro
 * (dark) para que el color asome sutilmente sin competir con el
 * contenido. La detección dark/light la hacemos por la clase `dark`
 * en el `<html>` (la app tiene theme toggle).
 */
function washHex(hex: string, isDarkTheme: boolean): string {
  return tintHex(hex, isDarkTheme ? 0.88 : 0.92, isDarkTheme ? "black" : "white");
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
    // Detectamos si la app está en modo dark — el wash debe mezclar con
    // negro (dark) vs blanco (light) para que el fondo del contenido
    // siga siendo casi-blanco/casi-negro y no compita con el contenido.
    const isDarkTheme = root.classList.contains("dark");

    // ── Primary y sus derivados (identidad / acentos) ──
    setColorVar(root, "--primary", primary);
    setForegroundVar(root, "--primary-foreground", primary);
    // primary-glow: variante más brillante (mezcla 18% con blanco si
    // el color es oscuro, o 18% con negro si es claro). El theme
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

    // ── Sidebar: background = color primario del tenant ──
    // El sidebar entero toma el color principal. Los items activos /
    // hover los derivamos por tinte para que sigan siendo visibles
    // sobre el fondo primario (si pusiéramos `--sidebar-primary` =
    // primary también, el item activo se camuflaria con el fondo).
    setColorVar(root, "--sidebar", primary);
    setForegroundVar(root, "--sidebar-foreground", primary);
    if (primary) {
      const isDarkPrimary = luminanceOfHex(primary) < 0.5;
      // Active item: shift de luminosidad para destacar contra el fondo
      // primario. Si el fondo es oscuro, el item activo va más claro;
      // si el fondo es claro, va más oscuro.
      const sidebarActive = tintHex(primary, 0.25, isDarkPrimary ? "white" : "black");
      // Accent (hover): shift más sutil — la diferencia visual contra
      // el fondo es notable pero no grita "click aquí" como el active.
      const sidebarAccent = tintHex(primary, 0.12, isDarkPrimary ? "white" : "black");
      // Border: muy sutil, apenas más oscuro/claro que el fondo.
      const sidebarBorder = tintHex(primary, 0.18, isDarkPrimary ? "white" : "black");
      root.style.setProperty("--sidebar-primary", sidebarActive);
      root.style.setProperty(
        "--sidebar-primary-foreground",
        luminanceOfHex(sidebarActive) < 0.55 ? "#ffffff" : "#0a0a0a",
      );
      root.style.setProperty("--sidebar-accent", sidebarAccent);
      root.style.setProperty(
        "--sidebar-accent-foreground",
        luminanceOfHex(sidebarAccent) < 0.55 ? "#ffffff" : "#0a0a0a",
      );
      root.style.setProperty("--sidebar-border", sidebarBorder);
      root.style.setProperty("--sidebar-ring", primary);
    } else {
      // Sin tenant primario, limpiamos overrides y dejamos el theme default.
      root.style.removeProperty("--sidebar-primary");
      root.style.removeProperty("--sidebar-primary-foreground");
      root.style.removeProperty("--sidebar-accent");
      root.style.removeProperty("--sidebar-accent-foreground");
      root.style.removeProperty("--sidebar-border");
      root.style.removeProperty("--sidebar-ring");
    }

    // ── Secondary (acento, badges, accent buttons) ──
    setColorVar(root, "--secondary", secondary);
    setForegroundVar(root, "--secondary-foreground", secondary);
    setColorVar(root, "--accent", secondary);
    setForegroundVar(root, "--accent-foreground", secondary);

    // ── Background del área principal: wash del secundario ──
    // No usamos el secundario puro — sería demasiado saturado para todo
    // el viewport. Mezclamos ~90% con blanco (light) / negro (dark) para
    // que el tono asome sutil sin volver ilegible el contenido. Cards y
    // muted toman tintes incluso más suaves para tener jerarquía visual.
    if (secondary) {
      const bg = washHex(secondary, isDarkTheme);
      // Card va un poco más cerca del blanco/negro puro para que las
      // cards "floten" sobre el fondo wash. En dark, al revés: card más
      // claro que el fondo (jerarquía invertida estándar de dark themes).
      const card = tintHex(secondary, isDarkTheme ? 0.78 : 0.96, isDarkTheme ? "black" : "white");
      const muted = tintHex(secondary, isDarkTheme ? 0.82 : 0.88, isDarkTheme ? "black" : "white");
      root.style.setProperty("--background", bg);
      root.style.setProperty("--foreground", isDarkTheme ? "#fafafa" : "#0a0a0a");
      root.style.setProperty("--card", card);
      root.style.setProperty("--card-foreground", isDarkTheme ? "#fafafa" : "#0a0a0a");
      root.style.setProperty("--popover", card);
      root.style.setProperty("--popover-foreground", isDarkTheme ? "#fafafa" : "#0a0a0a");
      root.style.setProperty("--muted", muted);
    } else {
      root.style.removeProperty("--background");
      root.style.removeProperty("--foreground");
      root.style.removeProperty("--card");
      root.style.removeProperty("--card-foreground");
      root.style.removeProperty("--popover");
      root.style.removeProperty("--popover-foreground");
      root.style.removeProperty("--muted");
    }

    // ── Hex directo para usos puntuales (style={{ color: 'var(--brand-primary)' }}) ──
    if (primary) root.style.setProperty("--brand-primary", primary);
    else root.style.removeProperty("--brand-primary");
    if (secondary) root.style.setProperty("--brand-secondary", secondary);
    else root.style.removeProperty("--brand-secondary");
  }, [tenant?.primary_color, tenant?.secondary_color]);

  return <>{children}</>;
}

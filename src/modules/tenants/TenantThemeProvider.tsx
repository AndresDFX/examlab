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
import { useEffect, useState } from "react";
import { useTenant, readTenantOverride } from "@/modules/tenants/use-tenant";
import { getActiveRoleSignal, subscribeActiveRole } from "@/modules/tenants/active-role-signal";
import type { AppRole } from "@/hooks/use-auth";

/** Limpia TODAS las CSS vars que el provider haya seteado. Se usa cuando
 *  el SuperAdmin tiene el rol activo y no está "viendo como" otra
 *  institución — queremos el theme default de la plataforma, sin
 *  branding de ningún tenant. */
function clearTenantVars(root: HTMLElement): void {
  const vars = [
    "--primary",
    "--primary-foreground",
    "--primary-glow",
    "--ring",
    "--sidebar",
    "--sidebar-foreground",
    "--sidebar-primary",
    "--sidebar-primary-foreground",
    "--sidebar-accent",
    "--sidebar-accent-foreground",
    "--sidebar-border",
    "--sidebar-ring",
    "--sidebar-icon-color",
    "--secondary",
    "--secondary-foreground",
    "--accent",
    "--accent-foreground",
    "--background",
    "--foreground",
    "--card",
    "--card-foreground",
    "--popover",
    "--popover-foreground",
    "--muted",
    "--brand-primary",
    "--brand-secondary",
  ];
  for (const v of vars) root.style.removeProperty(v);
}

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
  // text_color e icon_color: las columnas se agregaron en mig
  // 20260706000000 y los tipos generados de Supabase aún no las
  // exponen — accedemos via cast. Extraídos a variables acá arriba
  // para que las deps del useEffect sean estables y no queden
  // expresiones complejas en el array.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantTextColor = (tenant as any)?.text_color ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tenantIconColor = (tenant as any)?.icon_color ?? null;

  // Suscripción al rol activo publicado por AppLayout. Es state local
  // para que el effect de aplicación del theme reaccione al cambio.
  // Inicializamos con el valor actual del signal (puede haber sido
  // seteado antes de que este provider re-renderee).
  const [activeRole, setActiveRoleLocal] = useState<AppRole | null>(getActiveRoleSignal);
  useEffect(() => {
    return subscribeActiveRole((r) => setActiveRoleLocal(r));
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    // ── Caso especial SuperAdmin SIN override ──
    // Si el usuario está actuando como SuperAdmin y NO eligió "Ver como
    // institución X", la plataforma debe mostrar el theme base
    // (OKLCH azul/violeta por defecto). Limpiamos todas las CSS vars
    // que cualquier render anterior haya seteado y salimos. Cuando el
    // usuario vuelva a Admin/Docente/Estudiante, el siguiente run del
    // effect re-aplica los colores de su tenant.
    if (activeRole === "SuperAdmin" && !readTenantOverride()) {
      clearTenantVars(root);
      return;
    }
    const primary = normalizeHex(tenant?.primary_color);
    const secondary = normalizeHex(tenant?.secondary_color);
    // Override explícito del color de letra sobre superficies con
    // branding (sidebar + botones primarios). Si está seteado, gana
    // sobre la derivación por luminancia. Si es NULL → auto-derivado
    // como antes (white/black según primario oscuro/claro).
    const textColor = normalizeHex(tenantTextColor);
    // Override del color de íconos del sidebar nav. Lo aplicamos a la
    // var `--sidebar-icon-color` que los íconos leen via inline style
    // con fallback a `currentColor` (= sidebar-foreground). Si NULL,
    // limpiamos la var → íconos heredan el color de texto.
    const iconColor = normalizeHex(tenantIconColor);
    if (iconColor) {
      root.style.setProperty("--sidebar-icon-color", iconColor);
    } else {
      root.style.removeProperty("--sidebar-icon-color");
    }
    // Detectamos si la app está en modo dark — el wash debe mezclar con
    // negro (dark) vs blanco (light) para que el fondo del contenido
    // siga siendo casi-blanco/casi-negro y no compita con el contenido.
    const isDarkTheme = root.classList.contains("dark");

    /** Aplica el override de text_color si está, o cae al derivado por
     *  luminancia. Usado en todos los foregrounds sobre branding. */
    const setTextOnBranded = (name: string, branded: string | null) => {
      if (textColor) {
        root.style.setProperty(name, textColor);
      } else {
        setForegroundVar(root, name, branded);
      }
    };

    // ── Primary y sus derivados (identidad / acentos) ──
    setColorVar(root, "--primary", primary);
    setTextOnBranded("--primary-foreground", primary);
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
    setTextOnBranded("--sidebar-foreground", primary);
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
      // Si hay text_color override, lo aplicamos también al active item
      // (el background del item activo es un tinte del primario, así
      // que el mismo color de letra del sidebar funciona bien encima).
      root.style.setProperty(
        "--sidebar-primary-foreground",
        textColor ?? (luminanceOfHex(sidebarActive) < 0.55 ? "#ffffff" : "#0a0a0a"),
      );
      root.style.setProperty("--sidebar-accent", sidebarAccent);
      root.style.setProperty(
        "--sidebar-accent-foreground",
        textColor ?? (luminanceOfHex(sidebarAccent) < 0.55 ? "#ffffff" : "#0a0a0a"),
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
    // SOLO en light mode. En dark mode no overrideamos `--background` /
    // `--card` / `--muted` porque el wash de un secundario claro
    // (típico: blanco, crema, gris perla) sobre el negro produce un
    // gris oscuro que el usuario percibe como "se ve gris pero yo
    // configuré blanco" — exactamente el bug reportado. En dark mode
    // dejamos el fondo default del tema y el secundario solo afecta
    // acentos (badges, hovers, --accent), que es lo que tiene sentido
    // visualmente: marca por acentos, no por superficie completa.
    if (secondary && !isDarkTheme) {
      const bg = washHex(secondary, false);
      const card = tintHex(secondary, 0.96, "white");
      const muted = tintHex(secondary, 0.88, "white");
      root.style.setProperty("--background", bg);
      root.style.setProperty("--foreground", "#0a0a0a");
      root.style.setProperty("--card", card);
      root.style.setProperty("--card-foreground", "#0a0a0a");
      root.style.setProperty("--popover", card);
      root.style.setProperty("--popover-foreground", "#0a0a0a");
      root.style.setProperty("--muted", muted);
    } else {
      // Sin secundario, o en dark mode: limpiamos los overrides para
      // que el theme default vuelva a aplicar.
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
  }, [
    tenant?.primary_color,
    tenant?.secondary_color,
    tenantTextColor,
    tenantIconColor,
    activeRole,
  ]);

  return <>{children}</>;
}

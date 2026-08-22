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
import { useRouterState } from "@tanstack/react-router";
import { useTenant, readTenantOverride } from "@/modules/tenants/use-tenant";
import { useTheme } from "@/hooks/use-theme";
import { getActiveRoleSignal, subscribeActiveRole } from "@/modules/tenants/active-role-signal";
import {
  darkVariant,
  luminanceOfHex,
  normalizeHex,
  readableTextOn,
  tintHex,
  washHex,
} from "@/modules/tenants/tenant-colors";
import type { AppRole } from "@/hooks/use-auth";

/** Set canónico de CSS vars que este provider gestiona. Lo usan
 *  clearTenantVars y el snapshot del cache pre-paint. */
const TENANT_VARS = [
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
] as const;

// Cache pre-paint del branding: el tenant llega por fetch (useEffect), así que
// SIN cache cada carga fría pintaba el theme default y "saltaba" al branding
// cuando la query resolvía (~0.5-2s) — el flash de "carga rara" reportado.
// Tras aplicar las vars, las serializamos acá; el <script> inline de
// __root.tsx las re-aplica ANTES del primer paint (solo en /app/*). Mantener
// el nombre de la key EN SYNC con ese script (misma invariante que
// `examlab-theme`).
const TENANT_VARS_CACHE_KEY = "examlab-tenant-vars";

/** Snapshot de las vars actualmente aplicadas → localStorage (pre-paint). */
function cacheTenantVars(root: HTMLElement): void {
  try {
    const snap: Record<string, string> = {};
    for (const v of TENANT_VARS) {
      const val = root.style.getPropertyValue(v);
      if (val) snap[v] = val;
    }
    localStorage.setItem(TENANT_VARS_CACHE_KEY, JSON.stringify(snap));
  } catch {
    /* noop — el cache es solo una optimización visual */
  }
}

function clearTenantVarsCache(): void {
  try {
    localStorage.removeItem(TENANT_VARS_CACHE_KEY);
  } catch {
    /* noop */
  }
}

/** Limpia TODAS las CSS vars que el provider haya seteado. Se usa cuando
 *  el SuperAdmin tiene el rol activo y no está "viendo como" otra
 *  institución — queremos el theme default de la plataforma, sin
 *  branding de ningún tenant. */
function clearTenantVars(root: HTMLElement): void {
  for (const v of TENANT_VARS) root.style.removeProperty(v);
}

// La matematica de color vive en `tenant-colors.ts` — PURA y compartida con la
// vista previa del formulario de institucion (TenantBrandPreview). Estaba acá y
// se extrajo para que la vista previa no tuviera que duplicarla: dos copias del
// mismo calculo terminan divergiendo, y el sintoma seria una marca que se ve de
// un color al configurarla y de otro al usarla.

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
  // El umbral (0.55, algo sobre el clásico 0.5 para que amarillos y verdes
  // claros tomen texto oscuro) vive en `readableTextOn` — un solo lugar, así la
  // vista previa del formulario de institución decide igual que el theme real.
  root.style.setProperty(name, readableTextOn(hex));
}

export function TenantThemeProvider({ children }: { children: React.ReactNode }) {
  const { tenant } = useTenant();
  // resolvedTheme = 'light' | 'dark'. Suscribimos al hook directamente
  // porque el effect que aplica branding lee `document.documentElement
  // .classList.contains("dark")` UNA sola vez por run. Sin esto, al
  // togglear dark mode AFTER de aplicar el tenant, las CSS vars se
  // quedaban con la versión light y el usuario reportaba "dark mode
  // no funciona dentro de la universidad". Agregamos resolvedTheme a
  // deps → re-corre cada vez que el theme cambia.
  const { resolvedTheme } = useTheme();
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

  // Pathname reactivo. El provider está montado en `__root.tsx` y corre
  // en TODAS las rutas — incluyendo la landing pública `/` y `/auth/*`.
  // Fuera de `/app/*` (zona autenticada) NO queremos aplicar branding
  // de tenant: la landing tiene que mostrar siempre los colores
  // originales de la plataforma, aunque el visitante haya sido antes
  // un SuperAdmin con un `examlab_tenant_override` viejo en
  // localStorage (que persiste al cerrar sesión).
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAuthenticatedZone = pathname.startsWith("/app/") || pathname === "/app";

  useEffect(() => {
    const root = document.documentElement;
    // Landing / auth / cualquier ruta pública: theme base sin tocar.
    // Esto cubre el bug "la home muestra los colores del tenant X
    // porque el visitante había visto antes ese tenant" — al volver a
    // /, el override de localStorage se ignora y los CSS vars del
    // provider se limpian.
    if (!isAuthenticatedZone) {
      // Limpia las vars pero CONSERVA el cache pre-paint: al volver a /app
      // el script inline de __root re-aplica el branding sin flash.
      clearTenantVars(root);
      return;
    }
    // ── Caso especial SuperAdmin SIN override ──
    // Si el usuario está actuando como SuperAdmin y NO eligió "Ver como
    // institución X", la plataforma debe mostrar el theme base
    // (OKLCH azul/violeta por defecto). Limpiamos todas las CSS vars
    // que cualquier render anterior haya seteado y salimos. Cuando el
    // usuario vuelva a Admin/Docente/Estudiante, el siguiente run del
    // effect re-aplica los colores de su tenant.
    if (activeRole === "SuperAdmin" && !readTenantOverride()) {
      clearTenantVars(root);
      // También el cache: el próximo load de /app debe pintar el theme
      // default desde el primer frame, no el branding del último tenant.
      clearTenantVarsCache();
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
    // Detectamos si la app está en modo dark vía `resolvedTheme` del
    // useTheme hook (no via `classList.contains`) — esto asegura que
    // el effect REACCIONA al toggle del usuario, no solo lee una
    // snapshot. Ver comentario del import. Si hay condiciones de race
    // entre la aplicación del class y este render, también verificamos
    // el classList como fallback (cuando resolvedTheme es 'system' y
    // el OS está en dark).
    const isDarkTheme = resolvedTheme === "dark" || root.classList.contains("dark");

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
      root.style.setProperty("--primary-glow", tintHex(primary, 0.18, isDark ? "white" : "black"));
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
        textColor ?? readableTextOn(sidebarActive),
      );
      root.style.setProperty("--sidebar-accent", sidebarAccent);
      root.style.setProperty(
        "--sidebar-accent-foreground",
        textColor ?? readableTextOn(sidebarAccent),
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
    // `--card` / `--muted`. La estrategia es distinta según el theme:
    //
    //   LIGHT mode: `washHex` mezcla el secundario 92% con blanco —
    //     fondo casi blanco con un tinte sutil del color de marca.
    //
    //   DARK mode (antes deshabilitado, ahora arreglado): `darkVariant`
    //     trabaja en HSL: preserva el hue + saturación del secundario
    //     pero baja la lightness a 8-15%. Resultado: un secundario rojo
    //     produce un fondo rojo oscuro (no gris); azul → azul oscuro.
    //     Para secundarios achromáticos (blanco/gris/negro) sin hue
    //     que preservar, cae a un neutro dark sano. Antes esta rama
    //     estaba deshabilitada y dark mode ignoraba el branding del
    //     secundario por completo.
    if (secondary) {
      const bg = isDarkTheme ? darkVariant(secondary, 8) : washHex(secondary);
      const card = isDarkTheme ? darkVariant(secondary, 12) : tintHex(secondary, 0.96, "white");
      const muted = isDarkTheme ? darkVariant(secondary, 15) : tintHex(secondary, 0.88, "white");
      const fg = isDarkTheme ? "#fafafa" : "#0a0a0a";
      root.style.setProperty("--background", bg);
      root.style.setProperty("--foreground", fg);
      root.style.setProperty("--card", card);
      root.style.setProperty("--card-foreground", fg);
      root.style.setProperty("--popover", card);
      root.style.setProperty("--popover-foreground", fg);
      root.style.setProperty("--muted", muted);
    } else {
      // Sin secundario configurado: limpiamos overrides → default theme.
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

    // Snapshot → localStorage para que el próximo load pinte el branding
    // desde el PRIMER frame (script pre-paint de __root.tsx). Cierra el
    // flash "carga rara": default theme → salto al branding del tenant.
    cacheTenantVars(root);
  }, [
    tenant?.primary_color,
    tenant?.secondary_color,
    tenantTextColor,
    tenantIconColor,
    activeRole,
    resolvedTheme,
    // Necesario para que al navegar de /app/* → / (landing) las vars se
    // limpien y la landing recupere los colores originales.
    isAuthenticatedZone,
  ]);

  return <>{children}</>;
}

/**
 * TenantThemeProvider — inyecta las variables CSS de branding del tenant
 * activo en :root para que toda la app las consuma.
 *
 * Variables expuestas:
 *   --brand-primary:    primary_color del tenant (fallback al azul default).
 *   --brand-secondary:  secondary_color del tenant (fallback a una variación
 *                       del primario o al azul claro).
 *
 * Cómo se aplica:
 *   - `tailwind.config.ts` ya mapea `primary` a `hsl(var(--primary))` etc.
 *     Aquí NO sobrescribimos esa variable (rompería el resto del design
 *     system que asume HSL). En su lugar exponemos `--brand-primary` /
 *     `--brand-secondary` como variables ESPECÍFICAS de tenant que el
 *     PageHeader, los Stat tiles, sidebar usan opcionalmente vía
 *     `style={{ color: 'var(--brand-primary)' }}`.
 *
 *   - Si el tenant no tiene color configurado, las variables quedan vacías
 *     y los componentes caen al diseño base (azul / violeta default).
 *
 * Iconos: el design system usa text-* clases de tailwind (e.g. text-indigo-500).
 * Para que un ícono respete el color del tenant, el caller pasa explícitamente
 * `style={{ color: 'var(--brand-primary)' }}` en lugar de la clase. Esto es
 * opt-in — los iconos genéricos (Settings, Mail, etc.) mantienen su color
 * decorativo; solo los iconos "headline" del tenant adoptan el color.
 *
 * Para PNG/SVG vectoriales con fill propio, el color del tenant no aplica
 * (el archivo trae sus colores). Sí aplica a iconos lucide que usan
 * `currentColor`.
 */
import { useEffect } from "react";
import { useTenant } from "@/modules/tenants/use-tenant";

/**
 * Normaliza un hex de 6 dígitos a hex válido. Acepta con o sin '#'.
 * Devuelve null si no parece hex. NO acepta hex de 3 o 8 dígitos por
 * simplicidad — el SuperAdmin/Admin pegan colores de paletas estándar.
 */
function normalizeHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const withHash = v.startsWith("#") ? v : `#${v}`;
  if (!/^#[0-9a-fA-F]{6}$/.test(withHash)) return null;
  return withHash;
}

export function TenantThemeProvider({ children }: { children: React.ReactNode }) {
  const { tenant } = useTenant();

  useEffect(() => {
    const root = document.documentElement;
    const primary = normalizeHex(tenant?.primary_color);
    const secondary = normalizeHex(tenant?.secondary_color);

    if (primary) {
      root.style.setProperty("--brand-primary", primary);
    } else {
      root.style.removeProperty("--brand-primary");
    }
    if (secondary) {
      root.style.setProperty("--brand-secondary", secondary);
    } else {
      root.style.removeProperty("--brand-secondary");
    }

    return () => {
      // No limpiamos al unmount — el tenant theme persiste hasta que
      // cambia. Limpiar acá causaría flash de no-color durante navegación
      // que desmonta el provider temporalmente (no debería pasar porque
      // está en __root, pero defensivo).
    };
  }, [tenant?.primary_color, tenant?.secondary_color]);

  return <>{children}</>;
}

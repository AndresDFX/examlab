/**
 * Vista previa de cómo va a quedar la app con la marca de una institución,
 * para el formulario del SuperAdmin.
 *
 * Para qué: el formulario pide cuatro colores en hexadecimal y hasta ahora el
 * único modo de saber cómo se veían era guardar, entrar a la institución y
 * mirar. Con cuatro campos eso son varias vueltas hasta acertar. Acá se ve
 * mientras se escribe.
 *
 * Fidelidad: los colores derivados (fondo del área principal, texto sobre el
 * primario, activo del menú) salen de `tenant-colors.ts`, el MISMO módulo que
 * usa `TenantThemeProvider` para pintar la app de verdad. No es una
 * aproximación: si el provider cambia el cálculo, esta vista cambia con él.
 *
 * Lo que NO reproduce, a propósito: la app real, con sus módulos y su
 * contenido. Es una miniatura de tres elementos —barra lateral, encabezado y un
 * botón primario— que es donde la marca efectivamente se ve. Dibujar una
 * réplica completa daría una segunda interfaz que mantener sincronizada con la
 * primera, y se desincronizaría en la primera semana.
 */
import { Building2, GraduationCap, LayoutDashboard, Users } from "lucide-react";
import {
  darkVariant,
  normalizeHex,
  readableTextOn,
  tintHex,
  washHex,
} from "@/modules/tenants/tenant-colors";

/** Defaults del theme, para que la vista previa nunca quede en blanco. */
const FALLBACK_PRIMARY = "#3B82F6";
const FALLBACK_SECONDARY = "#8B5CF6";

export interface TenantBrandPreviewProps {
  name?: string | null;
  primaryColor?: string | null;
  secondaryColor?: string | null;
  /** Override del texto sobre el primario. Vacío = se deriva por luminancia. */
  textColor?: string | null;
  /** Override del color de los íconos del menú. Vacío = usa el color de texto. */
  iconColor?: string | null;
  logoUrl?: string | null;
  /** `true` muestra la miniatura en modo oscuro. */
  dark?: boolean;
}

export function TenantBrandPreview({
  name,
  primaryColor,
  secondaryColor,
  textColor,
  iconColor,
  logoUrl,
  dark = false,
}: TenantBrandPreviewProps) {
  const primary = normalizeHex(primaryColor) ?? FALLBACK_PRIMARY;
  const secondary = normalizeHex(secondaryColor) ?? FALLBACK_SECONDARY;

  // Mismas derivaciones que TenantThemeProvider aplica sobre --sidebar-* y
  // sobre el fondo del área principal.
  const onPrimary = normalizeHex(textColor) ?? readableTextOn(primary);
  const icons = normalizeHex(iconColor) ?? onPrimary;
  const primaryIsDark = readableTextOn(primary) === "#ffffff";
  const sidebarActive = tintHex(primary, 0.25, primaryIsDark ? "white" : "black");
  const background = dark ? darkVariant(secondary, 8) : washHex(secondary);
  const surface = dark ? darkVariant(secondary, 12) : tintHex(secondary, 0.96, "white");
  const onSurface = readableTextOn(surface);
  const muted = dark ? darkVariant(secondary, 15) : tintHex(secondary, 0.88, "white");

  const shown = (name ?? "").trim() || "Tu institución";
  const initial = shown.charAt(0).toUpperCase();

  return (
    <div
      className="overflow-hidden rounded-md border shadow-sm"
      // Colores de marca en runtime: es el caso (d) permitido por la regla de
      // estilos inline del proyecto (valores que vienen del usuario/DB).
      style={{ backgroundColor: background }}
      aria-label={`Vista previa de la marca de ${shown}`}
    >
      <div className="flex h-40">
        {/* Barra lateral */}
        <div className="flex w-28 shrink-0 flex-col gap-2 p-2" style={{ backgroundColor: primary }}>
          <div className="flex items-center gap-1.5">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="h-5 w-5 rounded object-contain" />
            ) : (
              <div
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-3xs font-bold"
                style={{ backgroundColor: sidebarActive, color: onPrimary }}
              >
                {initial}
              </div>
            )}
            <span className="truncate text-3xs font-semibold" style={{ color: onPrimary }}>
              {shown}
            </span>
          </div>

          <div
            className="flex items-center gap-1.5 rounded px-1.5 py-1"
            style={{ backgroundColor: sidebarActive }}
          >
            <LayoutDashboard className="h-3 w-3 shrink-0" style={{ color: icons }} />
            <span className="text-3xs" style={{ color: onPrimary }}>
              Inicio
            </span>
          </div>
          {[
            { Icon: GraduationCap, label: "Cursos" },
            { Icon: Users, label: "Usuarios" },
          ].map(({ Icon, label }) => (
            <div key={label} className="flex items-center gap-1.5 px-1.5 py-1">
              <Icon className="h-3 w-3 shrink-0" style={{ color: icons }} />
              <span className="text-3xs opacity-80" style={{ color: onPrimary }}>
                {label}
              </span>
            </div>
          ))}
        </div>

        {/* Área principal */}
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-2.5">
          <div className="flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5 shrink-0" style={{ color: primary }} />
            <span className="truncate text-2xs font-semibold" style={{ color: onSurface }}>
              Panel de {shown}
            </span>
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {["Cursos", "Docentes", "Alumnos"].map((k) => (
              <div
                key={k}
                className="rounded p-1.5"
                style={{ backgroundColor: surface, color: onSurface }}
              >
                <div className="text-3xs opacity-70">{k}</div>
                <div className="text-2xs font-semibold">—</div>
              </div>
            ))}
          </div>

          <div className="flex-1 rounded" style={{ backgroundColor: muted }} />

          <div
            className="self-start rounded px-2 py-1 text-3xs font-medium"
            style={{ backgroundColor: primary, color: onPrimary }}
          >
            Acción principal
          </div>
        </div>
      </div>
    </div>
  );
}

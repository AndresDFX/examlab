/**
 * MeetingLink — chip clickeable que abre la reunión externa en nueva
 * pestaña, identificando visualmente el proveedor (Meet / Teams / Zoom)
 * por su color de marca + un mini logo inline.
 *
 * La detección es por host del URL — Google Meet, Microsoft Teams y
 * Zoom tienen dominios estables. Si no matchea ninguno cae al estilo
 * "Reunión" genérico.
 *
 * Mantenemos los SVGs como letras estilizadas en color de marca (no las
 * marcas registradas exactas) para evitar líos de uso de logo oficial.
 * Es reconocible a primera vista sin ser una reproducción literal.
 */
import { Video } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

type Provider = "meet" | "teams" | "zoom" | "other";

/** Tonos de marca para chips de recurso de sesión que NO son reuniones
 *  (grabación, notas). Reusan el mismo estilo de chip de `MeetingLink`
 *  para que los tres recursos de una sesión se vean consistentes. */
type ResourceTone = "rose" | "amber";

const RESOURCE_TONE_CLS: Record<ResourceTone, string> = {
  rose: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 hover:bg-rose-500/20",
  amber:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20",
};

function detectProvider(url: string): Provider {
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("meet.google.com")) return "meet";
    if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) return "teams";
    if (host.includes("zoom.us") || host.endsWith(".zoom.us") || host.includes("zoom.com"))
      return "zoom";
    return "other";
  } catch {
    return "other";
  }
}

/** Mini logo por proveedor.
 *
 * Para Google Meet usamos el SVG OFICIAL — los 4 cuadrantes en
 * verde/azul/amarillo/rojo de Google que forman una "M" / cámara
 * estilizada (uso permitido como "favicon" para enlazar a la app).
 * Para Teams y Zoom seguimos con letras estilizadas porque sus marcas
 * son más restrictivas — la letra coloreada cumple el propósito sin
 * exponernos a problemas de marca.
 */
function ProviderLogo({ provider }: { provider: Provider }) {
  if (provider === "meet") {
    // Logo oficial de Google Meet (vector simplificado de los 4
    // cuadrantes que forman la M de Meet). 4 colores de Google +
    // cuerpo de la cámara en verde.
    return (
      <svg
        viewBox="0 0 87 72"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="h-4 w-4 shrink-0"
      >
        <path d="M49.5 36L59 44.5 87 22V50c0 5.5-4.5 10-10 10H67V46L49.5 36z" fill="#00832D" />
        <path d="M0 51.5V61c0 5.5 4.5 10 10 10h33V60H10V51.5H0z" fill="#0066DA" />
        <path d="M10 0C4.5 0 0 4.5 0 10v41.5h10V14h33V0H10z" fill="#E94235" />
        <path d="M43 0v14h24v22l20 14V21c0-5.5-4.5-10-10-10L80 0H43z" fill="#FFBA00" />
        <path d="M43 14v46h24V36L43 14z" fill="#00AC47" />
        <path d="M67 36v10l20 14V22L67 36z" fill="#FFBA00" />
      </svg>
    );
  }
  if (provider === "teams") {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-[#5059C9] text-white text-[9px] font-bold leading-none shrink-0">
        T
      </span>
    );
  }
  if (provider === "zoom") {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-[#2D8CFF] text-white text-[9px] font-bold leading-none shrink-0">
        Z
      </span>
    );
  }
  return <Video className="h-3.5 w-3.5 shrink-0" />;
}

const LABELS: Record<Provider, string> = {
  meet: "Google Meet",
  teams: "Microsoft Teams",
  zoom: "Zoom",
  other: "Reunión",
};

/** Clases por proveedor — fondo suave de la marca para destacarlo del
 *  resto de elementos de la sesión sin gritar. */
const PROVIDER_CLS: Record<Provider, string> = {
  meet: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/20",
  teams:
    "border-indigo-500/30 bg-indigo-500/10 text-indigo-700 dark:text-indigo-300 hover:bg-indigo-500/20",
  zoom: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300 hover:bg-sky-500/20",
  other: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300 hover:bg-blue-500/20",
};

interface MeetingLinkProps {
  url: string;
  /** Label opcional — si no se pasa, usa el nombre del proveedor.
   *  Útil cuando el caller quiere "Unirse a la reunión" como texto
   *  genérico en lugar del nombre de la plataforma. */
  label?: string;
  className?: string;
}

export function MeetingLink({ url, label, className }: MeetingLinkProps) {
  const { t } = useTranslation();
  const provider = detectProvider(url);
  const providerLabel =
    provider === "other" ? t("courseBoard.meeting", { defaultValue: "Reunión" }) : LABELS[provider];
  const text = label ?? providerLabel;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 mt-1 text-xs rounded-md border px-2 py-1 transition-colors ${PROVIDER_CLS[provider]} ${className ?? ""}`}
      title={`${providerLabel} — ${url}`}
    >
      <ProviderLogo provider={provider} />
      {text}
    </a>
  );
}

interface ResourceLinkProps {
  url: string;
  label: string;
  icon: LucideIcon;
  tone: ResourceTone;
  className?: string;
}

/** ResourceLink — chip clickeable para un recurso externo de una sesión
 *  (grabación, notas, etc.) que NO es una reunión. Comparte la cáscara
 *  de estilo de `MeetingLink` para que los chips de una sesión se vean
 *  consistentes; el `tone` y el `icon` los elige el caller. */
export function ResourceLink({ url, label, icon: Icon, tone, className }: ResourceLinkProps) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 text-xs rounded-md border px-2 py-1 transition-colors ${RESOURCE_TONE_CLS[tone]} ${className ?? ""}`}
      title={url}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      {label}
    </a>
  );
}

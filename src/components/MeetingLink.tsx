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

type Provider = "meet" | "teams" | "zoom" | "other";

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

/** Mini logo por proveedor — letra estilizada en círculo brand-colored.
 *  Reemplazo razonable del logo oficial (evita el problema de TM). */
function ProviderLogo({ provider }: { provider: Provider }) {
  if (provider === "meet") {
    return (
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-sm bg-[#00897B] text-white text-[9px] font-bold leading-none shrink-0">
        M
      </span>
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
  const provider = detectProvider(url);
  const text = label ?? LABELS[provider];
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-1.5 mt-1 text-xs rounded-md border px-2 py-1 transition-colors ${PROVIDER_CLS[provider]} ${className ?? ""}`}
      title={`${LABELS[provider]} — ${url}`}
    >
      <ProviderLogo provider={provider} />
      {text}
    </a>
  );
}

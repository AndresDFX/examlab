import { useTranslation } from "react-i18next";
import { cn } from "@/shared/lib/utils";
import { sessionTypeMeta, type SessionType } from "./session-type";

/**
 * Badge de la modalidad de una sesión (Presencial / Virtual / Autónoma).
 * Badge PLANO con ícono (coherente con la modalidad de horarios y con los KIND
 * badges del calendario — NO StatusBadge, que mapea estados de exam/workshop).
 *
 * `iconOnly` para espacios muy angostos (headers de columna de la matriz de
 * asistencia): muestra solo el ícono con el label como `title`/aria-label.
 */
export function SessionTypeBadge({
  type,
  iconOnly = false,
  className,
}: Readonly<{ type: SessionType | string | null | undefined; iconOnly?: boolean; className?: string }>) {
  const { t } = useTranslation();
  const meta = sessionTypeMeta(type);
  const Icon = meta.icon;
  const label = t(meta.labelKey);

  if (iconOnly) {
    return (
      <span
        className={cn("inline-flex items-center", meta.colorClass, className)}
        title={label}
        aria-label={label}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium",
        meta.colorClass,
        className,
      )}
    >
      <Icon className="h-3 w-3" />
      {label}
    </span>
  );
}

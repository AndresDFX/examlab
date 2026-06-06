/**
 * StatCard — tarjeta compacta para stats arriba de un listado.
 *
 * Patrón compartido por TODOS los módulos de listado (Videos, Cursos,
 * Exámenes, Talleres, Proyectos, Pizarras, Contenidos, Encuestas,
 * Papelera, Prompts, Informes, etc.). Layout:
 *
 *   ┌───────────────────────────┐
 *   │ <icon> Label              │  ← text-xs muted
 *   │ Value                     │  ← text-2xl semibold tabular
 *   └───────────────────────────┘
 *
 * Uso:
 *   <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
 *     <StatCard icon={FileText} label="Total" value={12} />
 *     <StatCard icon={Clock} label="Pendientes" value={5} tone="warning" />
 *     ...
 *   </div>
 *
 * Tones: cambian el color del NÚMERO (no del icono ni del label) para
 * destacar contadores accionables (rojo si hay items fallados, ámbar si
 * hay items pendientes). Default neutral.
 */
import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

type Tone = "default" | "destructive" | "warning" | "success" | "muted";

interface StatCardProps {
  icon: LucideIcon;
  label: string;
  /** Valor principal. Puede ser número (común) o string corto (ej. fecha
   *  formateada para "Última edición"). Si pasás string, usá `valueSize`
   *  para reducirlo si es ancho. */
  value: number | string;
  /** Reduce el tamaño del valor cuando es texto largo (fechas, hashes).
   *  Default `lg` (2xl). `md` = sm. */
  valueSize?: "lg" | "md";
  /** Tono semántico del número. Default `default` (foreground neutral). */
  tone?: Tone;
  /** Texto opcional debajo del valor (label secundario / contexto). */
  sub?: string;
  /** Hace la card clickeable. */
  onClick?: () => void;
  /** className adicional aplicado al Card raíz (para sticky, span, etc.) */
  className?: string;
}

const TONE_CLASSES: Record<Tone, string> = {
  default: "",
  destructive: "text-destructive",
  warning: "text-amber-600 dark:text-amber-400",
  success: "text-emerald-600 dark:text-emerald-400",
  muted: "text-muted-foreground",
};

export function StatCard({
  icon: Icon,
  label,
  value,
  valueSize = "lg",
  tone = "default",
  sub,
  onClick,
  className,
}: StatCardProps) {
  const toneClass = TONE_CLASSES[tone];
  const valueClass =
    valueSize === "lg"
      ? "text-2xl font-semibold tabular-nums"
      : "text-sm font-medium tabular-nums truncate";
  const clickable = onClick ? "cursor-pointer hover:bg-muted/40 transition-colors" : "";
  return (
    <Card className={`${clickable} ${className ?? ""}`} onClick={onClick}>
      <CardContent className="p-4">
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <Icon className="h-3 w-3" /> {label}
        </div>
        <div className={`${valueClass} ${toneClass} mt-1`}>{value}</div>
        {sub && <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{sub}</div>}
      </CardContent>
    </Card>
  );
}

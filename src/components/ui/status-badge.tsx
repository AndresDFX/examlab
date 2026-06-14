import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  type LucideIcon,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { statusLabel } from "@/shared/utils/status-labels";
import { cn } from "@/shared/lib/utils";

/**
 * StatusBadge — representación visual unificada de estados de
 * exam/workshop/project/submission. Antes cada pantalla decidía
 * por su cuenta qué variante usar para el mismo estado: "sospechoso"
 * a veces salía con `destructive`, otras con `secondary` + clase
 * roja, otras con un `<span>` sin Badge. Centralizar acá fija el
 * mapeo y mantiene consistencia visual.
 *
 * Reglas de variante:
 *  - destructive: estados de alerta (sospechoso, requiere_revision)
 *  - default (primary): estados activos / en curso (publicado, en
 *    progreso, iniciado)
 *  - secondary: estados estables / completados (cerrado, calificado,
 *    completado, entregado, ai_revisado)
 *  - outline: estados neutros / placeholder (borrador, pendiente,
 *    archivado, cualquier estado no mapeado)
 *
 * Íconos: solo para estados con peso visual fuerte (alertas, hitos).
 * Para estados neutros se omite el ícono — saturar con íconos ruido
 * y se pierde el énfasis cuando aparecen los importantes.
 */

type StatusVariant = "default" | "secondary" | "destructive" | "outline";

const STATUS_META: Record<string, { variant: StatusVariant; icon?: LucideIcon }> = {
  // Recursos (exam/workshop/project)
  draft: { variant: "outline" },
  published: { variant: "default" },
  closed: { variant: "secondary" },
  archived: { variant: "outline" },

  // Ciclo de vida del curso (borrador → en_curso → finalizado) + el
  // derivado 'proximo' (en_curso publicado pero sin empezar). Familias:
  // borrador como placeholder neutro (igual que draft, sin ícono);
  // en_curso como activo (Clock, familia de iniciado/en_progreso);
  // proximo como agendado estable; finalizado como hito completado.
  borrador: { variant: "outline" },
  en_curso: { variant: "default", icon: Clock },
  proximo: { variant: "secondary", icon: CalendarClock },
  finalizado: { variant: "secondary", icon: CheckCircle2 },

  // Submissions
  iniciado: { variant: "default", icon: Clock },
  en_progreso: { variant: "default", icon: Clock },
  completado: { variant: "secondary", icon: CheckCircle2 },
  entregado: { variant: "secondary", icon: CheckCircle2 },
  calificado: { variant: "secondary", icon: CheckCircle2 },
  ai_revisado: { variant: "secondary", icon: Sparkles },
  sospechoso: { variant: "destructive", icon: AlertTriangle },
  // Sospechoso revisado: alertas IA y plagio cerradas por el docente.
  chequeado: { variant: "secondary", icon: ShieldCheck },
  requiere_revision: { variant: "destructive", icon: AlertTriangle },
  pending: { variant: "outline" },
  pendiente: { variant: "outline" },
};

interface StatusBadgeProps {
  status: string | null | undefined;
  className?: string;
  /** Forzar a no mostrar ícono incluso si el estado lo tiene mapeado. */
  hideIcon?: boolean;
}

export function StatusBadge({ status, className, hideIcon }: Readonly<StatusBadgeProps>) {
  const meta = (status ? STATUS_META[status] : undefined) ?? {
    variant: "outline" as StatusVariant,
  };
  const Icon = hideIcon ? undefined : meta.icon;
  return (
    <Badge variant={meta.variant} className={cn("text-[10px]", className)}>
      {Icon ? <Icon className="h-3 w-3 mr-0.5" /> : null}
      {statusLabel(status)}
    </Badge>
  );
}

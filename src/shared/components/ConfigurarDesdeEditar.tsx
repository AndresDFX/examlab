import type { LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export interface AccionDeConfiguracion {
  key: string;
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  /** Mientras carga lo que necesita para abrirse (un clic sin señal se repite). */
  busy?: boolean;
  disabled?: boolean;
}

/**
 * «Contenido y participantes» dentro de «Editar» de un taller o un proyecto:
 * las preguntas, quién lo tiene asignado y los grupos. Vivían en el menú de la
 * fila, mezcladas con las acciones del día a día (calificar, publicar), y el
 * menú llegaba a diez opciones. Configurar la actividad es parte de editarla,
 * como en exámenes, cuya página de edición ya reúne preguntas y asignación.
 *
 * Cada botón abre el MISMO diálogo de antes, encima del formulario, y lo que
 * se cambia ahí se guarda en el acto: no depende del «Guardar» del formulario.
 */
export function ConfigurarDesdeEditar({
  acciones,
  dirty = false,
}: {
  /** Los valores falsos se omiten: así una acción se condiciona inline. */
  acciones: Array<AccionDeConfiguracion | false | null | undefined>;
  /**
   * El formulario de debajo tiene cambios sin guardar. Estas ventanas leen la
   * versión GUARDADA (p. ej. «generar preguntas desde la descripción» usa la
   * descripción de la base), así que se avisa antes de que se note el desfase.
   */
  dirty?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border p-3 space-y-2" data-tour-id="editar-configuracion">
      <div>
        <p className="text-sm font-medium">{t("editarConfig.titulo")}</p>
        <p className="text-2xs text-muted-foreground">{t("editarConfig.hint")}</p>
        {dirty && <p className="text-2xs text-warning-on-subtle">{t("editarConfig.dirtyHint")}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {acciones.filter((a): a is AccionDeConfiguracion => !!a).map((a) => {
          const Icon = a.icon;
          return (
            <Button
              key={a.key}
              type="button"
              size="sm"
              variant="outline"
              onClick={a.onClick}
              disabled={a.disabled || a.busy}
            >
              {a.busy ? <Spinner size="sm" className="mr-1" /> : <Icon className="h-4 w-4 mr-1" />}
              {a.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

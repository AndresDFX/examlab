/**
 * Paneles con divisor arrastrable, sobre `react-resizable-panels`.
 *
 * ── Por qué este archivo se reescribió ────────────────────────────────
 * La versión anterior era el envoltorio que shadcn genera para la API v2/v3 de
 * la librería, pero el repo tiene la **v4**, donde cambiaron tres cosas:
 *
 *  1. La orientación se pasa en `orientation`, no en `direction`. Con el nombre
 *     viejo TypeScript rechaza la prop.
 *  2. La v4 emite `data-group` / `data-panel` / `data-separator`, y **ya no**
 *     `data-panel-group-direction`. Todas las clases `data-[panel-group-direction=vertical]:*`
 *     del envoltorio viejo eran selectores MUERTOS: compilaban, no aplicaban, y
 *     un grupo vertical quedaba con el divisor de 1px de ANCHO en vez de alto —
 *     o sea invisible y casi imposible de agarrar.
 *  3. La v4 controla ella misma `display`, `flex-direction`, `flex-wrap` y
 *     `overflow` del grupo (lo dice su propio tipo: no se pueden sobreescribir),
 *     así que el `flex`/`flex-col` del envoltorio no hacía falta.
 *
 * Nadie lo había notado porque el componente estaba SIN USAR: el único import
 * era el de `toggle-group` a `toggle`. Un primitivo roto que nadie usa se ve
 * igual que uno que funciona.
 *
 * ── La orientación del divisor es EXPLÍCITA ───────────────────────────
 * `ResizableHandle` recibe su propia `orientation` en vez de deducirla del
 * grupo: la v4 no expone un atributo en el DOM del que leerla, y adivinarla con
 * un selector sobre estilos en línea es justo la clase de acoplamiento frágil
 * que dejó roto al envoltorio anterior. Es una prop de más y a cambio no puede
 * desincronizarse en silencio.
 */
import { GripVertical } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "@/shared/lib/utils";

type Orientacion = "horizontal" | "vertical";

const ResizablePanelGroup = ({ className, ...props }: React.ComponentProps<typeof Group>) => (
  <Group
    // 32px en punteros gruesos: el default de la librería (20) queda por debajo
    // del piso táctil del proyecto. Va antes del spread para que un consumidor
    // con una necesidad distinta pueda sobreescribirlo.
    resizeTargetMinimumSize={{ coarse: 32, fine: 10 }}
    className={cn("h-full w-full", className)}
    {...props}
  />
);

const ResizablePanel = Panel;

/**
 * El divisor. `withHandle` agrega el agarre visible.
 *
 * ── El agarre es de 32×32 y no de 12×32 ───────────────────────────────
 * La línea del divisor es de 1px: apuntarle con el dedo es inviable, así que el
 * agarre es lo que se toca. La primera versión lo dejó en `h-3 w-8` (12px en el
 * eje que importa para arrastrar), y eso está por debajo del piso de **32px**
 * que la convención del proyecto exige en móvil — el mismo defecto que se
 * corrigió en los chips de Estadísticas dos commits antes. Cuadrado (`h-8 w-8`)
 * evita además mantener dos combinaciones según la orientación.
 *
 * Y NO alcanza con agrandar el agarre: la librería tiene su propio umbral de
 * área agarrable (`resizeTargetMinimumSize`, por defecto 20px en punteros
 * gruesos), así que el grupo lo sube a 32 — `ResizablePanelGroup` lo pone como
 * default para que cualquier consumidor futuro lo herede sin acordarse.
 *
 * A diferencia de `ColumnResizeHandle` de `table.tsx`, este divisor NO es
 * solo-desktop (ese se oculta con `hidden sm:block` a propósito): la hoja SQL de
 * la pizarra se abre desde un tablet, así que acá el dedo tiene que funcionar.
 */
const ResizableHandle = ({
  withHandle,
  orientation = "horizontal",
  ariaLabel,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  withHandle?: boolean;
  orientation?: Orientacion;
  /**
   * Qué se está redimensionando, para lector de pantalla y `title`. La librería
   * pone atributos ARIA de estructura pero no un nombre, y sin nombre el
   * control se anuncia como «separador» sin decir separador de qué. El único
   * otro control de este tipo en el repo (`ColumnResizeHandle` de `table.tsx`)
   * ya lo trae, así que omitirlo acá sería romper un patrón ya establecido.
   * Lo pasa el consumidor porque es el único que sabe qué hay a cada lado, y
   * traducido: este componente no tiene acceso a `t`.
   */
  ariaLabel?: string;
}) => {
  const vertical = orientation === "vertical";
  return (
    <Separator
      aria-label={ariaLabel}
      title={ariaLabel}
      className={cn(
        "relative flex items-center justify-center bg-border transition-colors hover:bg-primary/40",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
        // Área agarrable por encima del 1px visible: en el eje del arrastre se
        // extiende con `after:`, que no ocupa espacio en el layout.
        vertical
          ? "h-px w-full cursor-row-resize after:absolute after:inset-x-0 after:top-1/2 after:h-3 after:-translate-y-1/2"
          : "w-px cursor-col-resize after:absolute after:inset-y-0 after:left-1/2 after:w-3 after:-translate-x-1/2",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div
          className={cn(
            "z-10 flex items-center justify-center rounded-sm border bg-border",
            "h-8 w-8",
          )}
        >
          <GripVertical className={cn("h-2.5 w-2.5", vertical && "rotate-90")} />
        </div>
      )}
    </Separator>
  );
};

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };

/**
 * useDirtyDialog — guard contra perder datos cuando el usuario cierra
 * un modal de formulario por error (click fuera, Escape o X) sin haber
 * guardado.
 *
 * Captura el `formState` al abrir el diálogo y lo compara por
 * JSON.stringify en cada render. Si está sucio y se intenta cerrar,
 * primero pregunta "¿Descartar los cambios?" y solo cierra si el
 * usuario confirma.
 *
 * Uso típico:
 *   const [open, setOpen] = useState(false);
 *   const [form, setForm] = useState(initial);
 *   const dirty = useDirtyDialog(open, form);
 *   <Dialog open={open} onOpenChange={dirty.guardOpenChange(setOpen)}>
 *     ...
 *
 * Aplica a cualquier objeto-formulario (un solo state). Para forms con
 * múltiples useStates, agrúpalos en un memo: `useMemo(() => ({ a, b, c }), [a,b,c])`.
 */
import { useEffect, useRef } from "react";
import { useConfirm } from "@/shared/components/ConfirmDialog";

export function useDirtyDialog<T>(open: boolean, formState: T) {
  const confirm = useConfirm();
  const initialRef = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      // Captura snapshot al abrir; el cierre lo limpia.
      initialRef.current = JSON.stringify(formState);
    } else {
      initialRef.current = null;
    }
    // Solo dependemos de `open` a propósito: queremos capturar al
    // entrar al estado abierto, no actualizar el snapshot en cada
    // tecla del usuario.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const isDirty =
    open &&
    initialRef.current !== null &&
    JSON.stringify(formState) !== initialRef.current;

  /**
   * Envuelve `setOpen` para que cualquier intento de cerrar (click
   * fuera, Escape, X o un botón Cancel) primero pida confirmación si
   * el form está sucio.
   */
  const guardOpenChange =
    (setOpen: (open: boolean) => void) => async (next: boolean) => {
      if (!next && isDirty) {
        const ok = await confirm({
          title: "Cambios sin guardar",
          description:
            "Tienes información sin guardar en este formulario. ¿Descartar los cambios?",
          confirmLabel: "Descartar",
          cancelLabel: "Seguir editando",
          tone: "destructive",
        });
        if (!ok) return;
      }
      setOpen(next);
    };

  return { isDirty, guardOpenChange };
}

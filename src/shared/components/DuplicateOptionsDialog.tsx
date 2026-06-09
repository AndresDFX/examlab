/**
 * DuplicateOptionsDialog — dialog genérico para "Duplicar X eligiendo qué
 * información interna copiar". Presenta una lista de checkboxes (qué
 * copiar) y delega la inserción real al `onConfirm(flags)` del caller.
 *
 * Lo usan los flujos cuya duplicación se hace CLIENT-SIDE y tiene piezas
 * internas opcionales: encuestas (opciones/cursos), pizarras
 * (contenido/curso), contenidos (archivos/cursos). El duplicado de
 * examen/taller/proyecto NO usa esto — va por RPCs SQL clone_* con su
 * propio dialog (DuplicateAssessmentDialog), porque necesita curso destino
 * + título y corre server-side.
 *
 * El caller arma las `options` (cada una con su `param` = clave del flag) y
 * recibe en `onConfirm` un `Record<param, boolean>` con lo elegido. El
 * estado de los checkboxes se resetea a `defaultChecked` cada vez que el
 * dialog se abre.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Copy } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { toast } from "sonner";
import type { ReactNode } from "react";

export interface DuplicateOption {
  /** Clave del flag devuelto en `onConfirm` (ej. "copyOptions"). */
  param: string;
  label: string;
  hint?: string;
  /** Estado inicial del checkbox. Default true (copiar todo). */
  defaultChecked?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  options: DuplicateOption[];
  confirmLabel?: string;
  /** Inserta la copia con los flags elegidos. Si lanza, se muestra un
   *  toast con el error y el dialog NO se cierra (el caller puede reintentar). */
  onConfirm: (flags: Record<string, boolean>) => Promise<void>;
}

export function DuplicateOptionsDialog({
  open,
  onOpenChange,
  title,
  description,
  options,
  confirmLabel = "Duplicar",
  onConfirm,
}: Props) {
  const [flags, setFlags] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setFlags(Object.fromEntries(options.map((o) => [o.param, o.defaultChecked ?? true])));
      setSubmitting(false);
    }
    // options es estable por render del caller (array literal); reiniciamos
    // solo al abrir para no pisar lo que el usuario tildó.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await onConfirm(flags);
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo duplicar"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !submitting && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-4 w-4 text-indigo-500" />
            {title}
          </DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        {options.length > 0 && (
          <div className="space-y-2 rounded-md border p-3">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Qué copiar
            </Label>
            {options.map((opt) => (
              <label key={opt.param} className="flex items-start gap-2 cursor-pointer select-none">
                <Checkbox
                  checked={flags[opt.param] ?? true}
                  onCheckedChange={(v) =>
                    setFlags((prev) => ({ ...prev, [opt.param]: Boolean(v) }))
                  }
                  disabled={submitting}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-sm font-medium block">{opt.label}</span>
                  {opt.hint && (
                    <span className="text-[11px] text-muted-foreground block">{opt.hint}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancelar
          </Button>
          <Button onClick={() => void submit()} disabled={submitting}>
            {submitting ? <Spinner size="sm" className="mr-1" /> : <Copy className="h-4 w-4 mr-1" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

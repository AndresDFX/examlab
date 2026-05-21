/**
 * Banner sticky que aparece arriba del layout cuando el admin está
 * impersonando a otro usuario. Sirve como recordatorio visual constante
 * + botón "Volver a mi cuenta".
 *
 * Se monta una sola vez en `AppLayout` y se auto-oculta cuando no hay
 * backup en localStorage. No depende de la ruta — visible en TODO el
 * subtree autenticado.
 */
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useState } from "react";
import { toast } from "sonner";
import { useImpersonation, stopImpersonate } from "./impersonation";

export function ImpersonationBanner() {
  const { isImpersonating, target } = useImpersonation();
  const [stopping, setStopping] = useState(false);

  if (!isImpersonating || !target) return null;

  const handleStop = async () => {
    setStopping(true);
    try {
      await stopImpersonate();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al restaurar la sesión");
      setStopping(false);
    }
  };

  return (
    <div className="sticky top-0 z-50 bg-amber-500 text-amber-950 px-4 py-2 shadow-md flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 text-sm font-medium min-w-0">
        <Eye className="h-4 w-4 shrink-0" />
        <span className="truncate">
          Estás viendo la plataforma como{" "}
          <strong>{target.full_name ?? target.email}</strong>
        </span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void handleStop()}
        disabled={stopping}
        className="shrink-0"
      >
        {stopping ? <Spinner size="sm" className="mr-1" /> : null}
        Volver a mi cuenta
      </Button>
    </div>
  );
}

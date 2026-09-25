/**
 * Editar el contenido de un informe YA generado.
 *
 * `generated_reports` era inmutable y cada corrección —un nombre mal escrito,
 * una fecha— exigía una migración versionada; ya van tres. La mig
 * 20262510000000 abrió la puerta (policy de UPDATE acotada al docente del
 * curso y a Admin/SA, candado de columnas y rastro en auditoría) y esto es su
 * pantalla.
 *
 * Tres decisiones que no se deducen del código:
 *
 *  - Se edita el HTML **crudo**, no el renderizado. La vista normal del
 *    informe pasa por `renderizarRanuras`, que DIBUJA las firmas puestas
 *    dentro de los recuadros; si se editara eso, al guardar se persistirían
 *    las firmas como parte del documento y las ranuras dejarían de ser
 *    ranuras. Acá se toma `r.html` tal cual sale de la base.
 *
 *  - No se puede guardar si se perdió una ranura de firma (`editar-html.ts`).
 *    Una ranura borrada deja huérfana la firma que ya estaba puesta: sigue en
 *    `report_signatures` y no tiene dónde dibujarse, o sea que el documento
 *    pierde una firma real sin avisar. Quitar a alguien es otra operación.
 *
 *  - El aviso de que hay firmas puestas va SIEMPRE visible cuando las hay, y
 *    no como confirmación al guardar. Desde que se retiró la alerta de
 *    «firmas sobre versiones distintas» —el Acuerdo es un documento vivo y
 *    cambiarlo no es una anomalía—, esto es lo único que le recuerda al
 *    docente que está tocando algo que otros ya firmaron.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FilePenLine, AlertTriangle } from "lucide-react";
import { RichTextEditor } from "./RichTextEditor";
import { ranurasPerdidas } from "./editar-html";

export interface InformeEditable {
  id: string;
  html: string;
  nombre: string;
  /** Cuántas firmas ya están PUESTAS. Solo para avisar; no bloquea. */
  firmasPuestas: number;
}

interface Props {
  informe: InformeEditable | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function EditReportHtmlDialog({ informe, onOpenChange, onSaved }: Props) {
  const { t } = useTranslation();
  const [html, setHtml] = useState("");
  const [guardando, setGuardando] = useState(false);

  // Re-hidrata al abrir: si el docente cancela y vuelve a entrar, no puede ver
  // el borrador viejo de otra sesión de edición.
  useEffect(() => {
    if (informe) setHtml(informe.html ?? "");
  }, [informe?.id, informe?.html]);

  if (!informe) return null;

  const perdidas = ranurasPerdidas(informe.html, html);
  const sucio = html !== (informe.html ?? "");

  const guardar = async () => {
    if (perdidas.length > 0) {
      toast.error(t("reportEdit.lostSlots", { count: perdidas.length }), { duration: 10000 });
      return;
    }
    setGuardando(true);
    try {
      // `generated_reports` no figura en los tipos generados (types.ts está
      // desactualizado respecto del esquema), así que se consulta con el mismo
      // escape que usa toda la ruta de Informes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any)
        .from("generated_reports")
        .update({ html })
        .eq("id", informe.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(t("reportEdit.saved"));
      onSaved();
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FilePenLine className="h-5 w-5 text-primary" />
            {t("reportEdit.title")}
          </DialogTitle>
          <DialogDescription>{informe.nombre}</DialogDescription>
        </DialogHeader>

        {informe.firmasPuestas > 0 && (
          <Alert className="border-amber-500/40 bg-amber-500/10 py-2.5">
            <AlertDescription className="text-2xs text-amber-800 dark:text-amber-300">
              {t("reportEdit.alreadySigned", { count: informe.firmasPuestas })}
            </AlertDescription>
          </Alert>
        )}

        {perdidas.length > 0 && (
          <Alert variant="destructive" className="py-2.5">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-2xs">
              {t("reportEdit.lostSlots", { count: perdidas.length })}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto">
          <RichTextEditor value={html} onChange={setHtml} />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={guardando}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void guardar()} disabled={guardando || !sucio || perdidas.length > 0}>
            {guardando && <Spinner size="sm" className="mr-1" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

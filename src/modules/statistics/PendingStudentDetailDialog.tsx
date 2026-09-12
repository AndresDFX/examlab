import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { PENDING_KINDS, type PendingKind, type StudentPendingRow } from "./pending-students";

/**
 * Detalle de pendientes de UN estudiante puntual, desglosado POR CURSO. Sin
 * esto, la tabla solo muestra un total agregado — un estudiante con 2
 * pendientes en un curso y 1 en otro se ve idéntico a uno con 3 en el mismo
 * curso, y el docente no puede saber a qué curso ir a buscarlo.
 */
export function PendingStudentDetailDialog({
  row,
  open,
  onOpenChange,
}: {
  row: StudentPendingRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const email = row?.institutionalEmail || row?.personalEmail || null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("statistics.pendingDetailTitle", { name: row?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {email ?? t("statistics.pendingDetailNoEmail")}
          </DialogDescription>
        </DialogHeader>
        {row && (
          <div className="space-y-3 max-h-[60dvh] overflow-y-auto">
            {row.byCourse.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("statistics.pendingDetailEmpty")}</p>
            ) : (
              row.byCourse.map((c) => (
                <div key={c.courseId} className="rounded-md border p-3 space-y-2">
                  <p className="text-sm font-medium truncate">{c.courseName}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {PENDING_KINDS.map((kind) => {
                      const n = c[kind];
                      if (n <= 0) return null;
                      return (
                        <Badge key={kind} variant="outline" className="text-xs">
                          {kindLabel(kind, t)}: {n}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function kindLabel(kind: PendingKind, t: (key: string) => string): string {
  switch (kind) {
    case "firma":
      return t("statistics.pendingKindFirma");
    case "encuesta":
      return t("statistics.pendingKindEncuesta");
    case "examen":
      return t("statistics.pendingKindExamen");
    case "taller":
      return t("statistics.pendingKindTaller");
    case "proyecto":
      return t("statistics.pendingKindProyecto");
  }
}

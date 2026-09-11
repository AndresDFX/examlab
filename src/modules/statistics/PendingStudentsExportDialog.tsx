import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { usePrintBrand } from "@/modules/polls/use-print-brand";
import { downloadReportAsWord, fileStamp } from "@/modules/reports/report-download";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import { loadAllStudentsPending, type StudentPendingRow } from "./pending-students";
import { buildPendingReportHtml } from "./pending-export";

/**
 * Diálogo previo a exportar el informe de "Pendientes por estudiante".
 *
 * Carga el UNIVERSO completo del alcance (no solo los que tienen pendiente —
 * ver `loadAllStudentsPending`), deja al docente EXCLUIR estudiantes puntuales
 * (todos incluidos por defecto), y recién al confirmar genera el .docx.
 */
export function PendingStudentsExportDialog({
  open,
  onOpenChange,
  courses,
  scopeLabel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Mismo alcance que ya tiene el panel: un curso, o "todos" ya filtrados. */
  courses: ReadonlyArray<{ id: string; name: string }>;
  /** Texto ya armado por el caller: nombre del curso, o "Todos los cursos — periodo X". */
  scopeLabel: string;
}) {
  const { t } = useTranslation();
  const brand = usePrintBrand();
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [rows, setRows] = useState<StudentPendingRow[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    loadAllStudentsPending(courses)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setExcluded(new Set());
      })
      .catch((e) => {
        if (cancelled) return;
        toast.error(friendlyError(e, t("statistics.pendingExportLoadError")));
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, courses.map((c) => c.id).sort().join(",")]);

  const includedCount = rows.length - excluded.size;
  const allExcluded = rows.length > 0 && excluded.size === rows.length;

  const toggleAll = () => {
    setExcluded(allExcluded ? new Set() : new Set(rows.map((r) => r.userId)));
  };
  const toggleOne = (userId: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const scopeCourseNames = useMemo(() => courses.map((c) => c.name).join(", "), [courses]);

  const handleGenerate = async () => {
    if (generating) return;
    const included = rows.filter((r) => !excluded.has(r.userId));
    if (included.length === 0) {
      toast.error(t("statistics.pendingExportNoneSelected"));
      return;
    }
    setGenerating(true);
    try {
      const html = buildPendingReportHtml(included, excluded.size, {
        brand,
        scopeLabel: scopeLabel || scopeCourseNames,
        generatedAtLabel: formatDateTime(new Date()),
        labels: {
          title: t("statistics.pendingExportDocTitle"),
          scope: t("statistics.pendingExportDocScope"),
          generatedAt: t("statistics.pendingExportDocGeneratedAt"),
          colStudent: t("statistics.pendingColStudent"),
          colCourses: t("statistics.pendingColCourses"),
          colFirma: t("statistics.pendingKindFirma"),
          colEncuesta: t("statistics.pendingKindEncuesta"),
          colExamen: t("statistics.pendingKindExamen"),
          colTaller: t("statistics.pendingKindTaller"),
          colProyecto: t("statistics.pendingKindProyecto"),
          colTotal: t("statistics.pendingColTotal"),
          upToDate: t("statistics.pendingExportUpToDate"),
          excludedNote: (n) => t("statistics.pendingExportExcludedNote", { count: n }),
        },
      });
      await downloadReportAsWord(html, {
        templateName: t("statistics.pendingExportDocTitle"),
        courseName: scopeCourseNames,
        stamp: fileStamp(new Date()),
      });
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e, t("statistics.pendingExportGenerateError")));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !generating && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("statistics.pendingExportTitle")}</DialogTitle>
          <DialogDescription>{t("statistics.pendingExportDesc", { scope: scopeLabel })}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="py-8 flex justify-center">
            <Spinner size="md" />
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {t("statistics.pendingExportSelectedCount", {
                  included: includedCount,
                  total: rows.length,
                })}
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={toggleAll} disabled={rows.length === 0}>
                {allExcluded ? t("common.selectAll") : t("common.deselectAll")}
              </Button>
            </div>
            <div className="border rounded-md max-h-64 overflow-y-auto divide-y">
              {rows.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{t("statistics.pendingExportEmpty")}</p>
              ) : (
                rows.map((r) => {
                  const checked = !excluded.has(r.userId);
                  return (
                    <label
                      key={r.userId}
                      className="flex items-center gap-2 px-3 py-2 text-sm cursor-pointer hover:bg-accent"
                    >
                      <Checkbox checked={checked} onCheckedChange={() => toggleOne(r.userId)} />
                      <span className="flex-1 truncate">{r.name}</span>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {r.total === 0
                          ? t("statistics.pendingExportUpToDate")
                          : t("statistics.pendingExportPendingCount", { count: r.total })}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={generating}>
            {t("common.cancel")}
          </Button>
          <Button type="button" onClick={handleGenerate} disabled={loading || generating || rows.length === 0}>
            {generating ? <Spinner size="sm" className="mr-2" /> : null}
            {t("statistics.pendingExportGenerate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

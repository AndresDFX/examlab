import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardList, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
  SortableHead,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { BadgeOverflow } from "@/components/ui/badge-overflow";
import { TableEmpty } from "@/components/ui/empty-state";
import { SectionLoader } from "@/components/ui/loaders";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { friendlyError } from "@/shared/lib/db-errors";
import { toast } from "sonner";
import { loadPendingStudents, type StudentPendingRow } from "./pending-students";
import { PendingStudentsExportDialog } from "./PendingStudentsExportDialog";

/**
 * Panel "Pendientes por estudiante". Consume `loadPendingStudents` sobre el
 * conjunto de cursos que la pantalla ya tiene acotado (alcance del docente +
 * filtro de periodo/asignatura). Funciona igual con UN curso o con TODOS.
 */
export function PendingStudentsPanel({
  courses,
  scopeLabel,
}: {
  /** Cursos en alcance (id + nombre). El panel re-carga cuando cambia el set. */
  courses: ReadonlyArray<{ id: string; name: string }>;
  /** Texto legible del alcance para el diálogo de export (ej. nombre del
   *  curso, o "Todos los cursos — periodo X"). Si se omite, se arma de
   *  `courses`. */
  scopeLabel?: string;
}) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<StudentPendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  // Concatenar los ids es la clave del effect: re-carga cuando cambia el
  // conjunto de cursos (elegir otro curso, cambiar periodo/asignatura).
  const key = useMemo(() => courses.map((c) => c.id).sort().join(","), [courses]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadPendingStudents(courses)
      .then((r) => {
        if (!cancelled) setRows(r);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("loadPendingStudents failed:", e);
        toast.error(friendlyError(e, t("statistics.pendingLoadError")));
        setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const sort = useTableSort(rows, {
    columns: {
      name: (r) => r.name,
      total: (r) => r.total,
    },
    defaultSort: { key: "total", dir: "desc" },
    storageKey: "examlab_sort:teacher_pending",
  });
  const pag = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_pending",
    resetKey: `${key}|${sort.resetKey}`,
  });

  return (
    <Card>
      <CardHeader className="p-4 flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-amber-500" />
            {t("statistics.pendingTitle")}
          </CardTitle>
          <CardDescription>{t("statistics.pendingDesc")}</CardDescription>
        </div>
        <Button type="button" size="sm" onClick={() => setExportOpen(true)} className="shrink-0">
          <Download className="h-4 w-4 mr-1.5" />
          {t("statistics.pendingExportButton")}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        {loading ? (
          <div className="p-6">
            <SectionLoader />
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead sortKey="name" sort={sort} className="min-w-40">
                      {t("statistics.pendingColStudent")}
                    </SortableHead>
                    <TableHead className="hidden md:table-cell">
                      {t("statistics.pendingColCourses")}
                    </TableHead>
                    <TableHead className="text-center hidden sm:table-cell">
                      {t("statistics.pendingKindFirma")}
                    </TableHead>
                    <TableHead className="text-center hidden sm:table-cell">
                      {t("statistics.pendingKindEncuesta")}
                    </TableHead>
                    <TableHead className="text-center hidden sm:table-cell">
                      {t("statistics.pendingKindExamen")}
                    </TableHead>
                    <TableHead className="text-center hidden sm:table-cell">
                      {t("statistics.pendingKindTaller")}
                    </TableHead>
                    <TableHead className="text-center hidden sm:table-cell">
                      {t("statistics.pendingKindProyecto")}
                    </TableHead>
                    <SortableHead sortKey="total" sort={sort} className="text-center w-20">
                      {t("statistics.pendingColTotal")}
                    </SortableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pag.paginatedItems.length === 0 ? (
                    <TableEmpty
                      colSpan={8}
                      icon={ClipboardList}
                      text={t("statistics.pendingEmpty")}
                      hint={t("statistics.pendingEmptyHint")}
                    />
                  ) : (
                    pag.paginatedItems.map((r) => (
                      <TableRow key={r.userId}>
                        <TableCell className="font-medium">
                          <span className="truncate block max-w-[16rem]">{r.name}</span>
                          {/* En mobile los conteos por tipo se ocultan; el
                              desglose va como chips debajo del nombre. */}
                          <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
                            <CountChip n={r.firma} label={t("statistics.pendingKindFirma")} />
                            <CountChip n={r.encuesta} label={t("statistics.pendingKindEncuesta")} />
                            <CountChip n={r.examen} label={t("statistics.pendingKindExamen")} />
                            <CountChip n={r.taller} label={t("statistics.pendingKindTaller")} />
                            <CountChip n={r.proyecto} label={t("statistics.pendingKindProyecto")} />
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <BadgeOverflow items={r.courses} max={2} />
                        </TableCell>
                        <CountCell n={r.firma} />
                        <CountCell n={r.encuesta} />
                        <CountCell n={r.examen} />
                        <CountCell n={r.taller} />
                        <CountCell n={r.proyecto} />
                        <TableCell className="text-center">
                          <Badge variant="secondary" className="tabular-nums">
                            {r.total}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <div className="p-3">
              <DataPagination state={pag} entityNamePlural={t("statistics.pendingEntity")} />
            </div>
          </>
        )}
      </CardContent>
      <PendingStudentsExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        courses={courses}
        scopeLabel={scopeLabel ?? (courses.length === 1 ? courses[0]?.name ?? "" : t("statistics.allCourses"))}
      />
    </Card>
  );
}

function CountCell({ n }: { n: number }) {
  return (
    <TableCell className="text-center hidden sm:table-cell tabular-nums">
      {n > 0 ? n : <span className="text-muted-foreground">—</span>}
    </TableCell>
  );
}

function CountChip({ n, label }: { n: number; label: string }) {
  if (n <= 0) return null;
  return (
    <Badge variant="outline" className="text-3xs">
      {label}: {n}
    </Badge>
  );
}

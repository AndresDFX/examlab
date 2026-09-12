import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardList, Download, Eye, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RowAction } from "@/components/ui/row-action";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
  SortableHead,
} from "@/components/ui/table";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { cn } from "@/shared/lib/utils";
import { BadgeOverflow } from "@/components/ui/badge-overflow";
import { TableEmpty } from "@/components/ui/empty-state";
import { SectionLoader } from "@/components/ui/loaders";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { useTableSort } from "@/hooks/use-table-sort";
import { friendlyError } from "@/shared/lib/db-errors";
import { toast } from "sonner";
import { PENDING_KINDS, loadPendingStudents, type PendingKind, type StudentPendingRow } from "./pending-students";
import { PendingStudentsExportDialog } from "./PendingStudentsExportDialog";
import { PendingStudentDetailDialog } from "./PendingStudentDetailDialog";

/** Etiqueta i18n de cada tipo de pendiente — un único mapa que alimenta los
 *  chips de filtro, la cabecera de la tabla y los chips mobile. */
const KIND_LABEL_KEY: Record<PendingKind, string> = {
  firma: "statistics.pendingKindFirma",
  encuesta: "statistics.pendingKindEncuesta",
  examen: "statistics.pendingKindExamen",
  taller: "statistics.pendingKindTaller",
  proyecto: "statistics.pendingKindProyecto",
};

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
  const [search, setSearch] = useState("");
  const [detailRow, setDetailRow] = useState<StudentPendingRow | null>(null);
  // Tipos de pendiente a EXCLUIR del cálculo — filtro de SESIÓN (se resetea al
  // recargar la página, mismo criterio que el buscador): un docente que en
  // ESTE alcance no quiere que, por ejemplo, "Taller" cuente como pendiente
  // (talleres opcionales, no ponderan la nota) lo destilda mientras lo está
  // viendo. Vacío por defecto = comportamiento previo (los 5 tipos cuentan).
  const [excludedKinds, setExcludedKinds] = useState<Set<PendingKind>>(new Set());
  const toggleKind = (kind: PendingKind) => {
    setExcludedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };
  // Concatenar los ids es la clave del effect: re-carga cuando cambia el
  // conjunto de cursos (elegir otro curso, cambiar periodo/asignatura) o el
  // filtro de tipos.
  const key = useMemo(() => courses.map((c) => c.id).sort().join(","), [courses]);
  const excludedKindsKey = useMemo(() => [...excludedKinds].sort().join(","), [excludedKinds]);
  const includedKinds = useMemo(
    () => PENDING_KINDS.filter((k) => !excludedKinds.has(k)),
    [excludedKinds],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadPendingStudents(courses, excludedKinds)
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
  }, [key, excludedKindsKey]);

  // Filtro por nombre O correo (institucional/personal) — client-side sobre
  // los datos ya cargados, que vienen acotados al alcance elegido.
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      if (r.name.toLowerCase().includes(q)) return true;
      if (r.institutionalEmail?.toLowerCase().includes(q)) return true;
      if (r.personalEmail?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [rows, search]);

  const sort = useTableSort(filteredRows, {
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
    resetKey: `${key}|${search}|${sort.resetKey}`,
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
            <div className="px-4 pb-3 space-y-2">
              <div className="relative max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("statistics.pendingSearchPlaceholder")}
                  className="pl-8"
                  aria-label={t("statistics.pendingSearchPlaceholder")}
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">{t("statistics.pendingKindsFilterLabel")}</span>
                {PENDING_KINDS.map((kind) => {
                  const included = !excludedKinds.has(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => toggleKind(kind)}
                      aria-pressed={included}
                      className={cn(
                        badgeVariants({ variant: included ? "secondary" : "outline" }),
                        "cursor-pointer select-none",
                        !included && "text-muted-foreground",
                      )}
                    >
                      {t(KIND_LABEL_KEY[kind])}
                    </button>
                  );
                })}
              </div>
            </div>
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
                    {includedKinds.map((kind) => (
                      <TableHead key={kind} className="text-center hidden sm:table-cell">
                        {t(KIND_LABEL_KEY[kind])}
                      </TableHead>
                    ))}
                    <SortableHead sortKey="total" sort={sort} className="text-center w-20">
                      {t("statistics.pendingColTotal")}
                    </SortableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pag.paginatedItems.length === 0 ? (
                    <TableEmpty
                      colSpan={4 + includedKinds.length}
                      icon={ClipboardList}
                      text={search ? t("statistics.pendingSearchEmpty") : t("statistics.pendingEmpty")}
                      hint={search ? undefined : t("statistics.pendingEmptyHint")}
                    />
                  ) : (
                    pag.paginatedItems.map((r) => (
                      <TableRow key={r.userId}>
                        <TableCell className="font-medium">
                          <span className="truncate block max-w-[16rem]">{r.name}</span>
                          {/* En mobile los conteos por tipo se ocultan; el
                              desglose va como chips debajo del nombre. */}
                          <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
                            {includedKinds.map((kind) => (
                              <CountChip key={kind} n={r[kind]} label={t(KIND_LABEL_KEY[kind])} />
                            ))}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell">
                          <BadgeOverflow items={r.courses} max={2} />
                        </TableCell>
                        {includedKinds.map((kind) => (
                          <CountCell key={kind} n={r[kind]} />
                        ))}
                        <TableCell className="text-center">
                          <Badge variant="secondary" className="tabular-nums">
                            {r.total}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <RowAction
                            label={t("statistics.pendingViewDetail")}
                            icon={Eye}
                            onClick={() => setDetailRow(r)}
                          />
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
        excludedKinds={excludedKinds}
      />
      <PendingStudentDetailDialog
        row={detailRow}
        open={!!detailRow}
        onOpenChange={(v) => {
          if (!v) setDetailRow(null);
        }}
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

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Search } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { usePrintBrand } from "@/modules/polls/use-print-brand";
import { downloadReportAsWord, printReportHtml, fileStamp } from "@/modules/reports/report-download";
import { friendlyError } from "@/shared/lib/db-errors";
import { formatDateTime } from "@/shared/lib/format";
import {
  loadAllStudentsPending,
  STUDENT_EXTRA_FIELDS,
  type StudentExtraField,
  type StudentPendingRow,
} from "./pending-students";
import { buildPendingReportHtml } from "./pending-export";

/** Etiqueta i18n de cada campo opcional — un único mapa que alimenta tanto el
 *  checkbox del diálogo como la columna del .docx. */
const FIELD_LABEL_KEY: Record<StudentExtraField, string> = {
  codigo: "statistics.pendingFieldCodigo",
  documento: "statistics.pendingFieldDocumento",
  institutional_email: "statistics.pendingFieldInstitutionalEmail",
  personal_email: "statistics.pendingFieldPersonalEmail",
  programa: "statistics.pendingFieldPrograma",
};

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
  const [generating, setGenerating] = useState<"word" | "pdf" | null>(null);
  const [rows, setRows] = useState<StudentPendingRow[]>([]);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  /** Campos de `profiles` a sumar como columna, además del nombre. Vacío por
   *  defecto — mismo informe que antes de que este control existiera. */
  const [extraFields, setExtraFields] = useState<Set<StudentExtraField>>(new Set());
  // Solo aplica con 2+ cursos en el alcance. Reportado como "excluí a los al
  // día pero igual aparecen": el docente esperaba que "Excluir al día"
  // (total GLOBAL) también los sacara de una sección puntual donde están al
  // día, aunque deban algo en OTRO curso del informe — eso es dato correcto
  // (sigue debiendo en otro curso), no un bug, pero confundía. Esta opción
  // deja al docente elegir el roster completo por curso (default, como
  // siempre) o "solo quien debe algo EN esa sección".
  const [hideUpToDatePerCourse, setHideUpToDatePerCourse] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    loadAllStudentsPending(courses)
      .then((r) => {
        if (cancelled) return;
        setRows(r);
        setExcluded(new Set());
        setSearch("");
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
  /** Acción rápida: suma de un tirón a los "al día" (total=0) a la exclusión,
   *  sin destildarlos uno por uno — no toca lo que el docente ya haya elegido
   *  a mano sobre el resto. */
  const excludeUpToDate = () => {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const r of rows) if (r.total === 0) next.add(r.userId);
      return next;
    });
  };
  const hasUpToDateIncluded = rows.some((r) => r.total === 0 && !excluded.has(r.userId));

  // Filtro por nombre O correo (institucional/personal) — SOLO visual: acota
  // qué filas se muestran/scrollean, nunca qué está incluido/excluido. Mismo
  // criterio que el buscador de la tabla en pantalla (PendingStudentsPanel).
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

  const toggleField = (field: StudentExtraField) => {
    setExtraFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  };

  const scopeCourseNames = useMemo(() => courses.map((c) => c.name).join(", "), [courses]);
  /** Nombre del archivo: con UN solo curso, su nombre (como siempre). Con
   *  varios ("Todos los cursos", con o sin filtro de periodo/asignatura),
   *  `scopeCourseNames` concatenaría TODOS los nombres de curso en un nombre
   *  de archivo gigante e ilegible — se usa el `scopeLabel` corto que el
   *  caller ya arma ("Todos los cursos — periodo X") en su lugar. */
  const fileScopeName =
    courses.length === 1 ? scopeCourseNames : scopeLabel || t("statistics.allCourses");

  const buildHtml = (included: StudentPendingRow[]) =>
    buildPendingReportHtml(included, excluded.size, {
      brand,
      scopeLabel: scopeLabel || scopeCourseNames,
      generatedAtLabel: formatDateTime(new Date()),
      extraFields: [...extraFields],
      courses,
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
        fieldLabels: {
          codigo: t(FIELD_LABEL_KEY.codigo),
          documento: t(FIELD_LABEL_KEY.documento),
          institutional_email: t(FIELD_LABEL_KEY.institutional_email),
          personal_email: t(FIELD_LABEL_KEY.personal_email),
          programa: t(FIELD_LABEL_KEY.programa),
        },
        courseSectionTitle: (name) => t("statistics.pendingExportCourseSection", { course: name }),
        courseSectionAllUpToDate: t("statistics.pendingExportCourseSectionAllUpToDate"),
      },
      hideUpToDatePerCourse: courses.length > 1 ? hideUpToDatePerCourse : false,
    });

  const includedRows = () => {
    const included = rows.filter((r) => !excluded.has(r.userId));
    if (included.length === 0) {
      toast.error(t("statistics.pendingExportNoneSelected"));
      return null;
    }
    return included;
  };

  const handleGenerateWord = async () => {
    if (generating) return;
    const included = includedRows();
    if (!included) return;
    setGenerating("word");
    try {
      const html = buildHtml(included);
      await downloadReportAsWord(html, {
        templateName: t("statistics.pendingExportDocTitle"),
        courseName: fileScopeName,
        stamp: fileStamp(new Date()),
      });
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e, t("statistics.pendingExportGenerateError")));
    } finally {
      setGenerating(null);
    }
  };

  const handleGeneratePdf = () => {
    if (generating) return;
    const included = includedRows();
    if (!included) return;
    setGenerating("pdf");
    try {
      // NO cerrar este diálogo acá (a diferencia de Word, que sí cierra tras
      // su `await`): `printReportHtml` dispara `window.print()` de forma
      // DIFERIDA (dentro del `onload` del iframe, ~150ms después), y ese
      // `print()` bloquea el hilo de JS hasta que el usuario acepta/cancela
      // el diálogo nativo. Si en ese mismo instante este `<Dialog>` está a
      // mitad de su animación de cierre (`duration-200` en dialog.tsx),
      // Radix nunca llega a procesar el `animationend` que necesita para
      // desmontar el overlay — y el overlay `fixed inset-0` invisible pero
      // aún montado queda bloqueando los clics del resto de la página
      // ("modal trabado" reportado al cancelar imprimir). Ningún otro call
      // site de `printReportHtml` (reportes, resultados de encuesta) cierra
      // un Dialog propio alrededor de la llamada — se deja este también sin
      // auto-cerrar; el docente lo cierra con "Cancelar" o la X.
      printReportHtml(buildHtml(included));
    } catch (e) {
      toast.error(friendlyError(e, t("statistics.pendingExportGenerateError")));
    } finally {
      setGenerating(null);
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
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">
                {t("statistics.pendingExportSelectedCount", {
                  included: includedCount,
                  total: rows.length,
                })}
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={excludeUpToDate}
                  disabled={rows.length === 0 || !hasUpToDateIncluded}
                >
                  {t("statistics.pendingExportExcludeUpToDate")}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={toggleAll} disabled={rows.length === 0}>
                  {allExcluded ? t("common.selectAll") : t("common.deselectAll")}
                </Button>
              </div>
            </div>
            {courses.length > 1 && (
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox
                  checked={hideUpToDatePerCourse}
                  onCheckedChange={(v) => setHideUpToDatePerCourse(v === true)}
                />
                <span>{t("statistics.pendingExportHideUpToDatePerCourse")}</span>
              </label>
            )}
            <div className="rounded-md border p-3 space-y-2">
              <p className="text-sm font-medium">{t("statistics.pendingExportFieldsLabel")}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {STUDENT_EXTRA_FIELDS.map((field) => (
                  <label key={field} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox checked={extraFields.has(field)} onCheckedChange={() => toggleField(field)} />
                    <span>{t(FIELD_LABEL_KEY[field])}</span>
                  </label>
                ))}
              </div>
            </div>
            {rows.length > 0 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("statistics.pendingSearchPlaceholder")}
                  className="pl-8"
                  aria-label={t("statistics.pendingSearchPlaceholder")}
                />
              </div>
            )}
            <div className="border rounded-md max-h-64 overflow-y-auto divide-y">
              {rows.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{t("statistics.pendingExportEmpty")}</p>
              ) : filteredRows.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{t("statistics.pendingSearchEmpty")}</p>
              ) : (
                filteredRows.map((r) => {
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
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={!!generating}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleGeneratePdf}
            disabled={loading || !!generating || rows.length === 0}
          >
            {generating === "pdf" ? <Spinner size="sm" className="mr-2" /> : null}
            {t("statistics.pendingExportGeneratePdf")}
          </Button>
          <Button
            type="button"
            onClick={handleGenerateWord}
            disabled={loading || !!generating || rows.length === 0}
          >
            {generating === "word" ? <Spinner size="sm" className="mr-2" /> : null}
            {t("statistics.pendingExportGenerate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

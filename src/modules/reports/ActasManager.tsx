/**
 * Gestor de Actas oficiales del curso.
 *
 * Se monta arriba de la lista de plantillas en /app/teacher/reports.
 * Permite al docente:
 *   - Ver lista de actas ya generadas para sus cursos.
 *   - Generar una nueva acta (RPC `generate_course_acta`).
 *   - Eliminar un acta (RPC respaldada por RLS DELETE policy).
 *   - Imprimir un acta (usa la plantilla seed "Acta de finalización
 *     del curso" filtrada al course_id del acta).
 *
 * NOTA: la acta es un registro legal — guarda la cohorte de estudiantes
 * matriculados al cierre + metadata del curso. La RENDER del PDF
 * recalcula notas con datos vivos (`buildReportContext`). Para acta
 * 100% inmutable habría que congelar notas también, pero requiere
 * replicar `computeWeightedGrade` en SQL.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { LoadingOverlay } from "@/components/ui/loading-overlay";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { Badge } from "@/components/ui/badge";
import { DateCell } from "@/components/ui/date-cell";
import { HelpHint } from "@/components/ui/help-hint";
import { SearchInput } from "@/components/ui/search-input";
import { useTableSort } from "@/hooks/use-table-sort";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SortableHead,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { Stamp, Plus, Trash2, FileText } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { logEvent } from "@/shared/lib/audit";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Acta {
  id: string;
  course_id: string;
  curso_nombre: string;
  docente_nombre: string;
  periodo_codigo: string | null;
  total_estudiantes: number;
  total_aprobados: number;
  total_reprobados: number;
  generated_at: string;
  integrity_hash: string;
}

interface Course {
  id: string;
  name: string;
}

interface Props {
  /** Callback opcional cuando el docente pide imprimir un acta —
   *  el route padre abre el dialog del generador apuntando al acta
   *  template + ese curso. */
  onPrintActa: (acta: Acta) => void;
}

export function ActasManager({ onPrintActa }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [actas, setActas] = useState<Acta[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");

  // Dialog para generar acta nueva.
  const [genOpen, setGenOpen] = useState(false);
  const [genCourseId, setGenCourseId] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  // Eliminar un acta es una acción de fila sin feedback propio: guardamos el
  // id en curso para deshabilitar el menú y no disparar dos DELETE.
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // `isCancelled` opcional: cuando el effect lo pasa, no hacemos setState
  // tras un desmontaje (convención del repo para effects async).
  const load = async (isCancelled?: () => boolean) => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    const [{ data: a, error: aErr }, { data: c, error: cErr }] = await Promise.all([
      db
        .from("course_actas")
        .select(
          "id, course_id, curso_nombre, docente_nombre, periodo_codigo, total_estudiantes, total_aprobados, total_reprobados, generated_at, integrity_hash",
        )
        .order("generated_at", { ascending: false }),
      db.from("courses").select("id, name").is("deleted_at", null).order("name"),
    ]);
    if (isCancelled?.()) return;
    if (aErr) {
      setLoadError(friendlyError(aErr, t("hc_modulesReportsActasManager.errorLoadActas")));
      setLoading(false);
      return;
    }
    if (cErr) {
      setLoadError(friendlyError(cErr, t("hc_modulesReportsActasManager.errorLoadCourses")));
      setLoading(false);
      return;
    }
    setActas((a ?? []) as Acta[]);
    setCourses((c ?? []) as Course[]);
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    void load(() => cancelled);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  // Flujo obligatorio del design system: filtrar → ORDENAR → paginar.
  // Un docente/Admin con muchos cursos acumula un acta por curso y por
  // periodo, así que el listado crece sin techo.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return actas;
    return actas.filter(
      (a) =>
        a.curso_nombre.toLowerCase().includes(q) ||
        (a.periodo_codigo ?? "").toLowerCase().includes(q) ||
        a.docente_nombre.toLowerCase().includes(q),
    );
  }, [actas, search]);

  const sort = useTableSort(filtered, {
    columns: {
      curso: (a) => a.curso_nombre,
      periodo: (a) => a.periodo_codigo,
      docente: (a) => a.docente_nombre,
      estudiantes: (a) => a.total_estudiantes,
      // Tasa de aprobación como fracción — ordena por el % que muestra la
      // celda, no por el conteo bruto de aprobados.
      aprobacion: (a) =>
        a.total_estudiantes > 0 ? a.total_aprobados / a.total_estudiantes : null,
      generado: (a) => a.generated_at,
    },
    // Mismo orden que trae la query (generated_at DESC): lo más reciente
    // arriba.
    defaultSort: { key: "generado", dir: "desc" },
    storageKey: "examlab_sort:reports_actas",
  });

  const pagination = usePagination(sort.sorted, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:reports_actas",
    resetKey: `${search}|${sort.resetKey}`,
  });

  // Cursos que aún NO tienen acta — opciones del Select.
  const coursesWithoutActa = useMemo(() => {
    const taken = new Set(actas.map((a) => a.course_id));
    return courses.filter((c) => !taken.has(c.id));
  }, [courses, actas]);

  const openGenerate = () => {
    setGenCourseId(coursesWithoutActa[0]?.id ?? "");
    setGenOpen(true);
  };

  const handleGenerate = async () => {
    if (!genCourseId) return;
    if (generating) return; // anti doble-submit: el acta es única por curso+periodo
    setGenerating(true);
    try {
      const { data, error } = await db.rpc("generate_course_acta", { p_course_id: genCourseId });
      if (error) {
        // Log del error REAL (code/message/hint/details) para diagnóstico — el
        // toast traduce a un mensaje amigable, pero la consola guarda la causa.
        // eslint-disable-next-line no-console
        console.error("[acta] generate_course_acta falló:", error);
        // Surface también el detalle crudo (message/hint) cuando exista: el toast
        // genérico solo no decía POR QUÉ falló (ej. acta ya existente, datos).
        const e = error as { message?: string; hint?: string };
        const detail = (e.hint || e.message || "").trim();
        const friendly = friendlyError(error, t("hc_modulesReportsActasManager.errorGenerateActa"));
        toast.error(detail && !friendly.includes(detail) ? `${friendly} — ${detail}` : friendly, {
          duration: 12000,
        });
        return;
      }
      // Acta es registro institucional — `warning` para que destaque en
      // el módulo de Auditoría junto a otras acciones críticas.
      const course = courses.find((c) => c.id === genCourseId);
      void logEvent({
        action: "acta.generated",
        category: "academic",
        severity: "warning",
        entityType: "course_acta",
        entityId: String(data),
        entityName: course?.name ?? t("hc_modulesReportsActasManager.actaEntityName"),
        courseId: genCourseId,
        courseName: course?.name ?? null,
      });
      toast.success(
        i18n.t("toast.modules_reports_ActasManager.actaGenerated", {
          defaultValue: "Acta generada (ID: {{actaId}}…)",
          actaId: String(data).slice(0, 8),
        }),
      );
      setGenOpen(false);
      void load();
    } catch (e) {
      // CRÍTICO: si el rpc lanza (red caída, sesión expirada) sin este
      // try/finally el `LoadingOverlay` quedaba pegado tapando toda la
      // pantalla, sin salida más que recargar.
      toast.error(friendlyError(e, t("hc_modulesReportsActasManager.errorGenerateActa")), {
        duration: 12000,
      });
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (acta: Acta) => {
    if (deletingId) return; // anti doble-submit
    const ok = await confirm({
      title: t("hc_modulesReportsActasManager.deleteConfirmTitle", { curso: acta.curso_nombre }),
      description: t("hc_modulesReportsActasManager.deleteConfirmDescription"),
      confirmLabel: t("hc_modulesReportsActasManager.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    setDeletingId(acta.id);
    try {
      const { error } = await db.from("course_actas").delete().eq("id", acta.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "acta.deleted",
        category: "academic",
        // Eliminar un acta oficial es destructivo — log con warning para
        // dejar rastro claro de quién/cuándo.
        severity: "warning",
        entityType: "course_acta",
        entityId: acta.id,
        entityName: acta.curso_nombre,
        courseId: acta.course_id,
        courseName: acta.curso_nombre,
        metadata: { integrity_hash: acta.integrity_hash, periodo: acta.periodo_codigo },
      });
      toast.success(
        i18n.t("toast.modules_reports_ActasManager.actaDeleted", {
          defaultValue: "Acta eliminada",
        }),
      );
      void load();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Card>
      {generating && (
        <LoadingOverlay
          title={t("hc_modulesReportsActasManager.generatingTitle")}
          subtitle={t("hc_modulesReportsActasManager.generatingSubtitle")}
        />
      )}
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 flex-wrap">
        <CardTitle className="text-base flex items-center gap-2">
          <Stamp className="h-4 w-4 text-amber-500" />
          {t("hc_modulesReportsActasManager.officialActas")}
          <HelpHint>{t("help.actaImmutableRegistry")}</HelpHint>
        </CardTitle>
        <Button
          size="sm"
          onClick={openGenerate}
          disabled={coursesWithoutActa.length === 0}
          title={
            coursesWithoutActa.length === 0
              ? t("hc_modulesReportsActasManager.allCoursesHaveActa")
              : undefined
          }
        >
          <Plus className="h-3.5 w-3.5 mr-1" />
          {t("hc_modulesReportsActasManager.generateActa")}
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          /* Skeleton con el shape de la tabla (7 columnas) en lugar de un
             "Cargando…" suelto — el docente ve qué está por aparecer. */
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table fixed>
              <TableBody>
                <TableSkeleton cols={7} rows={4} />
              </TableBody>
            </Table>
          </div>
        ) : loadError ? (
          <ErrorState
            message={t("hc_modulesReportsActasManager.couldNotLoad")}
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="space-y-3">
            {/* Buscador por curso / período / docente. Solo cuando hay algo
                que buscar — con 0 actas el empty state ya explica el módulo. */}
            {actas.length > 0 && (
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder={t("actasManager.searchPlaceholder", {
                  defaultValue: "Buscar por curso, período o docente…",
                })}
              />
            )}
            <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
              <Table fixed resizable>
                <TableHeader>
                  <TableRow>
                    <SortableHead sortKey="curso" sort={sort} className="max-w-[260px]">{t("hc_modulesReportsActasManager.colCourse")}</SortableHead>
                    <SortableHead sortKey="periodo" sort={sort} className="hidden sm:table-cell w-28">{t("hc_modulesReportsActasManager.colPeriod")}</SortableHead>
                    <SortableHead sortKey="docente" sort={sort} className="hidden md:table-cell">{t("hc_modulesReportsActasManager.colTeacher")}</SortableHead>
                    <SortableHead sortKey="estudiantes" sort={sort} className="w-24 text-center">{t("hc_modulesReportsActasManager.colStudents")}</SortableHead>
                    <SortableHead sortKey="aprobacion" sort={sort} className="hidden sm:table-cell w-24 text-center">{t("hc_modulesReportsActasManager.colPassRate")}</SortableHead>
                    <SortableHead sortKey="generado" sort={sort} className="hidden sm:table-cell w-32">{t("hc_modulesReportsActasManager.colGenerated")}</SortableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sort.sorted.length === 0 ? (
                    actas.length > 0 ? (
                      <TableEmpty
                        colSpan={7}
                        text={t("actasManager.noMatches", {
                          defaultValue: "Sin coincidencias con la búsqueda.",
                        })}
                        hint={t("common.tryClearFilter")}
                      />
                    ) : (
                      <TableEmpty
                        colSpan={7}
                        text={t("hc_modulesReportsActasManager.emptyText")}
                        hint={t("hc_modulesReportsActasManager.emptyHint")}
                      />
                    )
                  ) : (
                    pagination.paginatedItems.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="font-medium">
                          <div className="truncate" title={a.curso_nombre}>
                            {a.curso_nombre}
                          </div>
                          <div className="text-3xs text-muted-foreground font-mono mt-0.5 truncate">
                            {a.integrity_hash.slice(0, 16)}…
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <Badge variant="outline" className="text-xs tabular-nums">
                            {a.periodo_codigo ?? "—"}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground" truncate title={a.docente_nombre}>
                          {a.docente_nombre}
                        </TableCell>
                        <TableCell className="text-center tabular-nums">
                          {a.total_estudiantes}
                        </TableCell>
                        <TableCell className="text-center hidden sm:table-cell">
                          {a.total_estudiantes > 0 ? (
                            <div className="flex flex-col items-center gap-0.5">
                              <span className="text-xs font-medium tabular-nums">
                                {Math.round((a.total_aprobados / a.total_estudiantes) * 100)}%
                              </span>
                              <span className="text-3xs text-muted-foreground tabular-nums">
                                {a.total_aprobados}/{a.total_estudiantes}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          <DateCell value={a.generated_at} variant="datetime" />
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              {
                                label: t("hc_modulesReportsActasManager.printActa"),
                                icon: FileText,
                                onClick: () => onPrintActa(a),
                              },
                              {
                                label: t("hc_modulesReportsActasManager.deleteActa"),
                                icon: Trash2,
                                tone: "destructive",
                                separatorBefore: true,
                                disabled: !!deletingId,
                                onClick: () => void handleDelete(a),
                              },
                            ]}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
            <DataPagination
              state={pagination}
              entityNamePlural={t("actasManager.entityNamePlural", { defaultValue: "actas" })}
            />
          </div>
        )}
      </CardContent>

      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("hc_modulesReportsActasManager.generateDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("hc_modulesReportsActasManager.generateDialogDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t("hc_modulesReportsActasManager.courseLabel")}</label>
            <Select value={genCourseId} onValueChange={setGenCourseId}>
              <SelectTrigger>
                <SelectValue placeholder={t("hc_modulesReportsActasManager.selectCoursePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {coursesWithoutActa.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setGenOpen(false)} disabled={generating}>
              {t("hc_modulesReportsActasManager.cancel")}
            </Button>
            <Button onClick={() => void handleGenerate()} disabled={generating || !genCourseId}>
              {generating && <Spinner size="sm" className="mr-2" />}
              {generating ? t("hc_modulesReportsActasManager.generating") : t("hc_modulesReportsActasManager.generate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

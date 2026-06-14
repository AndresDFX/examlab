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
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { Badge } from "@/components/ui/badge";
import { DateCell } from "@/components/ui/date-cell";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
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

  // Dialog para generar acta nueva.
  const [genOpen, setGenOpen] = useState(false);
  const [genCourseId, setGenCourseId] = useState<string>("");
  const [generating, setGenerating] = useState(false);

  const load = async () => {
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
      db.from("courses").select("id, name").order("name"),
    ]);
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
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

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
    setGenerating(true);
    const { data, error } = await db.rpc("generate_course_acta", { p_course_id: genCourseId });
    setGenerating(false);
    if (error) {
      toast.error(friendlyError(error, t("hc_modulesReportsActasManager.errorGenerateActa")));
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
  };

  const handleDelete = async (acta: Acta) => {
    const ok = await confirm({
      title: t("hc_modulesReportsActasManager.deleteConfirmTitle", { curso: acta.curso_nombre }),
      description: t("hc_modulesReportsActasManager.deleteConfirmDescription"),
      confirmLabel: t("hc_modulesReportsActasManager.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
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
  };

  return (
    <Card>
      {generating && (
        <LoadingOverlay
          title={t("hc_modulesReportsActasManager.generatingTitle")}
          subtitle={t("hc_modulesReportsActasManager.generatingSubtitle")}
        />
      )}
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
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
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> {t("hc_modulesReportsActasManager.loading")}
          </div>
        ) : loadError ? (
          <ErrorState
            message={t("hc_modulesReportsActasManager.couldNotLoad")}
            hint={loadError}
            onRetry={() => setRetryNonce((n) => n + 1)}
          />
        ) : (
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            <Table fixed resizable>
              <TableHeader>
                <TableRow>
                  <TableHead className="max-w-[260px]">{t("hc_modulesReportsActasManager.colCourse")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-28">{t("hc_modulesReportsActasManager.colPeriod")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("hc_modulesReportsActasManager.colTeacher")}</TableHead>
                  <TableHead className="w-24 text-center">{t("hc_modulesReportsActasManager.colStudents")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-24 text-center">{t("hc_modulesReportsActasManager.colPassRate")}</TableHead>
                  <TableHead className="hidden sm:table-cell w-32">{t("hc_modulesReportsActasManager.colGenerated")}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {actas.length === 0 ? (
                  <TableEmpty
                    colSpan={7}
                    text={t("hc_modulesReportsActasManager.emptyText")}
                    hint={t("hc_modulesReportsActasManager.emptyHint")}
                  />
                ) : (
                  actas.map((a) => (
                    <TableRow key={a.id}>
                      <TableCell className="font-medium">
                        <div className="truncate" title={a.curso_nombre}>
                          {a.curso_nombre}
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
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
                            <span className="text-[10px] text-muted-foreground tabular-nums">
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
              {generating ? t("hc_modulesReportsActasManager.generating") : t("hc_modulesReportsActasManager.generate")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

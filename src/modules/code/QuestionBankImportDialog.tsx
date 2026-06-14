/**
 * Dialog reutilizable para importar preguntas del banco al editor de
 * examen/taller/proyecto. Estilo gmail attachment: buscar, filtrar,
 * marcar checkboxes, confirmar.
 *
 * Uso:
 *   <QuestionBankImportDialog
 *     open={...}
 *     onOpenChange={...}
 *     courseId="..."
 *     target="exam" | "workshop" | "project"
 *     targetId="<exam/workshop/project id>"
 *     onImported={(count) => refreshQuestions()}
 *   />
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { Search, Library, Inbox } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type QuestionType =
  | "cerrada"
  | "cerrada_multi"
  | "codigo"
  | "codigo_zip"
  | "abierta"
  | "diagrama"
  | "java_gui"
  | "python_gui";

interface BankRow {
  id: string;
  course_id: string;
  type: QuestionType;
  content: string;
  expected_rubric: string | null;
  language: string | null;
  suggested_points: number;
  topic: string | null;
  difficulty: number | null;
  tags: string[];
  shared_org: boolean;
  times_used: number;
}

const TYPE_LABEL: Record<QuestionType, string> = {
  cerrada: i18n.t("hc_modulesCodeQuestionBankImportDialog.typeCerrada"),
  cerrada_multi: i18n.t("hc_modulesCodeQuestionBankImportDialog.typeCerradaMulti"),
  codigo: i18n.t("hc_modulesCodeQuestionBankImportDialog.typeCodigo"),
  codigo_zip: i18n.t("hc_modulesCodeQuestionBankImportDialog.typeCodigoZip"),
  abierta: i18n.t("hc_modulesCodeQuestionBankImportDialog.typeAbierta"),
  diagrama: i18n.t("hc_modulesCodeQuestionBankImportDialog.typeDiagrama"),
  java_gui: i18n.t("hc_modulesCodeQuestionBankImportDialog.typeJavaGui"),
  python_gui: i18n.t("hc_modulesCodeQuestionBankImportDialog.typePythonGui"),
};

type ImportTarget = "exam" | "workshop" | "project" | "kahoot";

// Tipos que cada destino acepta. codigo_zip solo va a proyectos; Kahoot solo
// opción múltiple (cerrada / cerrada_multi).
const ACCEPTED_BY_TARGET: Record<ImportTarget, QuestionType[]> = {
  exam: ["cerrada", "cerrada_multi", "codigo", "abierta", "diagrama", "java_gui", "python_gui"],
  workshop: ["cerrada", "cerrada_multi", "codigo", "abierta", "diagrama", "java_gui", "python_gui"],
  project: [
    "cerrada",
    "cerrada_multi",
    "codigo",
    "codigo_zip",
    "abierta",
    "diagrama",
    "java_gui",
    "python_gui",
  ],
  kahoot: ["cerrada", "cerrada_multi"],
};

const RPC_BY_TARGET: Record<ImportTarget, string> = {
  exam: "add_questions_from_bank_to_exam",
  workshop: "add_questions_from_bank_to_workshop",
  project: "add_questions_from_bank_to_project",
  kahoot: "add_questions_from_bank_to_kahoot",
};

const PARAM_BY_TARGET: Record<ImportTarget, string> = {
  exam: "_exam_id",
  workshop: "_workshop_id",
  project: "_project_id",
  kahoot: "_poll_id",
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courseId: string | null;
  target: ImportTarget;
  targetId: string;
  onImported?: (count: number) => void;
}

export function QuestionBankImportDialog({
  open,
  onOpenChange,
  courseId,
  target,
  targetId,
  onImported,
}: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<BankRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [importing, setImporting] = useState(false);

  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterDifficulty, setFilterDifficulty] = useState<string>("all");

  // Selección + override de puntos por id
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [pointsOverride, setPointsOverride] = useState<Record<string, number>>({});

  const acceptedTypes = ACCEPTED_BY_TARGET[target];

  useEffect(() => {
    if (!open || !courseId) return;
    setLoading(true);
    setSelectedIds(new Set());
    setPointsOverride({});
    (async () => {
      // Preguntas del banco del curso + las COMPARTIDAS con la organización
      // (shared_org=true). La RLS ya acota las compartidas al tenant del
      // lector, así que el `.or` no expone preguntas de otra institución.
      const { data, error } = await db
        .from("question_bank")
        .select(
          "id, course_id, type, content, expected_rubric, language, suggested_points, topic, difficulty, tags, shared_org, times_used",
        )
        .or(`course_id.eq.${courseId},shared_org.eq.true`)
        .in("type", acceptedTypes)
        .order("created_at", { ascending: false });
      if (error) {
        toast.error(friendlyError(error));
        setLoading(false);
        return;
      }
      setRows((data ?? []) as BankRow[]);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, courseId, target]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filterType !== "all" && r.type !== filterType) return false;
      if (filterDifficulty !== "all" && String(r.difficulty ?? "") !== filterDifficulty)
        return false;
      if (q) {
        const hay =
          r.content.toLowerCase().includes(q) ||
          (r.topic ?? "").toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q));
        if (!hay) return false;
      }
      return true;
    });
  }, [rows, search, filterType, filterDifficulty]);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAllVisible = () => {
    const all = filtered.every((r) => selectedIds.has(r.id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((r) => {
        if (all) next.delete(r.id);
        else next.add(r.id);
      });
      return next;
    });
  };

  const submit = async () => {
    if (selectedIds.size === 0) {
      toast.error(
        i18n.t("toast.modules_code_QuestionBankImportDialog.selectAtLeastOne", {
          defaultValue: "Selecciona al menos una pregunta",
        }),
      );
      return;
    }
    setImporting(true);
    try {
      const params: Record<string, unknown> = {
        _bank_ids: Array.from(selectedIds),
        _points_override: pointsOverride,
      };
      params[PARAM_BY_TARGET[target]] = targetId;

      const { data, error } = await db.rpc(RPC_BY_TARGET[target], params);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const count = Number(data) || 0;
      toast.success(
        count === 1
          ? i18n.t("toast.modules_code_QuestionBankImportDialog.importedOne", {
              defaultValue: "1 pregunta importada",
            })
          : i18n.t("toast.modules_code_QuestionBankImportDialog.importedMany", {
              defaultValue: "{{count}} preguntas importadas",
              count,
            }),
      );
      onImported?.(count);
      onOpenChange(false);
    } finally {
      setImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[90dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Library className="h-4 w-4 text-indigo-500" />
            {t("hc_modulesCodeQuestionBankImportDialog.dialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("hc_modulesCodeQuestionBankImportDialog.dialogDescriptionLead")}{" "}
            {target === "exam"
              ? t("hc_modulesCodeQuestionBankImportDialog.targetExam")
              : target === "workshop"
                ? t("hc_modulesCodeQuestionBankImportDialog.targetWorkshop")
                : target === "kahoot"
                  ? t("hc_modulesCodeQuestionBankImportDialog.targetKahoot")
                  : t("hc_modulesCodeQuestionBankImportDialog.targetProject")}
            {t("hc_modulesCodeQuestionBankImportDialog.dialogDescriptionTrail")}
          </DialogDescription>
        </DialogHeader>

        {/* Filtros */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 shrink-0">
          <div className="relative col-span-1 sm:col-span-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("hc_modulesCodeQuestionBankImportDialog.searchPlaceholder")}
              className="pl-7"
            />
          </div>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("hc_modulesCodeQuestionBankImportDialog.allTypes")}</SelectItem>
              {acceptedTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {TYPE_LABEL[t]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterDifficulty} onValueChange={setFilterDifficulty}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("hc_modulesCodeQuestionBankImportDialog.allDifficulty")}</SelectItem>
              <SelectItem value="1">{t("hc_modulesCodeQuestionBankImportDialog.difficulty1")}</SelectItem>
              <SelectItem value="2">{t("hc_modulesCodeQuestionBankImportDialog.difficulty2")}</SelectItem>
              <SelectItem value="3">{t("hc_modulesCodeQuestionBankImportDialog.difficulty3")}</SelectItem>
              <SelectItem value="4">{t("hc_modulesCodeQuestionBankImportDialog.difficulty4")}</SelectItem>
              <SelectItem value="5">{t("hc_modulesCodeQuestionBankImportDialog.difficulty5")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Lista */}
        <ScrollArea className="flex-1 -mx-1 px-1">
          {loading ? (
            <div className="p-4 sm:p-8 text-center text-muted-foreground">
              <Spinner size="md" /> {t("hc_modulesCodeQuestionBankImportDialog.loadingBank")}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Inbox}
              text={t("hc_modulesCodeQuestionBankImportDialog.emptyText")}
              hint={
                rows.length === 0
                  ? t("hc_modulesCodeQuestionBankImportDialog.emptyHintBankEmpty")
                  : t("hc_modulesCodeQuestionBankImportDialog.emptyHintNoResults")
              }
            />
          ) : (
            <div className="space-y-1">
              {/* Toggle all */}
              <div className="flex items-center justify-between text-xs text-muted-foreground px-3 py-2 border-b">
                <button
                  type="button"
                  onClick={toggleAllVisible}
                  className="hover:text-foreground transition-colors"
                >
                  {filtered.every((r) => selectedIds.has(r.id))
                    ? t("hc_modulesCodeQuestionBankImportDialog.deselectAllVisible")
                    : t("hc_modulesCodeQuestionBankImportDialog.selectAllVisible", {
                        count: filtered.length,
                      })}
                </button>
                <span>
                  {t("hc_modulesCodeQuestionBankImportDialog.selectedLabel")}{" "}
                  <strong className="text-foreground">{selectedIds.size}</strong>
                </span>
              </div>

              {filtered.map((r) => {
                const checked = selectedIds.has(r.id);
                const customPts = pointsOverride[r.id] ?? r.suggested_points;
                return (
                  <label
                    key={r.id}
                    className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors ${
                      checked ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <Checkbox
                      checked={checked}
                      onCheckedChange={() => toggle(r.id)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-start gap-2 flex-wrap">
                        <Badge variant="secondary" className="text-[10px]">
                          {TYPE_LABEL[r.type]}
                        </Badge>
                        {r.shared_org && r.course_id !== courseId && (
                          <Badge
                            variant="outline"
                            className="text-[10px] gap-0.5 border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
                          >
                            <Library className="h-2.5 w-2.5" />
                            {t("hc_modulesCodeQuestionBankImportDialog.sharedBadge")}
                          </Badge>
                        )}
                        {r.topic && (
                          <Badge variant="outline" className="text-[10px]">
                            {r.topic}
                          </Badge>
                        )}
                        {r.difficulty != null && (
                          <Badge variant="outline" className="text-[10px]">
                            {t("hc_modulesCodeQuestionBankImportDialog.difficultyBadge", {
                              difficulty: r.difficulty,
                            })}
                          </Badge>
                        )}
                        {r.times_used > 0 && (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">
                            {t("hc_modulesCodeQuestionBankImportDialog.timesUsedBadge", {
                              count: r.times_used,
                            })}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm line-clamp-2">{r.content}</p>
                      {r.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {r.tags.map((t) => (
                            <span
                              key={t}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
                            >
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {/* Override de puntos solo si está seleccionada */}
                    {checked && (
                      <div className="shrink-0 w-24" onClick={(e) => e.preventDefault()}>
                        <Label className="text-[10px]">{t("hc_modulesCodeQuestionBankImportDialog.pointsLabel")}</Label>
                        <Input
                          type="number"
                          min={0}
                          step="0.5"
                          value={customPts}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            setPointsOverride((prev) => ({ ...prev, [r.id]: val }));
                          }}
                          className="h-8 text-xs"
                        />
                      </div>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>
            {t("hc_modulesCodeQuestionBankImportDialog.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={importing || selectedIds.size === 0}>
            {importing ? <Spinner size="sm" className="mr-1" /> : null}
            {t("hc_modulesCodeQuestionBankImportDialog.addQuestions", { count: selectedIds.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Banco de preguntas reutilizables.
 *
 * Cada pregunta vive dentro de un curso y es visible/editable por todos
 * los docentes asignados a ese curso (RLS course_teachers). El docente
 * puede luego importar selecciones al form de examen/taller/proyecto
 * via `QuestionBankImportDialog`.
 *
 * Soporta los 7 tipos: cerrada, cerrada_multi, codigo, codigo_zip,
 * abierta, diagrama, java_gui. Los tipos no aplicables al destino se
 * filtran al importar (codigo_zip solo va a proyectos).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageHeader } from "@/components/ui/page-header";
import { RowAction } from "@/components/ui/row-action";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import { Library, Plus, Search, Pencil, Trash2, X as XIcon, Save } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import { ImportExportMenu } from "@/shared/components/ImportExportMenu";
import { toCSV } from "@/shared/lib/csv";
import { usePagination } from "@/hooks/use-pagination";
import { DataPagination } from "@/components/ui/data-pagination";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";

export const Route = createFileRoute("/app/teacher/question-bank")({
  component: QuestionBankPage,
});

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
  created_by: string | null;
  type: QuestionType;
  content: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  options: any;
  expected_rubric: string | null;
  language: string | null;
  starter_code: string | null;
  suggested_points: number;
  topic: string | null;
  difficulty: number | null;
  tags: string[];
  times_used: number;
  last_used_at: string | null;
  created_at: string;
}

interface Course {
  id: string;
  name: string;
}

const TYPE_LABEL: Record<QuestionType, string> = {
  cerrada: "Selección única",
  cerrada_multi: "Opción múltiple",
  codigo: "Código",
  codigo_zip: "Código ZIP (proyectos)",
  abierta: "Abierta",
  diagrama: "Diagrama",
  java_gui: "Java GUI",
  python_gui: "Python GUI (tkinter)",
};

function QuestionBankPage() {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const confirm = useConfirm();

  const [courses, setCourses] = useState<Course[]>([]);
  const [courseId, setCourseId] = useState<string>("");
  const [rows, setRows] = useState<BankRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Gate del módulo. Si el admin lo desactivó, mostramos pantalla
  // "deshabilitado" en vez de chocar contra la tabla. También cubre el
  // caso en que la migración 20260518100000_question_bank no se haya
  // aplicado todavía (Lovable Publish pendiente) — al fallar el query
  // mostramos el mismo estado para no quemar al usuario con un toast
  // críptico de schema cache.
  const [moduleAvailable, setModuleAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (db as any)
        .from("app_settings")
        .select("question_bank_enabled")
        .maybeSingle();
      if (cancelled) return;
      setModuleAvailable(data?.question_bank_enabled === false ? false : true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Filtros
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterDifficulty, setFilterDifficulty] = useState<string>("all");

  // Dialog estado (crear/editar)
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<BankRow | null>(null);
  const [draft, setDraft] = useState<Partial<BankRow>>({
    type: "abierta",
    suggested_points: 1,
    tags: [],
  });
  const [tagInput, setTagInput] = useState("");
  const [saving, setSaving] = useState(false);

  const isAdmin = roles.includes("Admin");
  const isDocente = roles.includes("Docente");

  // Cargar cursos del docente
  useEffect(() => {
    if (!user) return;
    (async () => {
      let query;
      if (isAdmin) {
        query = db.from("courses").select("id, name").order("name");
      } else {
        query = db
          .from("courses")
          .select("id, name, course_teachers!inner(user_id)")
          .eq("course_teachers.user_id", user.id)
          .order("name");
      }
      const { data, error } = await query;
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const list = (data ?? []) as Course[];
      setCourses(list);
      if (list.length > 0 && !courseId) {
        setCourseId(list[0].id);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Cargar preguntas del banco para el curso seleccionado
  const load = async () => {
    if (!courseId) {
      setRows([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("question_bank")
      .select("*")
      .eq("course_id", courseId)
      .order("created_at", { ascending: false });
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar el banco de preguntas."));
      setLoading(false);
      return;
    }
    setRows((data ?? []) as BankRow[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courseId]);

  // Filtrado client-side
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
  const pagination = usePagination(filtered, {
    defaultPageSize: 25,
    storageKey: "examlab_pag:teacher_question_bank",
    resetKey: `${search}|${filterType}|${filterDifficulty}|${courseId}`,
  });

  // Export del banco filtrado. No soportamos import porque las preguntas
  // (con options JSON, starter_code, expected_rubric) no caben en CSV plano;
  // para añadirlas en bulk usar la pestaña "IA" en exam/workshop/project
  // que genera + guarda en banco.
  const exportBankCsv = (): string => {
    const data = filtered.map((r) => ({
      type: r.type,
      content: r.content.replace(/\r?\n/g, " ").slice(0, 500),
      topic: r.topic ?? "",
      difficulty: r.difficulty ?? "",
      tags: r.tags.join("|"),
      suggested_points: r.suggested_points,
      language: r.language ?? "",
      times_used: r.times_used,
      last_used_at: r.last_used_at ?? "",
    }));
    return toCSV(data);
  };

  const openCreate = () => {
    setEditing(null);
    setDraft({ type: "abierta", suggested_points: 1, tags: [] });
    setTagInput("");
    setDialogOpen(true);
  };

  const openEdit = (r: BankRow) => {
    setEditing(r);
    setDraft({ ...r });
    setTagInput("");
    setDialogOpen(true);
  };

  const addTag = () => {
    const t = tagInput.trim().toLowerCase();
    if (!t) return;
    const current = draft.tags ?? [];
    if (current.includes(t)) return;
    setDraft({ ...draft, tags: [...current, t] });
    setTagInput("");
  };

  const removeTag = (t: string) => {
    setDraft({ ...draft, tags: (draft.tags ?? []).filter((x) => x !== t) });
  };

  const save = async () => {
    if (!user || !courseId) return;
    if (!draft.content?.trim()) {
      toast.error(
        i18n.t("toast.routes_app_teacher_question_bank.writeStatement", {
          defaultValue: "Escribe el enunciado",
        }),
      );
      return;
    }
    if (!draft.type) {
      toast.error(
        i18n.t("toast.routes_app_teacher_question_bank.selectType", {
          defaultValue: "Selecciona un tipo",
        }),
      );
      return;
    }
    setSaving(true);
    try {
      const payload = {
        course_id: courseId,
        type: draft.type,
        content: draft.content,
        options: draft.options ?? null,
        expected_rubric: draft.expected_rubric ?? null,
        language: draft.language ?? null,
        starter_code: draft.starter_code ?? null,
        suggested_points: draft.suggested_points ?? 1,
        topic: draft.topic ?? null,
        difficulty: draft.difficulty ?? null,
        tags: draft.tags ?? [],
      };
      if (editing) {
        const { error } = await db.from("question_bank").update(payload).eq("id", editing.id);
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_question_bank.questionUpdated", {
            defaultValue: "Pregunta actualizada",
          }),
        );
      } else {
        const { error } = await db
          .from("question_bank")
          .insert({ ...payload, created_by: user.id });
        if (error) {
          toast.error(friendlyError(error));
          return;
        }
        toast.success(
          i18n.t("toast.routes_app_teacher_question_bank.questionAddedToBank", {
            defaultValue: "Pregunta agregada al banco",
          }),
        );
      }
      setDialogOpen(false);
      await load();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r: BankRow) => {
    const ok = await confirm({
      title: "¿Eliminar pregunta del banco?",
      description:
        "Las copias ya insertadas en exámenes/talleres/proyectos NO se borran. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("question_bank").delete().eq("id", r.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.routes_app_teacher_question_bank.questionDeleted", {
        defaultValue: "Pregunta eliminada",
      }),
    );
    setRows((prev) => prev.filter((x) => x.id !== r.id));
  };

  if (!isAdmin && !isDocente) {
    return <p className="text-muted-foreground p-6">Solo docentes y admins.</p>;
  }

  if (moduleAvailable === false) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardContent className="p-4 sm:p-8 text-center space-y-2">
            <Library className="h-10 w-10 text-muted-foreground mx-auto" />
            <h2 className="text-base font-semibold">Banco de preguntas deshabilitado</h2>
            <p className="text-sm text-muted-foreground">
              El administrador desactivó este módulo. Contacta al admin si necesitas usarlo.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto space-y-5 p-4 sm:p-6">
      <PageHeader
        icon={<Library className="h-6 w-6" />}
        title="Banco de preguntas"
        subtitle="Preguntas reutilizables compartidas entre los docentes del curso. Importa selecciones al crear exámenes, talleres o proyectos."
        actions={
          <div className="flex gap-2">
            <ImportExportMenu
              resourceName="banco-preguntas"
              onExport={exportBankCsv}
              disabled={!courseId}
            />
            <Button onClick={openCreate} disabled={!courseId} data-tour-id="create-question">
              <Plus className="h-4 w-4 mr-1" />
              Nueva pregunta
            </Button>
          </div>
        }
      />

      {/* Filtros */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <Label className="text-xs">Curso</Label>
              <Select value={courseId} onValueChange={setCourseId} disabled={courses.length === 0}>
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      courses.length === 0
                        ? "No tenés cursos asignados"
                        : "Selecciona un curso"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {courses.length === 0 && (
                // Mensaje accionable cuando el docente no está en
                // course_teachers de ningún curso. Sin esto, el botón
                // "Nueva pregunta" aparece disabled sin contexto y el
                // user no sabe qué hacer. El banco de preguntas vive
                // POR CURSO (RLS lo enforza), así que sin curso no
                // hay forma de crear.
                <p className="text-[11px] text-muted-foreground mt-1">
                  Pedile al Admin del tenant que te asigne a un curso para empezar.
                </p>
              )}
            </div>
            <div>
              <Label className="text-xs">Tipo</Label>
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos los tipos</SelectItem>
                  {Object.entries(TYPE_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Dificultad</Label>
              <Select value={filterDifficulty} onValueChange={setFilterDifficulty}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todas</SelectItem>
                  <SelectItem value="1">1 — muy fácil</SelectItem>
                  <SelectItem value="2">2 — fácil</SelectItem>
                  <SelectItem value="3">3 — media</SelectItem>
                  <SelectItem value="4">4 — difícil</SelectItem>
                  <SelectItem value="5">5 — muy difícil</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Buscar</Label>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Enunciado, tema o tag…"
                  className="pl-7"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabla */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          {loading ? (
            <div className="p-4 sm:p-8 text-center text-muted-foreground">
              <Spinner size="md" /> Cargando…
            </div>
          ) : loadError ? (
            <ErrorState
              message="No pudimos cargar el banco"
              hint={loadError}
              onRetry={() => void load()}
            />
          ) : (
            <Table resizable>
              <TableHeader>
                <TableRow>
                  <TableHead>Pregunta</TableHead>
                  <TableHead className="hidden md:table-cell">Tipo</TableHead>
                  <TableHead className="hidden md:table-cell">Tema</TableHead>
                  <TableHead className="hidden lg:table-cell">Tags</TableHead>
                  <TableHead className="hidden sm:table-cell text-center">Dif.</TableHead>
                  <TableHead className="hidden sm:table-cell text-center">Pts</TableHead>
                  <TableHead className="hidden lg:table-cell text-center">Usos</TableHead>
                  <TableHead className="text-right">Acciones</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 ? (
                  <TableEmpty
                    colSpan={8}
                    text={!courseId ? "Elegí un curso" : "Sin preguntas"}
                    hint={
                      !courseId
                        ? "Seleccioná un curso arriba para ver o crear preguntas del banco."
                        : rows.length === 0
                          ? "Aún no tienes preguntas en el banco de este curso."
                          : "Ninguna pregunta coincide con los filtros."
                    }
                    action={
                      courseId && rows.length === 0 ? (
                        <Button size="sm" onClick={openCreate}>
                          <Plus className="h-4 w-4 mr-1" />
                          Crear la primera
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  pagination.paginatedItems.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="max-w-md">
                        <div className="line-clamp-2 text-sm">{r.content}</div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <Badge variant="secondary" className="text-[10px] whitespace-nowrap">
                          {TYPE_LABEL[r.type]}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                        {r.topic || "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <div className="flex flex-wrap gap-1">
                          {r.tags.slice(0, 3).map((t) => (
                            <Badge key={t} variant="outline" className="text-[10px]">
                              {t}
                            </Badge>
                          ))}
                          {r.tags.length > 3 && (
                            <Badge variant="outline" className="text-[10px]">
                              +{r.tags.length - 3}
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center text-xs tabular-nums">
                        {r.difficulty ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell text-center text-xs tabular-nums">
                        {r.suggested_points}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-center text-xs tabular-nums">
                        {r.times_used}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <RowAction label="Editar" icon={Pencil} onClick={() => openEdit(r)} />
                          <RowAction
                            label="Eliminar"
                            icon={Trash2}
                            tone="destructive"
                            onClick={() => void remove(r)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
          <DataPagination state={pagination} entityNamePlural="preguntas" />
        </CardContent>
      </Card>

      {/* Dialog crear/editar */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent
          className="max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90dvh] overflow-y-auto"
          data-tour-id="dialog-question"
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? "Editar pregunta del banco" : "Nueva pregunta para el banco"}
            </DialogTitle>
            <DialogDescription>
              Visible para todos los docentes asignados a este curso.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div data-tour-id="question-field-type">
                <Label required>Tipo</Label>
                <Select
                  value={draft.type ?? "abierta"}
                  onValueChange={(v) => setDraft({ ...draft, type: v as QuestionType })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(TYPE_LABEL).map(([k, v]) => (
                      <SelectItem key={k} value={k}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Puntos sugeridos</Label>
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  value={draft.suggested_points ?? 1}
                  onChange={(e) =>
                    setDraft({ ...draft, suggested_points: Number(e.target.value) || 1 })
                  }
                />
              </div>
            </div>

            <div data-tour-id="question-field-content">
              <Label required>Enunciado</Label>
              <Textarea
                value={draft.content ?? ""}
                onChange={(e) => setDraft({ ...draft, content: e.target.value })}
                rows={4}
                placeholder="Escribe la pregunta…"
              />
            </div>

            {draft.type !== "cerrada" && draft.type !== "cerrada_multi" && (
              <div data-tour-id="question-field-rubric">
                <Label>
                  Rúbrica esperada{" "}
                  <HelpHint>{t("help.rubricHelpCriteria")}</HelpHint>
                </Label>
                <Textarea
                  value={draft.expected_rubric ?? ""}
                  onChange={(e) => setDraft({ ...draft, expected_rubric: e.target.value })}
                  rows={2}
                />
              </div>
            )}

            {(draft.type === "codigo" ||
              draft.type === "java_gui" ||
              draft.type === "python_gui") && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Lenguaje</Label>
                  <Select
                    value={draft.language ?? "java"}
                    onValueChange={(v) => setDraft({ ...draft, language: v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="java">Java</SelectItem>
                      <SelectItem value="python">Python</SelectItem>
                      <SelectItem value="javascript">JavaScript</SelectItem>
                      <SelectItem value="typescript">TypeScript</SelectItem>
                      <SelectItem value="c">C</SelectItem>
                      <SelectItem value="cpp">C++</SelectItem>
                      <SelectItem value="csharp">C#</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>Tema</Label>
                <Input
                  value={draft.topic ?? ""}
                  onChange={(e) => setDraft({ ...draft, topic: e.target.value })}
                  placeholder="Ej: Recursividad, Polimorfismo, Joins SQL…"
                />
              </div>
              <div>
                <Label>Dificultad (1-5)</Label>
                <Select
                  value={String(draft.difficulty ?? "")}
                  onValueChange={(v) =>
                    setDraft({ ...draft, difficulty: v === "" ? null : Number(v) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Sin definir" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1 — muy fácil</SelectItem>
                    <SelectItem value="2">2 — fácil</SelectItem>
                    <SelectItem value="3">3 — media</SelectItem>
                    <SelectItem value="4">4 — difícil</SelectItem>
                    <SelectItem value="5">5 — muy difícil</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>Tags</Label>
              <div className="flex flex-wrap gap-1 mb-2">
                {(draft.tags ?? []).map((t) => (
                  <Badge key={t} variant="secondary" className="text-[11px] gap-1">
                    {t}
                    <button
                      type="button"
                      onClick={() => removeTag(t)}
                      className="hover:text-destructive"
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </Badge>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  placeholder="Nuevo tag…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addTag();
                    }
                  }}
                />
                <Button type="button" variant="outline" onClick={addTag}>
                  Añadir
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              {editing ? "Guardar cambios" : "Agregar al banco"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

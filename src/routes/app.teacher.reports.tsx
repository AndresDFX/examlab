/**
 * Docente — informes parametrizables.
 *
 * Una sola pantalla con:
 *   - Lista de plantillas disponibles: globales (Admin) + overrides
 *     propios + privadas propias. Cada fila trae origen (badge),
 *     scope, y acciones según el tipo.
 *   - Botón "Nueva privada" → editor en blanco.
 *   - Por fila:
 *       · Generar → modal de selector curso/alumno → preview HTML en
 *         iframe → botón "Imprimir / Guardar como PDF".
 *       · Personalizar (solo en globales sin override del curso elegido) →
 *         abre editor pre-rellenado para crear override.
 *       · Editar / Eliminar (solo en propias / overrides propios).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ModuleGuard } from "@/shared/components/ModuleGuard";
import { friendlyError } from "@/shared/lib/db-errors";
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  ClipboardList,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Play,
  Printer,
  GitBranch,
} from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  TemplateEditor,
  composeTemplateHtml,
  emptyDraft,
  draftEqual,
  type TemplateDraft,
} from "@/modules/reports/TemplateEditor";
import { renderTemplate } from "@/modules/reports/template-engine";
import { buildReportContext, buildReportContextFromActa } from "@/modules/reports/report-context";
import { ActasManager } from "@/modules/reports/ActasManager";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/teacher/reports")({ component: TeacherReports });

type Template = {
  id: string;
  name: string;
  description: string | null;
  scope: "estudiante" | "curso";
  body_html: string;
  header_html: string | null;
  footer_html: string | null;
  css: string | null;
  page_orientation: "portrait" | "landscape";
  page_size: "A4" | "letter";
  owner_id: string | null;
  course_id: string | null;
  parent_id: string | null;
};

type Course = { id: string; name: string };
type Student = { id: string; full_name: string; institutional_email: string };

type Origin = "global" | "override" | "privada";

function originOf(t: Template): Origin {
  if (t.owner_id != null) return "privada";
  if (t.course_id != null && t.parent_id != null) return "override";
  return "global";
}

function originBadge(origin: Origin, courseName?: string) {
  if (origin === "global") {
    return <Badge variant="secondary" className="text-xs">Global</Badge>;
  }
  if (origin === "override") {
    return (
      <Badge
        variant="outline"
        className="text-xs border-violet-300 text-violet-700 dark:border-violet-500/50 dark:text-violet-300"
      >
        Personalizada{courseName ? ` · ${courseName}` : ""}
      </Badge>
    );
  }
  return <Badge variant="outline" className="text-xs">Privada</Badge>;
}

function TeacherReports() {
  return (
    <ModuleGuard module="reports">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const { user } = useAuth();
  const confirm = useConfirm();

  const [templates, setTemplates] = useState<Template[]>([]);
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");
  const [originFilter, setOriginFilter] = useState<"all" | Origin>("all");

  // Editor state (compartido entre nueva privada / override / editar)
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft());
  const [original, setOriginal] = useState<TemplateDraft>(emptyDraft());
  const [editorMode, setEditorMode] =
    useState<"new_private" | "new_override" | "edit_private" | "edit_override">("new_private");
  const [editorCourseId, setEditorCourseId] = useState<string>("");
  const [editorParentId, setEditorParentId] = useState<string | null>(null);
  const [editorTemplateId, setEditorTemplateId] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);

  // Generador state
  const [genOpen, setGenOpen] = useState(false);
  const [genTemplate, setGenTemplate] = useState<Template | null>(null);
  const [genCourseId, setGenCourseId] = useState<string>("");
  const [genStudentId, setGenStudentId] = useState<string>("");
  const [genPeriodo, setGenPeriodo] = useState<string>("");
  const [genStudents, setGenStudents] = useState<Student[]>([]);
  const [genLoadingStudents, setGenLoadingStudents] = useState(false);
  const [genHtml, setGenHtml] = useState<string | null>(null);
  const [genBuilding, setGenBuilding] = useState(false);
  // Si el docente abrió el generador desde "Imprimir acta" en
  // ActasManager, este id apunta al snapshot inmutable. Cuando está
  // presente, handleGenerate lee del snapshot en vez de datos vivos.
  const [genActaId, setGenActaId] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    setLoadError(null);
    const [{ data: ts, error: tErr }, { data: cs, error: cErr }] = await Promise.all([
      db
        .from("report_templates")
        .select(
          "id, name, description, scope, body_html, header_html, footer_html, css, page_orientation, page_size, owner_id, course_id, parent_id",
        )
        .order("name"),
      db.from("courses").select("id, name").order("name"),
    ]);
    if (tErr) {
      setLoadError(friendlyError(tErr, "No pudimos cargar las plantillas."));
      setLoading(false);
      return;
    }
    if (cErr) {
      setLoadError(friendlyError(cErr, "No pudimos cargar tus cursos."));
      setLoading(false);
      return;
    }
    setTemplates((ts ?? []) as Template[]);
    setCourses((cs ?? []) as Course[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, retryNonce]);

  const courseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of courses) m.set(c.id, c.name);
    return m;
  }, [courses]);

  const filtered = useMemo(() => {
    let result = templates;
    if (originFilter !== "all") {
      result = result.filter((t) => originOf(t) === originFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          (t.description?.toLowerCase().includes(q) ?? false),
      );
    }
    return result;
  }, [templates, search, originFilter]);

  // ── Editor handlers ──────────────────────────────────────────────

  const openNewPrivate = () => {
    const d = emptyDraft();
    setDraft(d);
    setOriginal(d);
    setEditorMode("new_private");
    setEditorCourseId("");
    setEditorParentId(null);
    setEditorTemplateId(null);
    setEditorOpen(true);
  };

  const openOverride = (t: Template) => {
    if (originOf(t) !== "global") return;
    const d: TemplateDraft = {
      name: `${t.name} (personalizada)`,
      description: t.description ?? "",
      scope: t.scope,
      body_html: t.body_html,
      header_html: t.header_html ?? "",
      footer_html: t.footer_html ?? "",
      css: t.css ?? "",
      page_orientation: t.page_orientation,
      page_size: t.page_size,
    };
    setDraft(d);
    setOriginal(d);
    setEditorMode("new_override");
    setEditorCourseId(courses[0]?.id ?? "");
    setEditorParentId(t.id);
    setEditorTemplateId(null);
    setEditorOpen(true);
  };

  const openEdit = (t: Template) => {
    const d: TemplateDraft = {
      name: t.name,
      description: t.description ?? "",
      scope: t.scope,
      body_html: t.body_html,
      header_html: t.header_html ?? "",
      footer_html: t.footer_html ?? "",
      css: t.css ?? "",
      page_orientation: t.page_orientation,
      page_size: t.page_size,
    };
    setDraft(d);
    setOriginal(d);
    const o = originOf(t);
    setEditorMode(o === "override" ? "edit_override" : "edit_private");
    setEditorCourseId(t.course_id ?? "");
    setEditorParentId(t.parent_id);
    setEditorTemplateId(t.id);
    setEditorOpen(true);
  };

  const closeEditor = async () => {
    if (!draftEqual(draft, original)) {
      const ok = await confirm({
        title: "¿Descartar cambios?",
        description: "Hay cambios sin guardar que se perderán.",
        confirmLabel: "Descartar",
        tone: "warning",
      });
      if (!ok) return;
    }
    setEditorOpen(false);
  };

  const handleSave = async () => {
    if (!user) return;
    if (!draft.name.trim()) {
      toast.error("El nombre es obligatorio");
      return;
    }
    if (!draft.body_html.trim()) {
      toast.error("El cuerpo no puede estar vacío");
      return;
    }
    if (
      (editorMode === "new_override" || editorMode === "edit_override") &&
      !editorCourseId
    ) {
      toast.error("Selecciona el curso para la personalización");
      return;
    }

    setEditorSaving(true);
    const base = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      scope: draft.scope,
      body_html: draft.body_html,
      header_html: draft.header_html || null,
      footer_html: draft.footer_html || null,
      css: draft.css || null,
      page_orientation: draft.page_orientation,
      page_size: draft.page_size,
      updated_by: user.id,
    };

    let payload: Record<string, unknown>;
    if (editorMode === "new_private" || editorMode === "edit_private") {
      payload = {
        ...base,
        owner_id: user.id,
        course_id: null,
        parent_id: null,
      };
    } else {
      payload = {
        ...base,
        owner_id: null,
        course_id: editorCourseId,
        parent_id: editorParentId,
      };
    }

    const { error } = editorTemplateId
      ? await db.from("report_templates").update(payload).eq("id", editorTemplateId)
      : await db.from("report_templates").insert({ ...payload, created_by: user.id });
    setEditorSaving(false);
    if (error) {
      toast.error(friendlyError(error, "No se pudo guardar la plantilla"));
      return;
    }
    toast.success(editorTemplateId ? "Plantilla actualizada" : "Plantilla creada");
    setEditorOpen(false);
    void load();
  };

  const handleDelete = async (t: Template) => {
    if (originOf(t) === "global") return; // no puede borrar globales
    const ok = await confirm({
      title: `¿Eliminar "${t.name}"?`,
      description: "Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("report_templates").delete().eq("id", t.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Plantilla eliminada");
    void load();
  };

  const handleDuplicate = async (t: Template) => {
    if (!user) return;
    // Duplicar siempre como privada propia — no tiene sentido duplicar
    // una global como global (eso es solo Admin).
    const payload = {
      name: `${t.name} (copia)`,
      description: t.description,
      scope: t.scope,
      body_html: t.body_html,
      header_html: t.header_html,
      footer_html: t.footer_html,
      css: t.css,
      page_orientation: t.page_orientation,
      page_size: t.page_size,
      owner_id: user.id,
      course_id: null,
      parent_id: null,
      created_by: user.id,
      updated_by: user.id,
    };
    const { error } = await db.from("report_templates").insert(payload);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success("Plantilla duplicada como privada");
    void load();
  };

  // ── Generador handlers ───────────────────────────────────────────

  const openGenerate = (t: Template) => {
    setGenTemplate(t);
    // Si el template tiene course_id fijo (override), usar ese
    const defaultCourse = t.course_id ?? courses[0]?.id ?? "";
    setGenCourseId(defaultCourse);
    setGenStudentId("");
    setGenPeriodo("");
    setGenStudents([]);
    setGenHtml(null);
    // Generación normal (no desde acta) — limpia el actaId para
    // forzar el path 'datos vivos'.
    setGenActaId(null);
    setGenOpen(true);
  };

  // Click en "Imprimir acta" desde ActasManager: busca la plantilla
  // seed "Acta de finalización del curso" y abre el generador con
  // el curso y periodo del acta pre-seleccionados.
  const handlePrintActa = (acta: {
    id: string;
    course_id: string;
    periodo_codigo: string | null;
  }) => {
    const actaTpl = templates.find(
      (t) => t.name === "Acta de finalización del curso" && t.owner_id == null && t.course_id == null,
    );
    if (!actaTpl) {
      toast.error(
        "No se encontró la plantilla 'Acta de finalización del curso'. Pídele al admin que la publique.",
      );
      return;
    }
    setGenTemplate(actaTpl);
    setGenCourseId(acta.course_id);
    setGenStudentId("");
    setGenPeriodo(acta.periodo_codigo ?? "");
    setGenStudents([]);
    setGenHtml(null);
    // El actaId activa el path inmutable: handleGenerate leerá del
    // snapshot en lugar de gradebook en vivo. El docente puede
    // imprimir la misma acta mañana y obtener exactamente las mismas
    // notas, aunque haya editado el gradebook entre tanto.
    setGenActaId(acta.id);
    setGenOpen(true);
  };

  // Cargar alumnos del curso cuando cambia el curso seleccionado y
  // scope='estudiante' (no necesitamos lista de alumnos para scope='curso')
  useEffect(() => {
    if (!genOpen || !genTemplate || genTemplate.scope !== "estudiante" || !genCourseId) {
      setGenStudents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setGenLoadingStudents(true);
      const { data: enr } = await db
        .from("course_enrollments")
        .select("user_id")
        .eq("course_id", genCourseId);
      const ids = ((enr ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
      if (cancelled) return;
      if (ids.length === 0) {
        setGenStudents([]);
        setGenLoadingStudents(false);
        return;
      }
      const { data: profs } = await db
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", ids)
        .order("full_name");
      if (cancelled) return;
      setGenStudents((profs ?? []) as Student[]);
      setGenLoadingStudents(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [genOpen, genTemplate, genCourseId]);

  const handleGenerate = async () => {
    if (!genTemplate || !genCourseId) return;
    if (genTemplate.scope === "estudiante" && !genStudentId) {
      toast.error("Selecciona un estudiante");
      return;
    }
    setGenBuilding(true);
    try {
      const ctx = genActaId
        ? await buildReportContextFromActa(genActaId)
        : await buildReportContext({
            courseId: genCourseId,
            studentId: genTemplate.scope === "estudiante" ? genStudentId : undefined,
            periodo: genPeriodo.trim() || undefined,
          });
      const renderedBody = renderTemplate(genTemplate.body_html, ctx);
      const renderedHeader = genTemplate.header_html
        ? renderTemplate(genTemplate.header_html, ctx)
        : "";
      const renderedFooter = genTemplate.footer_html
        ? renderTemplate(genTemplate.footer_html, ctx)
        : "";
      const html = composeTemplateHtml({
        body_html: renderedBody,
        header_html: renderedHeader,
        footer_html: renderedFooter,
        css: genTemplate.css ?? "",
        page_orientation: genTemplate.page_orientation,
        page_size: genTemplate.page_size,
      });
      setGenHtml(html);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Error al generar el informe");
    }
    setGenBuilding(false);
  };

  const handlePrint = () => {
    const iframe = iframeRef.current;
    if (!iframe?.contentWindow) {
      toast.error("Vista previa no disponible");
      return;
    }
    iframe.contentWindow.focus();
    iframe.contentWindow.print();
  };

  // ── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ClipboardList className="h-5 w-5 text-pink-500" />}
        title="Informes"
        subtitle={loading ? undefined : `${templates.length} plantilla(s) disponibles`}
        actions={
          <Button onClick={openNewPrivate}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva plantilla
          </Button>
        }
      />

      <ActasManager onPrintActa={handlePrintActa} />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="flex-1">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Buscar por nombre o descripción…"
              />
            </div>
            <Select
              value={originFilter}
              onValueChange={(v) => setOriginFilter(v as typeof originFilter)}
            >
              <SelectTrigger className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Todos los orígenes</SelectItem>
                <SelectItem value="global">Globales</SelectItem>
                <SelectItem value="override">Personalizadas</SelectItem>
                <SelectItem value="privada">Privadas</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            {loading ? (
              <TableSkeleton cols={4} rows={5} />
            ) : loadError ? (
              <ErrorState
                message="No pudimos cargar"
                hint={loadError}
                onRetry={() => setRetryNonce((n) => n + 1)}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead>
                    <TableHead className="hidden sm:table-cell">Origen</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="hidden md:table-cell">Descripción</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableEmpty
                      colSpan={5}
                      text="Sin plantillas"
                      hint="Cuando el administrador cree plantillas globales aparecerán aquí. También puedes crear una privada."
                    />
                  ) : (
                    filtered.map((t) => {
                      const origin = originOf(t);
                      return (
                        <TableRow key={t.id}>
                          <TableCell className="font-medium">{t.name}</TableCell>
                          <TableCell className="hidden sm:table-cell">
                            {originBadge(
                              origin,
                              t.course_id ? courseNameById.get(t.course_id) : undefined,
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className="text-xs">
                              {t.scope === "curso" ? "Curso" : "Estudiante"}
                            </Badge>
                          </TableCell>
                          <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                            {t.description ?? "—"}
                          </TableCell>
                          <TableCell className="text-right">
                            <RowActionsMenu
                              actions={[
                                {
                                  label: "Generar informe",
                                  icon: Play,
                                  onClick: () => openGenerate(t),
                                },
                                origin === "global" && {
                                  label: "Personalizar para un curso",
                                  icon: GitBranch,
                                  onClick: () => openOverride(t),
                                  separatorBefore: true,
                                },
                                origin !== "global" && {
                                  label: "Editar",
                                  icon: Pencil,
                                  onClick: () => openEdit(t),
                                  separatorBefore: true,
                                },
                                {
                                  label: "Duplicar como privada",
                                  icon: Copy,
                                  onClick: () => void handleDuplicate(t),
                                },
                                origin !== "global" && {
                                  label: "Eliminar",
                                  icon: Trash2,
                                  tone: "destructive",
                                  separatorBefore: true,
                                  onClick: () => void handleDelete(t),
                                },
                              ]}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Dialog: Editor ── */}
      <Dialog open={editorOpen} onOpenChange={(o) => !o && void closeEditor()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editorMode === "new_private" && "Nueva plantilla privada"}
              {editorMode === "new_override" && "Personalizar para un curso"}
              {editorMode === "edit_private" && "Editar plantilla privada"}
              {editorMode === "edit_override" && "Editar personalización"}
            </DialogTitle>
            {editorMode.startsWith("new_override") && (
              <DialogDescription>
                Esta personalización solo aplicará al curso seleccionado y reemplazará la
                plantilla global cuando la uses allí.
              </DialogDescription>
            )}
          </DialogHeader>

          {(editorMode === "new_override" || editorMode === "edit_override") && (
            <div className="space-y-1">
              <Label required>Curso</Label>
              <Select value={editorCourseId} onValueChange={setEditorCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona el curso del override" />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <TemplateEditor value={draft} onChange={setDraft} />

          <DialogFooter>
            <Button variant="outline" onClick={() => void closeEditor()} disabled={editorSaving}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSave()} disabled={editorSaving}>
              {editorSaving ? "Guardando…" : "Guardar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: Generador ── */}
      <Dialog open={genOpen} onOpenChange={setGenOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-6xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Generar: {genTemplate?.name}</DialogTitle>
            <DialogDescription>
              {genTemplate?.scope === "curso"
                ? "Se incluirán todos los estudiantes matriculados en el curso."
                : "El informe se generará para el estudiante seleccionado."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1">
              <Label required>Curso</Label>
              <Select
                value={genCourseId}
                onValueChange={(v) => {
                  setGenCourseId(v);
                  setGenStudentId("");
                  setGenHtml(null);
                }}
                disabled={!!genTemplate?.course_id}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona un curso" />
                </SelectTrigger>
                <SelectContent>
                  {courses.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {genTemplate?.scope === "estudiante" && (
              <div className="space-y-1">
                <Label required>Estudiante</Label>
                <Select
                  value={genStudentId}
                  onValueChange={(v) => {
                    setGenStudentId(v);
                    setGenHtml(null);
                  }}
                  disabled={!genCourseId || genLoadingStudents}
                >
                  <SelectTrigger>
                    <SelectValue
                      placeholder={genLoadingStudents ? "Cargando…" : "Selecciona un estudiante"}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {genStudents.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <Label>Periodo</Label>
              <Input
                value={genPeriodo}
                onChange={(e) => {
                  setGenPeriodo(e.target.value);
                  // El periodo va al render — si cambia, el preview ya no
                  // corresponde a esa selección. Lo limpiamos para forzar
                  // al docente a regenerar antes de imprimir.
                  if (genHtml) setGenHtml(null);
                }}
                placeholder="2026-1, Trimestre 2, etc."
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => void handleGenerate()}
              disabled={
                genBuilding ||
                !genCourseId ||
                (genTemplate?.scope === "estudiante" && !genStudentId)
              }
            >
              {genBuilding ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Play className="h-4 w-4 mr-1" />
              )}
              {genBuilding ? "Generando…" : "Generar"}
            </Button>
            {genHtml && (
              <Button variant="outline" onClick={handlePrint}>
                <Printer className="h-4 w-4 mr-1" />
                Imprimir / Guardar PDF
              </Button>
            )}
          </div>

          {genHtml && (
            <div className="border rounded-md overflow-hidden bg-white">
              <iframe
                ref={iframeRef}
                title="Vista previa del informe"
                srcDoc={genHtml}
                className="w-full"
                style={{ height: "60vh" }}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

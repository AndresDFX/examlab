/**
 * Admin — gestión de plantillas globales de informes.
 *
 * Lista todas las plantillas globales (owner_id IS NULL AND course_id IS NULL)
 * y permite crear/editar/eliminar. Los overrides por curso y las
 * privadas del docente NO aparecen aquí — esas se gestionan desde
 * /app/teacher/reports.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DialogDescription } from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { Badge } from "@/components/ui/badge";
import { SearchInput } from "@/components/ui/search-input";
import { ModuleGuard } from "@/shared/components/ModuleGuard";
import { friendlyError } from "@/shared/lib/db-errors";
import { parseDocxBundle, extractPlaceholders } from "@/modules/reports/docx-import";
import { buildAiReportPrompt, reportCatalogForScope } from "@/modules/reports/template-engine";
import { buildReportContext } from "@/modules/reports/report-context";
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
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { ClipboardList, Plus, Pencil, Trash2, Copy, Upload, Sparkles } from "lucide-react";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import {
  TemplateEditor,
  emptyDraft,
  draftEqual,
  type TemplateDraft,
} from "@/modules/reports/TemplateEditor";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/admin/report-templates")({
  component: AdminReportTemplates,
});

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
  updated_at: string;
};

function AdminReportTemplates() {
  return (
    <ModuleGuard module="reports">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const { t } = useTranslation();
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [search, setSearch] = useState("");

  // Dialog state
  const [editing, setEditing] = useState<Template | null>(null);
  const [draft, setDraft] = useState<TemplateDraft>(emptyDraft());
  const [original, setOriginal] = useState<TemplateDraft>(emptyDraft());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Cursos (para el contexto de la generación con IA). El admin/SA ve todos
  // por RLS. Se usan SOLO como "curso de referencia" para que la IA conozca
  // el shape de datos disponibles; la plantilla global NO queda atada al curso.
  const [courses, setCourses] = useState<Array<{ id: string; name: string }>>([]);
  // Cargar Word (.docx) → importa como plantilla global editable inline.
  const docxInputRef = useRef<HTMLInputElement>(null);
  // Generar con IA.
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiCourseId, setAiCourseId] = useState<string>("");
  const [aiBusy, setAiBusy] = useState(false);

  // SuperAdmin gestiona plantillas globales igual que Admin (módulo
  // compartido). Las plantillas viven a nivel plataforma, no tenant.
  const isAdmin = roles.includes("Admin") || roles.includes("SuperAdmin");

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("report_templates")
      .select(
        "id, name, description, scope, body_html, header_html, footer_html, css, page_orientation, page_size, updated_at",
      )
      .is("owner_id", null)
      .is("course_id", null)
      .order("name");
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar las plantillas."));
      setLoading(false);
      return;
    }
    setTemplates((data ?? []) as Template[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  // Cargar cursos para el "curso de referencia" de la IA (RLS acota al
  // alcance del admin/SA).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await db
        .from("courses")
        .select("id, name")
        .is("deleted_at", null)
        .order("name");
      if (!cancelled) setCourses((data ?? []) as Array<{ id: string; name: string }>);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Cargar Word (.docx) → plantilla global editable (HTML con formato) ──
  const handleDocxFile = async (file: File) => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Cuerpo + cabecera/pie + imágenes (logo) embebidas, para que la
      // plantilla refleje el .docx completo en preview y exportación.
      const { bodyHtml, headerHtml, footerHtml } = parseDocxBundle(bytes);
      if (!bodyHtml.trim() && !headerHtml.trim() && !footerHtml.trim()) {
        toast.error(
          i18n.t("adminReportTemplates.docxEmpty", {
            defaultValue: "El documento no contiene texto que importar.",
          }),
        );
        return;
      }
      const baseName = file.name.replace(/\.docx$/i, "").trim() || "Documento importado";
      const d: TemplateDraft = {
        ...emptyDraft(),
        name: baseName,
        body_html: bodyHtml,
        header_html: headerHtml,
        footer_html: footerHtml,
      };
      setEditing(null);
      setDraft(d);
      setOriginal(emptyDraft());
      setDialogOpen(true);
      const placeholders = extractPlaceholders(`${bodyHtml}\n${headerHtml}\n${footerHtml}`);
      toast.success(
        placeholders.length > 0
          ? i18n.t("adminReportTemplates.docxImportedWithVars", {
              defaultValue: "Word importado. Variables detectadas: {{vars}}",
              vars: placeholders.join(", "),
            })
          : i18n.t("adminReportTemplates.docxImported", {
              defaultValue: "Word importado. Edítalo e inserta variables del panel derecho.",
            }),
      );
    } catch (e) {
      toast.error(friendlyError(e, "No se pudo importar el documento."));
    }
  };

  // ── Generar con IA (inserta el resultado en el cuerpo del editor) ──
  const handleAiGenerate = async () => {
    if (!aiCourseId) {
      toast.error(
        i18n.t("adminReportTemplates.aiSelectCourse", {
          defaultValue: "Selecciona un curso de referencia para los datos.",
        }),
      );
      return;
    }
    setAiBusy(true);
    let system = "";
    let userMsg = "";
    try {
      const ctx = await buildReportContext({ courseId: aiCourseId, studentId: undefined });
      ({ system, user: userMsg } = buildAiReportPrompt({
        draftText: draft.body_html,
        instruction: aiInstruction,
        ctx,
        catalog: reportCatalogForScope(draft.scope),
      }));
    } catch (e) {
      setAiBusy(false);
      toast.error(friendlyError(e, "No se pudo preparar la generación con IA."));
      return;
    }
    try {
      const { data, error } = await db.functions.invoke("ai-generate-report", {
        body: { system, user: userMsg, courseId: aiCourseId },
      });
      const content = typeof data?.content === "string" ? data.content.trim() : "";
      if (!error && content) {
        setDraft((d) => ({ ...d, body_html: content }));
        setAiOpen(false);
        setAiBusy(false);
        toast.success(
          i18n.t("adminReportTemplates.aiGenerated", {
            defaultValue:
              "Informe generado con IA e insertado en el editor. Revisa los {{...}} antes de guardar.",
          }),
        );
        return;
      }
      if (error) console.warn("[admin-reports][ai-generate-report]", error);
    } catch (e) {
      console.warn("[admin-reports][ai-generate-report] invoke failed", e);
    }
    // Fallback: copiar el prompt al portapapeles.
    const prompt = `### SYSTEM\n${system}\n\n### USER\n${userMsg}`;
    let copied = false;
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
    } catch {
      copied = false;
    }
    setAiOpen(false);
    setAiBusy(false);
    toast.warning(
      copied
        ? i18n.t("adminReportTemplates.aiFallbackCopied", {
            defaultValue:
              "No se pudo generar con la IA de la plataforma. Copiamos el prompt al portapapeles — pégalo en tu IA y trae el resultado.",
          })
        : i18n.t("adminReportTemplates.aiFallbackReady", {
            defaultValue: "No se pudo generar con la IA. El prompt quedó en la consola.",
          }),
      { duration: 12000 },
    );
    if (!copied) {
      // eslint-disable-next-line no-console
      console.info("[admin-reports][ai-prompt]\n", prompt);
    }
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || (t.description?.toLowerCase().includes(q) ?? false),
    );
  }, [templates, search]);

  const openNew = () => {
    const d = emptyDraft();
    setEditing(null);
    setDraft(d);
    setOriginal(d);
    setDialogOpen(true);
  };

  const openEdit = (t: Template) => {
    const d: TemplateDraft = {
      name: t.name,
      description: t.description ?? "",
      scope: t.scope,
      body_html: t.body_html ?? "",
      header_html: t.header_html ?? "",
      footer_html: t.footer_html ?? "",
      css: t.css ?? "",
      page_orientation: t.page_orientation,
      page_size: t.page_size,
    };
    setEditing(t);
    setDraft(d);
    setOriginal(d);
    setDialogOpen(true);
  };

  const handleClose = async () => {
    if (!draftEqual(draft, original)) {
      const ok = await confirm({
        title: i18n.t("adminReportTemplates.discardChangesTitle"),
        description: i18n.t("adminReportTemplates.discardChangesDesc"),
        confirmLabel: i18n.t("adminReportTemplates.discardChangesConfirm"),
        tone: "warning",
      });
      if (!ok) return;
    }
    setDialogOpen(false);
  };

  const handleSave = async () => {
    if (!user) return;
    if (!draft.name.trim()) {
      toast.error(
        i18n.t("adminReportTemplates.nameRequired", {
          defaultValue: "El nombre es obligatorio",
        }),
      );
      return;
    }
    if (!draft.body_html.trim()) {
      toast.error(
        i18n.t("adminReportTemplates.bodyEmpty", {
          defaultValue: "El cuerpo no puede estar vacío",
        }),
      );
      return;
    }
    setSaving(true);
    // Nombre ÚNICO entre las plantillas globales (auto-sufija "(2)", "(3)"…).
    const takenNames = new Set(
      templates.filter((tpl) => tpl.id !== editing?.id).map((tpl) => tpl.name.trim().toLowerCase()),
    );
    let finalName = draft.name.trim();
    if (takenNames.has(finalName.toLowerCase())) {
      const root = finalName;
      for (let i = 2; i < 999; i++) {
        if (!takenNames.has(`${root} (${i})`.toLowerCase())) {
          finalName = `${root} (${i})`;
          break;
        }
      }
      toast.info(
        i18n.t("adminReportTemplates.nameAdjusted", {
          defaultValue: 'Ya existía una plantilla con ese nombre; se guardó como "{{name}}".',
          name: finalName,
        }),
      );
    }
    const payload = {
      name: finalName,
      description: draft.description.trim() || null,
      scope: draft.scope,
      body_html: draft.body_html,
      header_html: draft.header_html || null,
      footer_html: draft.footer_html || null,
      css: draft.css || null,
      page_orientation: draft.page_orientation,
      page_size: draft.page_size,
      updated_by: user.id,
      // Global = sin owner y sin curso
      owner_id: null,
      course_id: null,
      parent_id: null,
    };
    const { error } = editing
      ? await db.from("report_templates").update(payload).eq("id", editing.id)
      : await db.from("report_templates").insert({ ...payload, created_by: user.id });
    setSaving(false);
    if (error) {
      toast.error(friendlyError(error, "No se pudo guardar la plantilla"));
      return;
    }
    toast.success(
      editing
        ? i18n.t("adminReportTemplates.updatedOk", {
            defaultValue: "Plantilla actualizada",
          })
        : i18n.t("adminReportTemplates.createdOk", {
            defaultValue: "Plantilla creada",
          }),
    );
    setDialogOpen(false);
    void load();
  };

  const handleDelete = async (t: Template) => {
    const ok = await confirm({
      title: i18n.t("adminReportTemplates.deleteConfirmTitle", { name: t.name }),
      description: i18n.t("adminReportTemplates.deleteConfirmDesc"),
      confirmLabel: i18n.t("adminReportTemplates.deleteConfirmLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await db.from("report_templates").delete().eq("id", t.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("adminReportTemplates.deletedOk", {
        defaultValue: "Plantilla eliminada",
      }),
    );
    void load();
  };

  const handleDuplicate = async (t: Template) => {
    if (!user) return;
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
      owner_id: null,
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
    toast.success(
      i18n.t("adminReportTemplates.duplicatedOk", {
        defaultValue: "Plantilla duplicada",
      }),
    );
    void load();
  };

  if (!isAdmin) {
    return <p className="text-muted-foreground p-4">{t("adminReportTemplates.needsAdmin")}</p>;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ClipboardList className="h-5 w-5 text-pink-500" />}
        title={t("adminReportTemplates.title")}
        subtitle={loading ? undefined : t("adminReportTemplates.subtitleCount", { count: templates.length })}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => docxInputRef.current?.click()}>
              <Upload className="h-4 w-4 mr-1" />
              {t("adminReportTemplates.loadWordBtn")}
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4 mr-1" />
              {t("adminReportTemplates.newTemplateBtn")}
            </Button>
          </div>
        }
      />

      {/* Input oculto para cargar .docx (se dispara desde el botón). */}
      <input
        ref={docxInputRef}
        type="file"
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void handleDocxFile(f);
        }}
      />

      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t("adminReportTemplates.searchPlaceholder")}
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
            {loading ? (
              <TableSkeleton cols={4} rows={5} />
            ) : loadError ? (
              <ErrorState
                message="No pudimos cargar las plantillas"
                hint={loadError}
                onRetry={() => setRetryNonce((n) => n + 1)}
              />
            ) : (
              <Table fixed resizable>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-56">{t("adminReportTemplates.colName")}</TableHead>
                    <TableHead className="hidden md:table-cell">
                      {t("adminReportTemplates.colDescription")}
                    </TableHead>
                    <TableHead className="w-28">{t("adminReportTemplates.colType")}</TableHead>
                    <TableHead className="hidden sm:table-cell w-36">
                      {t("adminReportTemplates.colPage")}
                    </TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableEmpty
                      colSpan={5}
                      text={t("adminReportTemplates.emptyText")}
                      hint={t("adminReportTemplates.emptyHint")}
                    />
                  ) : (
                    filtered.map((tmpl) => (
                      <TableRow key={tmpl.id}>
                        <TableCell className="font-medium">
                          <div className="truncate" title={tmpl.name}>
                            {tmpl.name}
                          </div>
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                          <div className="truncate" title={tmpl.description ?? undefined}>
                            {tmpl.description ?? "—"}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {tmpl.scope === "curso" ? t("adminReportTemplates.scopeCourse") : t("adminReportTemplates.scopeStudent")}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                          {tmpl.page_size}{" "}
                          {tmpl.page_orientation === "portrait" ? t("adminReportTemplates.orientationPortrait") : t("adminReportTemplates.orientationLandscape")}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              { label: t("adminReportTemplates.actionEdit"), icon: Pencil, onClick: () => openEdit(tmpl) },
                              {
                                label: t("adminReportTemplates.actionDuplicate"),
                                icon: Copy,
                                onClick: () => void handleDuplicate(tmpl),
                              },
                              {
                                label: t("adminReportTemplates.actionDelete"),
                                icon: Trash2,
                                tone: "destructive",
                                separatorBefore: true,
                                onClick: () => void handleDelete(tmpl),
                              },
                            ]}
                          />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(o) => !o && void handleClose()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? t("adminReportTemplates.dialogEditTitle", { name: editing.name }) : t("adminReportTemplates.dialogNewTitle")}
            </DialogTitle>
          </DialogHeader>

          <TemplateEditor value={draft} onChange={setDraft} />

          <DialogFooter className="sm:justify-between">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setAiInstruction("");
                setAiCourseId(courses[0]?.id ?? "");
                setAiOpen(true);
              }}
              disabled={saving}
            >
              <Sparkles className="h-4 w-4 mr-1 text-violet-500" />
              {t("adminReportTemplates.generateWithAiBtn")}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => void handleClose()} disabled={saving}>
                {t("adminReportTemplates.cancelBtn")}
              </Button>
              <Button onClick={() => void handleSave()} disabled={saving}>
                {saving ? t("adminReportTemplates.savingBtn") : editing ? t("adminReportTemplates.saveChangesBtn") : t("adminReportTemplates.createTemplateBtn")}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dialog: Generar con IA — usa un curso de referencia para darle a la
          IA el shape de datos; la plantilla global no queda atada a él. */}
      <Dialog open={aiOpen} onOpenChange={(o) => !aiBusy && setAiOpen(o)}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("adminReportTemplates.aiDialogTitle")}</DialogTitle>
            <DialogDescription>
              {t("adminReportTemplates.aiDialogDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label required>{t("adminReportTemplates.aiRefCourseLabel")}</Label>
              <Select value={aiCourseId} onValueChange={setAiCourseId}>
                <SelectTrigger>
                  <SelectValue placeholder={t("adminReportTemplates.aiSelectCoursePlaceholder")} />
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
            <div className="space-y-1">
              <Label>{t("adminReportTemplates.aiInstructionLabel")}</Label>
              <Textarea
                value={aiInstruction}
                onChange={(e) => setAiInstruction(e.target.value)}
                placeholder={t("adminReportTemplates.aiInstructionPlaceholder")}
                className="min-h-[120px]"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAiOpen(false)} disabled={aiBusy}>
              {t("adminReportTemplates.cancelBtn")}
            </Button>
            <Button onClick={() => void handleAiGenerate()} disabled={aiBusy || !aiCourseId}>
              {aiBusy ? <Spinner size="sm" className="mr-1" /> : <Sparkles className="h-4 w-4 mr-1" />}
              {aiBusy ? t("adminReportTemplates.aiGeneratingBtn") : t("adminReportTemplates.aiGenerateBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

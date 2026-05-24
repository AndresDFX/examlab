/**
 * Admin — gestión de plantillas globales de informes.
 *
 * Lista todas las plantillas globales (owner_id IS NULL AND course_id IS NULL)
 * y permite crear/editar/eliminar. Los overrides por curso y las
 * privadas del docente NO aparecen aquí — esas se gestionan desde
 * /app/teacher/reports.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
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
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { FileText, Plus, Pencil, Trash2, Copy } from "lucide-react";
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

  const isAdmin = roles.includes("Admin");

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

  const filtered = useMemo(() => {
    if (!search.trim()) return templates;
    const q = search.toLowerCase();
    return templates.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description?.toLowerCase().includes(q) ?? false),
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
        title: "¿Descartar cambios?",
        description: "Hay cambios sin guardar que se perderán.",
        confirmLabel: "Descartar",
        tone: "warning",
      });
      if (!ok) return;
    }
    setDialogOpen(false);
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
    setSaving(true);
    const payload = {
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
    toast.success(editing ? "Plantilla actualizada" : "Plantilla creada");
    setDialogOpen(false);
    void load();
  };

  const handleDelete = async (t: Template) => {
    const ok = await confirm({
      title: `¿Eliminar "${t.name}"?`,
      description:
        "Los overrides que los docentes hayan hecho de esta plantilla quedarán huérfanos (parent_id NULL). " +
        "Esta acción no se puede deshacer.",
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
    toast.success("Plantilla duplicada");
    void load();
  };

  if (!isAdmin) {
    return <p className="text-muted-foreground p-4">Necesitas rol Admin.</p>;
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        icon={<FileText className="h-5 w-5 text-violet-500" />}
        title="Plantillas de informes"
        subtitle={loading ? undefined : `${templates.length} plantilla(s) global(es)`}
        actions={
          <Button onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" />
            Nueva plantilla
          </Button>
        }
      />

      <Card>
        <CardContent className="p-4 space-y-3">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Buscar por nombre o descripción…"
          />

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
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nombre</TableHead>
                    <TableHead className="hidden md:table-cell">Descripción</TableHead>
                    <TableHead>Scope</TableHead>
                    <TableHead className="hidden sm:table-cell">Página</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.length === 0 ? (
                    <TableEmpty
                      colSpan={5}
                      text="Sin plantillas"
                      hint="Crea la primera plantilla global con el botón de arriba."
                    />
                  ) : (
                    filtered.map((t) => (
                      <TableRow key={t.id}>
                        <TableCell className="font-medium">{t.name}</TableCell>
                        <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                          {t.description ?? "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {t.scope === "curso" ? "Curso" : "Estudiante"}
                          </Badge>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                          {t.page_size}{" "}
                          {t.page_orientation === "portrait" ? "vertical" : "horizontal"}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowActionsMenu
                            actions={[
                              { label: "Editar", icon: Pencil, onClick: () => openEdit(t) },
                              { label: "Duplicar", icon: Copy, onClick: () => void handleDuplicate(t) },
                              {
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
                    ))
                  )}
                </TableBody>
              </Table>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(o) => !o && void handleClose()}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? `Editar "${editing.name}"` : "Nueva plantilla global"}
            </DialogTitle>
          </DialogHeader>

          <TemplateEditor value={draft} onChange={setDraft} />

          <DialogFooter>
            <Button variant="outline" onClick={() => void handleClose()} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Guardando…" : editing ? "Guardar cambios" : "Crear plantilla"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

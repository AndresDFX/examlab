/**
 * Menú compacto para cargar/guardar plantillas de configuración
 * (assessment_templates). NO incluye preguntas — solo config (proctoring,
 * navegación, max_warnings, retry_mode, etc.).
 *
 * Uso:
 *   <AssessmentTemplateMenu
 *     target="exam"
 *     currentConfig={{ time_limit_minutes: 60, max_warnings: 3, ... }}
 *     onApply={(config) => setForm({ ...form, ...config })}
 *   />
 *
 * Renderiza un único Button con dropdown:
 *   ├── (lista de templates del usuario)
 *   ├── ─────────────────────
 *   └── Guardar config actual como template
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { RowAction } from "@/components/ui/row-action";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { LayoutTemplate, Save, Trash2 } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
  visibility: "private" | "public";
}

interface Props<T extends Record<string, unknown>> {
  target: "exam" | "workshop" | "project";
  /** Config actual del form — se usa al "guardar como template". */
  currentConfig: T;
  /** Callback para aplicar la config del template al form padre. */
  onApply: (config: T) => void;
  /** Subset de keys de config que se persisten al template (no datos). */
  configKeys: readonly (keyof T)[];
}

export function AssessmentTemplateMenu<T extends Record<string, unknown>>({
  target,
  currentConfig,
  onApply,
  configKeys,
}: Props<T>) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [loading, setLoading] = useState(false);

  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDesc, setDraftDesc] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!user) return;
    setLoading(true);
    const { data, error } = await db
      .from("assessment_templates")
      .select("id, name, description, config, visibility")
      .eq("target", target)
      .order("name");
    if (error) {
      toast.error(friendlyError(error));
      setLoading(false);
      return;
    }
    setTemplates((data ?? []) as TemplateRow[]);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, user?.id]);

  const apply = (tpl: TemplateRow) => {
    // Solo aplicamos las keys que el template trae Y que el form acepta.
    const next: Record<string, unknown> = { ...currentConfig };
    for (const key of configKeys) {
      const k = String(key);
      if (k in tpl.config) {
        next[k] = tpl.config[k];
      }
    }
    onApply(next as T);
    toast.success(
      i18n.t("toast.shared_components_AssessmentTemplateMenu.templateApplied", {
        defaultValue: 'Plantilla "{{name}}" aplicada',
        name: tpl.name,
      }),
    );
  };

  const remove = async (tpl: TemplateRow) => {
    const { error } = await db.from("assessment_templates").delete().eq("id", tpl.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.shared_components_AssessmentTemplateMenu.templateDeleted", {
        defaultValue: "Plantilla eliminada",
      }),
    );
    await load();
  };

  const saveAsTemplate = async () => {
    if (!user) return;
    const name = draftName.trim();
    if (!name) {
      toast.error(
        i18n.t("toast.shared_components_AssessmentTemplateMenu.nameRequired", {
          defaultValue: "Ingresa un nombre",
        }),
      );
      return;
    }
    setSaving(true);
    try {
      // Solo guardamos las keys de config (descartar datos como fechas, course_id, title).
      const cfg: Record<string, unknown> = {};
      for (const key of configKeys) {
        cfg[String(key)] = currentConfig[key];
      }
      const { error } = await db.from("assessment_templates").insert({
        created_by: user.id,
        target,
        name,
        description: draftDesc.trim() || null,
        visibility: "private",
        config: cfg,
      });
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        i18n.t("toast.shared_components_AssessmentTemplateMenu.templateSaved", {
          defaultValue: "Plantilla guardada",
        }),
      );
      setSaveDialogOpen(false);
      setDraftName("");
      setDraftDesc("");
      await load();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            <LayoutTemplate className="h-4 w-4 mr-1" />
            {t("hc_sharedComponentsAssessmentTemplateMenu.templates")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t("hc_sharedComponentsAssessmentTemplateMenu.applyTemplate")}
          </DropdownMenuLabel>
          {loading ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("hc_sharedComponentsAssessmentTemplateMenu.loading")}
            </div>
          ) : templates.length === 0 ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">
              {t("hc_sharedComponentsAssessmentTemplateMenu.noTemplates")}
            </div>
          ) : (
            templates.map((tpl) => (
              <DropdownMenuItem
                key={tpl.id}
                onClick={() => apply(tpl)}
                className="flex justify-between gap-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{tpl.name}</div>
                  {tpl.description && (
                    <div className="truncate text-[11px] text-muted-foreground">
                      {tpl.description}
                    </div>
                  )}
                </div>
                <RowAction
                  label={t("hc_sharedComponentsAssessmentTemplateMenu.delete")}
                  icon={Trash2}
                  tone="destructive"
                  className="shrink-0"
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(tpl);
                  }}
                />
              </DropdownMenuItem>
            ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setSaveDialogOpen(true)} className="gap-2">
            <Save className="h-3.5 w-3.5" />
            {t("hc_sharedComponentsAssessmentTemplateMenu.saveCurrentAsTemplate")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("hc_sharedComponentsAssessmentTemplateMenu.saveTemplateTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("hc_sharedComponentsAssessmentTemplateMenu.saveTemplateDescription", {
                target:
                  target === "exam"
                    ? t("hc_sharedComponentsAssessmentTemplateMenu.targetExam")
                    : target === "workshop"
                      ? t("hc_sharedComponentsAssessmentTemplateMenu.targetWorkshop")
                      : t("hc_sharedComponentsAssessmentTemplateMenu.targetProject"),
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label required>
                {t("hc_sharedComponentsAssessmentTemplateMenu.nameLabel")}
              </Label>
              <Input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t("hc_sharedComponentsAssessmentTemplateMenu.namePlaceholder")}
              />
            </div>
            <div>
              <Label>
                {t("hc_sharedComponentsAssessmentTemplateMenu.descriptionLabel")}
              </Label>
              <Textarea
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
                rows={2}
                placeholder={t(
                  "hc_sharedComponentsAssessmentTemplateMenu.descriptionPlaceholder",
                )}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setSaveDialogOpen(false)}
              disabled={saving}
            >
              {t("hc_sharedComponentsAssessmentTemplateMenu.cancel")}
            </Button>
            <Button onClick={() => void saveAsTemplate()} disabled={saving}>
              {saving ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              {t("hc_sharedComponentsAssessmentTemplateMenu.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

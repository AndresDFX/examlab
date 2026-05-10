import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { useConfirm } from "@/components/ConfirmDialog";
import { Save, RotateCcw, Palette, Sparkles } from "lucide-react";

export const Route = createFileRoute("/app/admin/contenidos-config")({
  component: AdminContentsConfig,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface BrandConfig {
  id?: string;
  university_name: string;
  logo_url: string | null;
  primary_color: string;
  secondary_color: string;
  author_default: string | null;
}

interface PromptRow {
  id: string;
  use_case: string;
  course_id: string | null;
  system_prompt: string;
}

const DEFAULT_BRAND: BrandConfig = {
  university_name: "",
  logo_url: null,
  primary_color: "#1e40af",
  secondary_color: "#64748b",
  author_default: null,
};

function AdminContentsConfig() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [brand, setBrand] = useState<BrandConfig>(DEFAULT_BRAND);
  const [prompt, setPrompt] = useState<PromptRow | null>(null);
  const [defaultPrompt, setDefaultPrompt] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [savingBrand, setSavingBrand] = useState(false);
  const [savingPrompt, setSavingPrompt] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: brandRow }, { data: promptRow }] = await Promise.all([
      db.from("content_brand_config").select("*").maybeSingle(),
      db
        .from("ai_prompts")
        .select("id, use_case, course_id, system_prompt")
        .eq("use_case", "content_generation")
        .is("course_id", null)
        .maybeSingle(),
    ]);
    if (brandRow) setBrand({ ...DEFAULT_BRAND, ...(brandRow as BrandConfig) });
    if (promptRow) {
      setPrompt(promptRow as PromptRow);
      // Guardamos el "valor cargado de DB" como default-restore. La
      // primera carga después del seed contiene el prompt original; si
      // el admin lo edita y quiere restaurar, podemos volver a este
      // valor — para una versión más sólida, leeríamos un default
      // hardcoded aquí. Por ahora, usamos el último prompt persistido.
      setDefaultPrompt((promptRow as PromptRow).system_prompt);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saveBrand = async () => {
    if (!user) return;
    setSavingBrand(true);
    try {
      const payload = {
        ...brand,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      };
      // El singleton garantiza una sola fila — usamos upsert genérico
      // sobre el id si lo tenemos, o insert en caso contrario.
      const { error } = brand.id
        ? await db.from("content_brand_config").update(payload).eq("id", brand.id)
        : await db.from("content_brand_config").insert(payload);
      if (error) throw new Error(error.message);
      toast.success(t("contentsConfig.savedBrand"));
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingBrand(false);
    }
  };

  const savePrompt = async () => {
    if (!prompt) return;
    setSavingPrompt(true);
    try {
      const { error } = await db
        .from("ai_prompts")
        .update({ system_prompt: prompt.system_prompt })
        .eq("id", prompt.id);
      if (error) throw new Error(error.message);
      toast.success(t("contentsConfig.savedPrompt"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingPrompt(false);
    }
  };

  const restoreDefault = async () => {
    if (!prompt) return;
    const ok = await confirm({
      title: t("contentsConfig.restoreConfirmTitle"),
      description: t("contentsConfig.restoreConfirmBody"),
      confirmLabel: t("contentsConfig.restoreConfirm"),
      tone: "warning",
    });
    if (!ok) return;
    setPrompt({ ...prompt, system_prompt: defaultPrompt });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-10">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Palette className="h-5 w-5 text-primary" />
          {t("contentsConfig.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("contentsConfig.subtitle")}</p>
      </div>

      {/* Brand */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("contentsConfig.brandSection")}</CardTitle>
          <p className="text-xs text-muted-foreground">{t("contentsConfig.brandHint")}</p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t("contentsConfig.universityName")}</Label>
              <Input
                value={brand.university_name}
                onChange={(e) => setBrand({ ...brand, university_name: e.target.value })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>{t("contentsConfig.logoUrl")}</Label>
              <Input
                type="url"
                value={brand.logo_url ?? ""}
                onChange={(e) => setBrand({ ...brand, logo_url: e.target.value || null })}
                placeholder="https://…/logo.png"
              />
              <p className="text-[11px] text-muted-foreground">{t("contentsConfig.logoHelper")}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("contentsConfig.primaryColor")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={brand.primary_color}
                  onChange={(e) => setBrand({ ...brand, primary_color: e.target.value })}
                  className="h-9 w-14 p-1"
                />
                <Input
                  value={brand.primary_color}
                  onChange={(e) => setBrand({ ...brand, primary_color: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("contentsConfig.secondaryColor")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  type="color"
                  value={brand.secondary_color}
                  onChange={(e) => setBrand({ ...brand, secondary_color: e.target.value })}
                  className="h-9 w-14 p-1"
                />
                <Input
                  value={brand.secondary_color}
                  onChange={(e) => setBrand({ ...brand, secondary_color: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>{t("contentsConfig.authorDefault")}</Label>
              <Input
                value={brand.author_default ?? ""}
                onChange={(e) => setBrand({ ...brand, author_default: e.target.value || null })}
              />
              <p className="text-[11px] text-muted-foreground">
                {t("contentsConfig.authorDefaultHelper")}
              </p>
            </div>
          </div>

          {/* Preview */}
          <div className="rounded-md border p-3 bg-muted/30">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
              {t("contentsConfig.preview")}
            </div>
            <div className="flex items-center gap-3">
              {brand.logo_url ? (
                // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
                <img
                  src={brand.logo_url}
                  alt=""
                  className="h-10 w-10 object-contain rounded bg-white border"
                />
              ) : (
                <div className="h-10 w-10 rounded bg-white border flex items-center justify-center text-muted-foreground">
                  <Palette className="h-4 w-4" />
                </div>
              )}
              <div className="flex-1">
                <div className="font-semibold" style={{ color: brand.primary_color }}>
                  {brand.university_name || "—"}
                </div>
                <div className="text-xs" style={{ color: brand.secondary_color }}>
                  {brand.author_default || ""}
                </div>
              </div>
            </div>
          </div>

          <div className="flex justify-end">
            <Button onClick={saveBrand} disabled={savingBrand}>
              {savingBrand ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              {t("contentsConfig.saveBrand")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Prompt */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            {t("contentsConfig.promptSection")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">{t("contentsConfig.promptHint")}</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={prompt?.system_prompt ?? ""}
            onChange={(e) => prompt && setPrompt({ ...prompt, system_prompt: e.target.value })}
            className="font-mono text-xs min-h-[400px]"
          />
          <div className="flex justify-between items-center">
            <Button variant="ghost" onClick={restoreDefault} disabled={!prompt}>
              <RotateCcw className="h-4 w-4 mr-1" />
              {t("contentsConfig.restoreDefault")}
            </Button>
            <Button onClick={savePrompt} disabled={!prompt || savingPrompt}>
              {savingPrompt ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              {t("contentsConfig.savePrompt")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

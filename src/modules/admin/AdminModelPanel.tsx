/**
 * Panel de configuración del modelo de IA activo (Admin).
 *
 * V1: una única configuración global. Provider + modelo. Las API keys
 * viven como secrets en Lovable (LOVABLE_API_KEY, OPENAI_API_KEY,
 * GEMINI_API_KEY) — nunca en DB. Si una key expira el admin la rota
 * desde Lovable → Edge Function Secrets, no desde acá.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Save, Info, Cpu } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Provider = "lovable" | "openai" | "gemini";

type ModelRow = {
  id: string;
  provider: Provider;
  model: string;
  is_active: boolean;
};

const PROVIDER_LABELS: Record<Provider, string> = {
  lovable: "Lovable AI Gateway (Gemini)",
  openai: "OpenAI",
  gemini: "Google Gemini (directo)",
};

const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  lovable: ["google/gemini-2.5-flash", "google/gemini-2.5-pro", "google/gemini-2.0-flash"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
};

const SECRET_NAME: Record<Provider, string> = {
  lovable: "LOVABLE_API_KEY",
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function AdminModelPanel() {
  const { user } = useAuth();
  const [activeRow, setActiveRow] = useState<ModelRow | null>(null);
  const [draftProvider, setDraftProvider] = useState<Provider>("lovable");
  const [draftModel, setDraftModel] = useState<string>("google/gemini-2.5-flash");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("ai_model_settings")
      .select("id, provider, model, is_active")
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar la configuración del modelo."));
      setLoading(false);
      return;
    }
    if (data) {
      const row = data as ModelRow;
      setActiveRow(row);
      setDraftProvider(row.provider);
      setDraftModel(row.model);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const dirty =
    !activeRow ||
    draftProvider !== activeRow.provider ||
    draftModel !== activeRow.model;

  const handleProviderChange = (p: Provider) => {
    setDraftProvider(p);
    if (!MODEL_SUGGESTIONS[p].includes(draftModel)) {
      setDraftModel(MODEL_SUGGESTIONS[p][0]);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    if (!draftModel.trim()) {
      toast.error("Especifica un modelo");
      return;
    }
    setSaving(true);
    try {
      const { error: deactErr } = await db
        .from("ai_model_settings")
        .update({ is_active: false, updated_by: user.id })
        .eq("is_active", true);
      if (deactErr) {
        toast.error(friendlyError(deactErr));
        return;
      }
      const { error: insErr } = await db.from("ai_model_settings").insert({
        provider: draftProvider,
        model: draftModel.trim(),
        is_active: true,
        updated_by: user.id,
      });
      if (insErr) {
        toast.error(friendlyError(insErr));
        return;
      }
      void logEvent({
        action: "ai_model.activated",
        category: "system",
        severity: "warning",
        entityType: "ai_model_settings",
        entityName: `${draftProvider}:${draftModel}`,
        metadata: {
          previous_provider: activeRow?.provider ?? null,
          previous_model: activeRow?.model ?? null,
          new_provider: draftProvider,
          new_model: draftModel.trim(),
        },
      });
      toast.success("Configuración del modelo actualizada");
      await load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="md" /> Cargando configuración…
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar la configuración del modelo"
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  const suggestions = MODEL_SUGGESTIONS[draftProvider];
  const datalistId = `ai-model-suggestions-${draftProvider}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Cpu className="h-4 w-4 text-indigo-500" />
          Modelo activo
          {activeRow && (
            <Badge variant="secondary" className="text-[10px]">
              {PROVIDER_LABELS[activeRow.provider]} · {activeRow.model}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          Define qué modelo usa el edge function de calificación con IA. La configuración es
          global para toda la plataforma.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>Proveedor</Label>
          <Select value={draftProvider} onValueChange={(v) => handleProviderChange(v as Provider)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="lovable">{PROVIDER_LABELS.lovable}</SelectItem>
              <SelectItem value="openai">{PROVIDER_LABELS.openai}</SelectItem>
              <SelectItem value="gemini">{PROVIDER_LABELS.gemini}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div>
          <Label>
            Modelo{" "}
            <HelpHint>
              Identificador exacto del modelo según el provider. Sugerencias en el menú; puedes
              escribir cualquier modelo soportado.
            </HelpHint>
          </Label>
          <Input
            list={datalistId}
            value={draftModel}
            onChange={(e) => setDraftModel(e.target.value)}
            placeholder={suggestions[0]}
            className="font-mono text-sm"
          />
          <datalist id={datalistId}>
            {suggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </div>

        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-xs space-y-1">
            <p>
              La API key de <strong>{PROVIDER_LABELS[draftProvider]}</strong> se lee del secret{" "}
              <code className="text-[11px]">{SECRET_NAME[draftProvider]}</code> configurado en
              Lovable → Edge Function Secrets. Si está vacío o inválido, las llamadas de IA fallarán
              con mensaje accionable.
            </p>
          </AlertDescription>
        </Alert>

        <div className="flex flex-wrap gap-2 justify-end pt-1">
          {dirty && activeRow && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraftProvider(activeRow.provider);
                setDraftModel(activeRow.model);
              }}
              disabled={saving}
            >
              Cancelar
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? <Spinner size="md" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            Guardar configuración
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

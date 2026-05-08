/**
 * Panel de configuración del modelo de IA activo (Admin).
 *
 * V1: una única configuración global. Provider + modelo. Las API keys
 * viven como secrets en Lovable (LOVABLE_API_KEY, OPENAI_API_KEY) — no
 * se guardan en DB.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
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
import { Loader2, Save, Info, Cpu } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Provider = "lovable" | "openai";

type ModelRow = {
  id: string;
  provider: Provider;
  model: string;
  is_active: boolean;
};

const PROVIDER_LABELS: Record<Provider, string> = {
  lovable: "Lovable AI Gateway (Gemini)",
  openai: "OpenAI",
};

// Sugerencias por provider — el admin puede escribir cualquier id de
// modelo soportado, pero ofrecemos los más comunes en un datalist.
const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  lovable: ["google/gemini-2.5-flash", "google/gemini-2.5-pro", "google/gemini-2.0-flash"],
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini"],
};

const SECRET_NAME: Record<Provider, string> = {
  lovable: "LOVABLE_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function AdminModelPanel() {
  const { user } = useAuth();
  const [activeRow, setActiveRow] = useState<ModelRow | null>(null);
  const [draftProvider, setDraftProvider] = useState<Provider>("lovable");
  const [draftModel, setDraftModel] = useState<string>("google/gemini-2.5-flash");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db
      .from("ai_model_settings")
      .select("id, provider, model, is_active")
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      toast.error(error.message);
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
  }, []);

  const dirty =
    !activeRow || draftProvider !== activeRow.provider || draftModel !== activeRow.model;

  const handleProviderChange = (p: Provider) => {
    setDraftProvider(p);
    // Si el modelo actual no está en sugerencias del nuevo provider, sugiere el primero
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
      // Estrategia: siempre crear una nueva fila activa y desactivar las
      // anteriores. Mantiene historial en DB sin tocar el unique partial.
      // Paso 1: desactivar todas las activas actuales
      const { error: deactErr } = await db
        .from("ai_model_settings")
        .update({ is_active: false, updated_by: user.id })
        .eq("is_active", true);
      if (deactErr) {
        toast.error(deactErr.message);
        return;
      }
      // Paso 2: insertar la nueva como activa
      const { error: insErr } = await db.from("ai_model_settings").insert({
        provider: draftProvider,
        model: draftModel.trim(),
        is_active: true,
        updated_by: user.id,
      });
      if (insErr) {
        toast.error(insErr.message);
        return;
      }
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
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando configuración…
        </CardContent>
      </Card>
    );
  }

  const suggestions = MODEL_SUGGESTIONS[draftProvider];
  const datalistId = `ai-model-suggestions-${draftProvider}`;

  return (
    <div className="space-y-4">
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
            <Select
              value={draftProvider}
              onValueChange={(v) => handleProviderChange(v as Provider)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="lovable">{PROVIDER_LABELS.lovable}</SelectItem>
                <SelectItem value="openai">{PROVIDER_LABELS.openai}</SelectItem>
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
                Lovable. Si está vacío, las llamadas de IA fallarán.
              </p>
              {draftProvider === "openai" && (
                <p>
                  Configura el secret en Lovable → Settings → Edge Function Secrets antes de cambiar
                  a este proveedor.
                </p>
              )}
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
              {saving ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              Guardar configuración
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

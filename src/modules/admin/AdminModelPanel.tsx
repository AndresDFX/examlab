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
  lovable_api_key: string | null;
  openai_api_key: string | null;
  gemini_api_key: string | null;
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
  // API keys per-tenant. Sentinel `"__keep"` indica "no cambiar la existente"
  // (cuando el admin abre el panel sin tocar el campo, no la sobrescribimos).
  // Cualquier otro string la reemplaza; "" la borra.
  const [draftLovableKey, setDraftLovableKey] = useState<string>("__keep");
  const [draftOpenaiKey, setDraftOpenaiKey] = useState<string>("__keep");
  const [draftGeminiKey, setDraftGeminiKey] = useState<string>("__keep");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("ai_model_settings")
      .select("id, provider, model, is_active, lovable_api_key, openai_api_key, gemini_api_key")
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
      setDraftLovableKey("__keep");
      setDraftOpenaiKey("__keep");
      setDraftGeminiKey("__keep");
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
    draftModel !== activeRow.model ||
    draftLovableKey !== "__keep" ||
    draftOpenaiKey !== "__keep" ||
    draftGeminiKey !== "__keep";

  // Helper para mostrar "••••XXXX" cuando hay una key guardada pero el
  // admin no la está editando. Si la key no existe, muestra placeholder.
  const maskKey = (k: string | null | undefined): string =>
    k && k.length > 4 ? `••••${k.slice(-4)}` : "";

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
      // Resolución de keys: si el admin no las tocó ("__keep"), heredan
      // las del activeRow. Si las cambió, usa el nuevo valor (incluido "" = borrar).
      const nextLovableKey =
        draftLovableKey === "__keep" ? activeRow?.lovable_api_key ?? null : draftLovableKey || null;
      const nextOpenaiKey =
        draftOpenaiKey === "__keep" ? activeRow?.openai_api_key ?? null : draftOpenaiKey || null;
      const nextGeminiKey =
        draftGeminiKey === "__keep" ? activeRow?.gemini_api_key ?? null : draftGeminiKey || null;

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
        lovable_api_key: nextLovableKey,
        openai_api_key: nextOpenaiKey,
        gemini_api_key: nextGeminiKey,
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

        {/* API keys per-tenant.
            - Cada institución gestiona su propia key y sus propios
              costos de IA.
            - Si dejas un campo vacío, la edge cae al env legacy
              (Lovable Secrets) — útil para tenant default + onboarding.
            - "Mantener actual" significa: no tocar el valor previo.
              Útil para edits parciales sin re-pegar la key. */}
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-xs">
            Configura las API keys de tu institución. Cada institución gestiona sus propias
            keys y costos de IA. Si dejas un campo vacío al guardar, la plataforma cae al
            secret configurado por el SuperAdmin (<code>{SECRET_NAME[draftProvider]}</code>).
          </AlertDescription>
        </Alert>

        <ApiKeyInput
          label="API key — Lovable AI Gateway"
          stored={activeRow?.lovable_api_key ?? null}
          value={draftLovableKey}
          onChange={setDraftLovableKey}
          maskFn={maskKey}
          help="LOVABLE_API_KEY — créditos administrados por Lovable."
        />
        <ApiKeyInput
          label="API key — OpenAI"
          stored={activeRow?.openai_api_key ?? null}
          value={draftOpenaiKey}
          onChange={setDraftOpenaiKey}
          maskFn={maskKey}
          help="sk-... desde platform.openai.com. Cobra a tu cuenta OpenAI."
        />
        <ApiKeyInput
          label="API key — Google Gemini (directo)"
          stored={activeRow?.gemini_api_key ?? null}
          value={draftGeminiKey}
          onChange={setDraftGeminiKey}
          maskFn={maskKey}
          help="AIza... desde Google AI Studio. Cobra a tu proyecto GCP."
        />

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

/**
 * ApiKeyInput — campo para una API key con UX no-destructivo.
 *
 * Cuando hay una key guardada (stored != null) el placeholder muestra
 * "••••XXXX" para no exponer la key completa. El admin puede:
 *   - Dejar el campo en "Mantener actual" → no se modifica.
 *   - Tipear una nueva key → reemplaza al guardar.
 *   - Click "Borrar" → setea "" (vacío) → al guardar la columna queda NULL
 *     y la edge cae al env legacy.
 */
function ApiKeyInput({
  label,
  stored,
  value,
  onChange,
  maskFn,
  help,
}: {
  label: string;
  stored: string | null;
  value: string;
  onChange: (v: string) => void;
  maskFn: (k: string | null) => string;
  help?: string;
}) {
  const isKeep = value === "__keep";
  const masked = maskFn(stored);
  return (
    <div>
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          type="password"
          value={isKeep ? "" : value}
          placeholder={isKeep && masked ? masked : "Sin configurar — usa env legacy"}
          onChange={(e) => onChange(e.target.value)}
          className="flex-1 font-mono text-xs"
        />
        {!isKeep && (
          <Button variant="ghost" size="sm" onClick={() => onChange("__keep")}>
            Cancelar
          </Button>
        )}
        {isKeep && stored && (
          <Button variant="ghost" size="sm" onClick={() => onChange("")} title="Borrar y usar env legacy">
            Borrar
          </Button>
        )}
      </div>
      {help && <p className="text-[11px] text-muted-foreground mt-1">{help}</p>}
    </div>
  );
}

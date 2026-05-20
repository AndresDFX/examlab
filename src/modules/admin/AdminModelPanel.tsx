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
import { Save, Info, Cpu, Eye, EyeOff, KeyRound } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Provider = "lovable" | "openai" | "gemini";

type ModelRow = {
  id: string;
  provider: Provider;
  model: string;
  is_active: boolean;
  gemini_api_key: string | null;
};

const PROVIDER_LABELS: Record<Provider, string> = {
  lovable: "Lovable AI Gateway (Gemini)",
  openai: "OpenAI",
  gemini: "Google Gemini (directo)",
};

// Sugerencias por provider — el admin puede escribir cualquier id de
// modelo soportado, pero ofrecemos los más comunes en un datalist.
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
  // La API key se edita opt-in: si el admin no toca el campo, NO la cambiamos
  // (se preserva la actual en DB). `null` = sin cambios; string vacío = limpiar
  // y caer al env var; cualquier otro string = guardar como override.
  const [draftGeminiKey, setDraftGeminiKey] = useState<string | null>(null);
  const [showGeminiKey, setShowGeminiKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db
      .from("ai_model_settings")
      .select("id, provider, model, is_active, gemini_api_key")
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      toast.error(friendlyError(error));
      setLoading(false);
      return;
    }
    if (data) {
      const row = data as ModelRow;
      setActiveRow(row);
      setDraftProvider(row.provider);
      setDraftModel(row.model);
      setDraftGeminiKey(null); // sin cambios pendientes al cargar
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty =
    !activeRow ||
    draftProvider !== activeRow.provider ||
    draftModel !== activeRow.model ||
    draftGeminiKey !== null;

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
        toast.error(friendlyError(deactErr));
        return;
      }
      // Paso 2: insertar la nueva como activa. Gemini API key:
      //  - draftGeminiKey === null  → preservamos el valor anterior (sin cambios)
      //  - draftGeminiKey === ""    → limpiamos (vuelve a usar env var)
      //  - draftGeminiKey === "..." → guardamos como override
      const geminiKeyToWrite =
        draftGeminiKey === null
          ? (activeRow?.gemini_api_key ?? null)
          : draftGeminiKey.trim() === ""
            ? null
            : draftGeminiKey.trim();
      const { error: insErr } = await db.from("ai_model_settings").insert({
        provider: draftProvider,
        model: draftModel.trim(),
        gemini_api_key: geminiKeyToWrite,
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
                <Spinner size="md" className="mr-1" />
              ) : (
                <Save className="h-4 w-4 mr-1" />
              )}
              Guardar configuración
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Gemini API key — solo relevante cuando el provider activo es 'gemini'.
          Mostramos la card siempre (para que el admin pueda pre-configurar
          antes de cambiar de provider), pero con nota explicando. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-amber-500" />
            API key de Gemini
            <HelpHint>
              Override editable desde la UI. Si está vacío, la edge function usa la env var
              <code className="text-[11px]"> GEMINI_API_KEY</code> como fallback. Solo aplica cuando
              el provider activo es <strong>Gemini</strong>.
            </HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            La key se guarda en DB (RLS Admin-only). Visible solo para administradores con sesión.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Clave de API</Label>
            <div className="flex items-center gap-2">
              <Input
                type={showGeminiKey ? "text" : "password"}
                value={draftGeminiKey !== null ? draftGeminiKey : (activeRow?.gemini_api_key ?? "")}
                onChange={(e) => setDraftGeminiKey(e.target.value)}
                placeholder={
                  activeRow?.gemini_api_key
                    ? "(configurada — vacía para usar env var)"
                    : "AIza... — vacío para usar GEMINI_API_KEY del entorno"
                }
                className="font-mono text-sm"
                autoComplete="off"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowGeminiKey((v) => !v)}
              >
                {showGeminiKey ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1">
              {activeRow?.gemini_api_key
                ? "Hay una key configurada en DB. Edita para reemplazarla, deja vacío para limpiar y volver al env var."
                : "No hay key en DB. Las llamadas Gemini usan la env var GEMINI_API_KEY."}
            </p>
          </div>
          {draftProvider !== "gemini" && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="text-xs">
                Esta clave solo se usa cuando el provider activo es <strong>Gemini</strong>. El
                provider actual es <strong>{PROVIDER_LABELS[draftProvider]}</strong>.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

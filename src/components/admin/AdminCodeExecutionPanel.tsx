/**
 * Panel de configuración del proveedor de ejecución de código (Admin).
 *
 * Proveedores:
 *   onlinecompiler — OnlineCompiler.io (principal, sin cuota diaria)
 *   jdoodle        — JDoodle (fallback, requiere JDOODLE_CLIENT_ID + JDOODLE_CLIENT_SECRET)
 *   cheerp         — CheerpJ browser-side (Java corre en el navegador; otros lenguajes
 *                    usan OnlineCompiler.io igualmente)
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { HelpHint } from "@/components/ui/help-hint";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { Save, Info, Code2, Loader2 } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type CodeProvider = "onlinecompiler" | "jdoodle" | "cheerp";

type ProviderRow = {
  id: string;
  provider: CodeProvider;
  is_active: boolean;
};

const PROVIDER_LABELS: Record<CodeProvider, string> = {
  onlinecompiler: "OnlineCompiler.io (recomendado)",
  jdoodle:        "JDoodle",
  cheerp:         "CheerpJ — navegador (solo Java)",
};

const PROVIDER_DESCRIPTION: Record<CodeProvider, string> = {
  onlinecompiler:
    "API síncrona, 12 lenguajes, sin cuota diaria. Requiere el secret ONLINE_COMPILER_API_KEY.",
  jdoodle:
    "API clásica de JDoodle. Cuota de 200 ejecuciones/día en el plan gratuito. Requiere JDOODLE_CLIENT_ID y JDOODLE_CLIENT_SECRET.",
  cheerp:
    "Java corre completamente en el navegador del estudiante (WebAssembly). Sin API externa ni cuota. Los demás lenguajes siguen usando OnlineCompiler.io.",
};

const PROVIDER_SECRETS: Record<CodeProvider, string[]> = {
  onlinecompiler: ["ONLINE_COMPILER_API_KEY"],
  jdoodle:        ["JDOODLE_CLIENT_ID", "JDOODLE_CLIENT_SECRET"],
  cheerp:         ["ONLINE_COMPILER_API_KEY (para lenguajes distintos a Java)"],
};

export function AdminCodeExecutionPanel() {
  const { user } = useAuth();
  const [activeRow, setActiveRow]       = useState<ProviderRow | null>(null);
  const [draftProvider, setDraftProvider] = useState<CodeProvider>("onlinecompiler");
  const [loading, setLoading]           = useState(true);
  const [saving, setSaving]             = useState(false);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db
      .from("code_execution_settings")
      .select("id, provider, is_active")
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (data) {
      const row = data as ProviderRow;
      setActiveRow(row);
      setDraftProvider(row.provider);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dirty = !activeRow || draftProvider !== activeRow.provider;

  const handleSave = async () => {
    if (!user) return;
    setSaving(true);
    try {
      // Desactivar todas las activas
      const { error: deactErr } = await db
        .from("code_execution_settings")
        .update({ is_active: false, updated_by: user.id })
        .eq("is_active", true);
      if (deactErr) { toast.error(deactErr.message); return; }

      // Insertar nueva activa
      const { error: insErr } = await db
        .from("code_execution_settings")
        .insert({ provider: draftProvider, is_active: true, updated_by: user.id });
      if (insErr) { toast.error(insErr.message); return; }

      void logEvent({
        action: "code_execution.provider_changed",
        category: "system",
        severity: "warning",
        entityType: "code_execution_settings",
        entityName: draftProvider,
        metadata: {
          previous_provider: activeRow?.provider ?? null,
          new_provider: draftProvider,
        },
      });

      toast.success("Proveedor de ejecución actualizado");
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

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Code2 className="h-4 w-4 text-indigo-500" />
            Proveedor de ejecución de código
            {activeRow && (
              <Badge variant="secondary" className="text-[10px]">
                {PROVIDER_LABELS[activeRow.provider]}
              </Badge>
            )}
            <HelpHint>
              Define qué motor ejecuta el código de los estudiantes en preguntas tipo "código".
              El cambio aplica de inmediato para todos los exámenes.
            </HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Configuración global para toda la plataforma. Si un proveedor falla, cambia aquí sin
            redeployar.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <RadioGroup
            value={draftProvider}
            onValueChange={(v) => setDraftProvider(v as CodeProvider)}
            className="space-y-3"
          >
            {(["onlinecompiler", "jdoodle", "cheerp"] as CodeProvider[]).map((p) => (
              <div
                key={p}
                className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                  draftProvider === p
                    ? "border-indigo-500 bg-indigo-50 dark:bg-indigo-950/20"
                    : "hover:bg-muted/50"
                }`}
                onClick={() => setDraftProvider(p)}
              >
                <RadioGroupItem value={p} id={`provider-${p}`} className="mt-0.5" />
                <div className="space-y-0.5">
                  <Label htmlFor={`provider-${p}`} className="text-sm font-medium cursor-pointer">
                    {PROVIDER_LABELS[p]}
                  </Label>
                  <p className="text-xs text-muted-foreground">{PROVIDER_DESCRIPTION[p]}</p>
                </div>
              </div>
            ))}
          </RadioGroup>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs space-y-1">
              <p>
                Secrets requeridos para <strong>{PROVIDER_LABELS[draftProvider]}</strong>:
              </p>
              <ul className="list-disc list-inside space-y-0.5">
                {PROVIDER_SECRETS[draftProvider].map((s) => (
                  <li key={s}>
                    <code className="text-[11px]">{s}</code>
                  </li>
                ))}
              </ul>
              <p className="pt-1">
                Configúralos en Lovable → Settings → Edge Function Secrets antes de activar este
                proveedor.
              </p>
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2 justify-end pt-1">
            {dirty && activeRow && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraftProvider(activeRow.provider)}
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

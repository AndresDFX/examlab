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
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
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
  const { user, profile, roles } = useAuth();
  const activeRole = useActiveRole();
  // Scope: SuperAdmin cross-tenant edita la fila PLATFORM-DEFAULT
  // (tenant_id IS NULL, mig 20260719000000). Cualquier otro caller
  // (Admin común o SuperAdmin con "Ver como") edita la fila de su
  // tenant. Cada Admin puede no configurar nada y caer al platform
  // default que el SuperAdmin haya dejado — incluyendo su Gemini /
  // OpenAI key, así no todos los tenants tienen que pegar la suya.
  const isGlobalScope =
    roles.includes("SuperAdmin") && activeRole === "SuperAdmin" && readTenantOverride() === null;
  const scopeTenantId: string | null = isGlobalScope ? null : (profile?.tenant_id ?? null);
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
    // En scope global, la fila activa es la única con tenant_id IS NULL
    // (mig 20260719000000). En tenant scope, la fila del tenant del
    // caller. Filtramos explícitamente para no confundir filas — RLS
    // post-mig SELECT también deja al SuperAdmin ver TODAS las filas,
    // así que sin el filtro `.eq`/`.is` el `.maybeSingle()` se rompería
    // con multiple rows.
    let q = db
      .from("ai_model_settings")
      .select("id, provider, model, is_active, lovable_api_key, openai_api_key, gemini_api_key")
      .eq("is_active", true);
    if (isGlobalScope) {
      q = q.is("tenant_id", null);
    } else if (scopeTenantId) {
      q = q.eq("tenant_id", scopeTenantId);
    }
    const { data, error } = await q.maybeSingle();
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
    } else {
      // Sin fila para este scope — limpiar el activeRow para que el
      // formulario muestre los defaults y la siguiente save haga INSERT
      // sin pre-asumir keys del scope anterior.
      setActiveRow(null);
      setDraftLovableKey("__keep");
      setDraftOpenaiKey("__keep");
      setDraftGeminiKey("__keep");
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // Reload cuando cambia el scope (alternar activeRole o tenant override).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce, isGlobalScope, scopeTenantId]);

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
        draftLovableKey === "__keep"
          ? (activeRow?.lovable_api_key ?? null)
          : draftLovableKey || null;
      const nextOpenaiKey =
        draftOpenaiKey === "__keep" ? (activeRow?.openai_api_key ?? null) : draftOpenaiKey || null;
      const nextGeminiKey =
        draftGeminiKey === "__keep" ? (activeRow?.gemini_api_key ?? null) : draftGeminiKey || null;

      // Desactivamos la fila activa del MISMO scope antes de insertar la
      // nueva (mantenemos un singleton "active" por scope via los unique
      // partial idx). Sin el filtro de tenant_id, un SuperAdmin
      // accidentalmente desactivaría TODAS las filas activas
      // cross-tenant (RLS lo deja escribir cualquier fila).
      let deactQ = db
        .from("ai_model_settings")
        .update({ is_active: false, updated_by: user.id })
        .eq("is_active", true);
      if (isGlobalScope) {
        deactQ = deactQ.is("tenant_id", null);
      } else if (scopeTenantId) {
        deactQ = deactQ.eq("tenant_id", scopeTenantId);
      }
      const { error: deactErr } = await deactQ;
      if (deactErr) {
        toast.error(friendlyError(deactErr));
        return;
      }
      // Insert: SuperAdmin (global scope) envía tenant_id: null explícito;
      // el trigger respeta. Admin no envía tenant_id → trigger lo auto-
      // setea con current_tenant_id().
      const insertPayload: Record<string, unknown> = {
        provider: draftProvider,
        model: draftModel.trim(),
        is_active: true,
        updated_by: user.id,
        lovable_api_key: nextLovableKey,
        openai_api_key: nextOpenaiKey,
        gemini_api_key: nextGeminiKey,
      };
      if (isGlobalScope) insertPayload.tenant_id = null;
      const { error: insErr } = await db.from("ai_model_settings").insert(insertPayload);
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
          Define qué modelo usa el edge function de calificación con IA.
        </p>
        {/* Banner de scope: el SuperAdmin (cross-tenant) edita el
            "platform default" que TODOS los tenants heredan cuando no
            tienen su propia fila. El Admin común edita el override de
            su institución. Si el Admin no configura nada, la calificación
            cae al platform default del SuperAdmin (incluyendo la
            Gemini/OpenAI key si la dejó configurada acá). */}
        <div
          className={`mt-2 rounded-md border px-3 py-2 text-xs ${
            isGlobalScope
              ? "border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300"
              : "border-indigo-500/30 bg-indigo-500/5 text-indigo-700 dark:text-indigo-300"
          }`}
        >
          {isGlobalScope ? (
            <>
              <strong>Default global de la plataforma.</strong> Lo que guardes acá es el modelo +
              keys que reciben TODAS las instituciones que no configuraron el suyo. Cada Admin puede
              sobrescribirlo desde su propio panel.
            </>
          ) : (
            <>
              <strong>Configuración de tu institución.</strong> Si no configuras nada, la
              calificación usará el default global de la plataforma. Las keys que pongas acá tienen
              prioridad sobre la del SuperAdmin.
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>
            Proveedor{" "}
            <HelpHint>
              <div className="space-y-1.5">
                <p>
                  <strong>Lovable AI Gateway:</strong> usa los créditos de IA prepagados de Lovable.
                  Sin necesidad de tener tarjeta propia con OpenAI/Google. Modelos Gemini enrutados
                  por el gateway.
                </p>
                <p>
                  <strong>OpenAI:</strong> conecta directo con tu cuenta de platform.openai.com.
                  Acceso a modelos gpt-4o / gpt-4.1 / etc. Cobra a tu billing de OpenAI.
                </p>
                <p>
                  <strong>Google Gemini (directo):</strong> tu propio proyecto en Google AI Studio /
                  Vertex. Cobra a tu cuenta GCP. Más control sobre cuotas y residencia de datos.
                </p>
              </div>
            </HelpHint>
          </Label>
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
              <div className="space-y-1.5">
                <p>
                  Identificador exacto del modelo, tal como lo acepta la API del provider — un typo
                  y la calificación falla en runtime.
                </p>
                <p>
                  <strong>Ejemplos por provider:</strong>
                </p>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>
                    <strong>Lovable / Gemini:</strong> <code>google/gemini-2.5-flash</code> (rápido,
                    barato), <code>google/gemini-2.5-pro</code> (mejor razonamiento).
                  </li>
                  <li>
                    <strong>OpenAI:</strong> <code>gpt-4o-mini</code> (default barato),{" "}
                    <code>gpt-4o</code>, <code>gpt-4.1</code>.
                  </li>
                  <li>
                    <strong>Gemini directo:</strong> <code>gemini-2.5-flash</code>,{" "}
                    <code>gemini-2.5-pro</code>.
                  </li>
                </ul>
                <p>
                  El menú desplegable muestra las recomendaciones; el input acepta cualquier modelo
                  nuevo que tu provider soporte.
                </p>
              </div>
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

        {/* API key del provider ACTIVO solamente. Mostrar las 3 era
            ruido — el admin solo usa uno. Si cambia el provider arriba,
            el input correspondiente aparece debajo.
            UX: sentinel "__keep" = no tocar el valor previo (placeholder
            "••••XXXX"); "" = borrar y caer al env legacy; cualquier otro
            string = reemplazar. */}
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-xs">
            Cada institución usa su propia API key del provider activo (cobra a su cuenta). Si la
            dejás vacía, la calificación cae al secret <code>{SECRET_NAME[draftProvider]}</code>{" "}
            configurado por el SuperAdmin como fallback. La key se guarda cifrada en la DB y nunca
            se muestra completa (solo los últimos 4 caracteres).
          </AlertDescription>
        </Alert>

        {draftProvider === "lovable" && (
          <ApiKeyInput
            label="API key — Lovable AI Gateway"
            stored={activeRow?.lovable_api_key ?? null}
            value={draftLovableKey}
            onChange={setDraftLovableKey}
            maskFn={maskKey}
            helpHint={
              <div className="space-y-1">
                <p>
                  Variable <code>LOVABLE_API_KEY</code>. Se obtiene desde el dashboard de Lovable,
                  sección AI Credits.
                </p>
                <p>Los costos los administra Lovable según tus créditos contratados.</p>
              </div>
            }
            help="Empieza con un prefijo de Lovable. Pegalo completo; lo enmascaramos al guardar."
          />
        )}
        {draftProvider === "openai" && (
          <ApiKeyInput
            label="API key — OpenAI"
            stored={activeRow?.openai_api_key ?? null}
            value={draftOpenaiKey}
            onChange={setDraftOpenaiKey}
            maskFn={maskKey}
            helpHint={
              <div className="space-y-1">
                <p>
                  Generala en{" "}
                  <a
                    href="https://platform.openai.com/api-keys"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    platform.openai.com/api-keys
                  </a>
                  .
                </p>
                <p>
                  Cobra a tu cuenta OpenAI. Restringí permisos del key a chat/completions y ponele
                  un cap de uso mensual desde tu panel de OpenAI para no llevarte sorpresas.
                </p>
              </div>
            }
            help="Empieza con sk-… Pegala completa; la enmascaramos en pantalla y se guarda cifrada."
          />
        )}
        {draftProvider === "gemini" && (
          <ApiKeyInput
            label="API key — Google Gemini (directo)"
            stored={activeRow?.gemini_api_key ?? null}
            value={draftGeminiKey}
            onChange={setDraftGeminiKey}
            maskFn={maskKey}
            helpHint={
              <div className="space-y-1">
                <p>
                  Generala en{" "}
                  <a
                    href="https://aistudio.google.com/apikey"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                  >
                    aistudio.google.com/apikey
                  </a>
                  .
                </p>
                <p>
                  Cobra a tu proyecto GCP (o queda en el tier gratuito si tu uso entra). Asociala a
                  un proyecto con cuotas configuradas para controlar costos.
                </p>
              </div>
            }
            help="Empieza con AIza… Pegala completa; la enmascaramos en pantalla y se guarda cifrada."
          />
        )}

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
  helpHint,
}: {
  label: string;
  stored: string | null;
  value: string;
  onChange: (v: string) => void;
  maskFn: (k: string | null) => string;
  /** Línea corta debajo del input — guidance tip o formato esperado. */
  help?: string;
  /** Contenido del HelpHint (?) al lado del label — explicación más
   *  detallada con links/listas. Acepta ReactNode para markup rico. */
  helpHint?: React.ReactNode;
}) {
  const isKeep = value === "__keep";
  const masked = maskFn(stored);
  return (
    <div>
      <Label>
        {label}
        {helpHint && <HelpHint>{helpHint}</HelpHint>}
      </Label>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            title="Borrar y usar env legacy"
          >
            Borrar
          </Button>
        )}
      </div>
      {help && <p className="text-[11px] text-muted-foreground mt-1">{help}</p>}
    </div>
  );
}

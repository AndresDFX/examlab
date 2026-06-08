/**
 * Panel de configuración del modelo de IA activo (Admin).
 *
 * Una fila activa por tenant. El SuperAdmin cross-tenant edita la fila
 * platform-default (tenant_id IS NULL) que se usa SOLO para jobs internos
 * de la plataforma — los tenants ya NO heredan de ahí.
 *
 * Providers soportados: OpenAI o Google Gemini directo. Cada tenant DEBE
 * configurar su propia API key — sin key, los edges de IA fallan con un
 * mensaje accionable. Esto evita que un tenant consuma silenciosamente la
 * cuota del SuperAdmin.
 */
import { useEffect, useState } from "react";
import { useTranslation, Trans } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride } from "@/modules/tenants/use-tenant";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
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
import { Save, Info, Cpu, AlertTriangle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type Provider = "openai" | "gemini";

type ModelRow = {
  id: string;
  provider: Provider;
  model: string;
  is_active: boolean;
  openai_api_key: string | null;
  gemini_api_key: string | null;
};

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  gemini: "Google Gemini (directo)",
};

const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo", "gpt-4.1", "gpt-4.1-mini"],
  gemini: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
};

const SECRET_NAME: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
};

export function AdminModelPanel() {
  const { t } = useTranslation();
  const { user, profile, roles } = useAuth();
  const activeRole = useActiveRole();
  // Scope: SuperAdmin cross-tenant edita la fila PLATFORM-DEFAULT
  // (tenant_id IS NULL). Cualquier otro caller (Admin común o SuperAdmin
  // con "Ver como") edita la fila de su tenant. CAMBIO: los tenants ya
  // NO heredan de la fila platform-default; cada Admin debe configurar
  // su propia API key.
  const isGlobalScope =
    roles.includes("SuperAdmin") && activeRole === "SuperAdmin" && readTenantOverride() === null;
  const scopeTenantId: string | null = isGlobalScope ? null : (profile?.tenant_id ?? null);
  const [activeRow, setActiveRow] = useState<ModelRow | null>(null);
  const [draftProvider, setDraftProvider] = useState<Provider>("gemini");
  const [draftModel, setDraftModel] = useState<string>("gemini-2.5-flash");
  // API keys per-tenant. Sentinel `"__keep"` indica "no cambiar la existente"
  // (cuando el admin abre el panel sin tocar el campo, no la sobrescribimos).
  // Cualquier otro string la reemplaza; "" la borra.
  const [draftOpenaiKey, setDraftOpenaiKey] = useState<string>("__keep");
  const [draftGeminiKey, setDraftGeminiKey] = useState<string>("__keep");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    // En scope global, la fila activa es la única con tenant_id IS NULL.
    // En tenant scope, la fila del tenant del caller. Filtramos
    // explícitamente para no confundir filas — RLS deja al SuperAdmin
    // ver TODAS las filas, así que sin el filtro `.eq`/`.is` el
    // `.maybeSingle()` se rompería con multiple rows.
    let q = db
      .from("ai_model_settings")
      .select("id, provider, model, is_active, openai_api_key, gemini_api_key")
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
      // Normaliza provider legacy 'lovable' a 'gemini' para que el form
      // arranque consistente (la migración 20260824000000 ya hizo el
      // backfill server-side, pero si quedó algo viejo, lo manejamos).
      const normalized: Provider =
        row.provider === "openai" ? "openai" : "gemini";
      const normalizedModel =
        normalized === "gemini" && row.model.startsWith("google/")
          ? row.model.slice("google/".length)
          : row.model;
      setActiveRow({ ...row, provider: normalized, model: normalizedModel });
      setDraftProvider(normalized);
      setDraftModel(normalizedModel);
      setDraftOpenaiKey("__keep");
      setDraftGeminiKey("__keep");
    } else {
      // Sin fila para este scope — limpiar el activeRow para que el
      // formulario muestre los defaults y la siguiente save haga INSERT
      // sin pre-asumir keys del scope anterior.
      setActiveRow(null);
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
    draftOpenaiKey !== "__keep" ||
    draftGeminiKey !== "__keep";

  // Helper para mostrar "••••XXXX" cuando hay una key guardada pero el
  // admin no la está editando. Si la key no existe, muestra placeholder.
  const maskKey = (k: string | null | undefined): string =>
    k && k.length > 4 ? `••••${k.slice(-4)}` : "";

  // Para el scope tenant: ¿esta save dejaría al tenant SIN key del provider
  // activo? Si sí, bloqueamos guardado y mostramos error claro. El scope
  // global (SuperAdmin) sigue permitiendo key NULL — su row es solo para
  // jobs internos de la plataforma; los tenants ya no heredan.
  const activeProviderKeyDraft =
    draftProvider === "openai" ? draftOpenaiKey : draftGeminiKey;
  const activeProviderKeyStored =
    draftProvider === "openai" ? activeRow?.openai_api_key : activeRow?.gemini_api_key;
  const resolvedKeyAfterSave =
    activeProviderKeyDraft === "__keep" ? activeProviderKeyStored : activeProviderKeyDraft || null;
  const tenantNeedsKey = !isGlobalScope && !resolvedKeyAfterSave;

  const handleProviderChange = (p: Provider) => {
    setDraftProvider(p);
    if (!MODEL_SUGGESTIONS[p].includes(draftModel)) {
      setDraftModel(MODEL_SUGGESTIONS[p][0]);
    }
  };

  const handleSave = async () => {
    if (!user) return;
    if (!draftModel.trim()) {
      toast.error(
        i18n.t("toast.modules_admin_AdminModelPanel.specifyModel", {
          defaultValue: "Especifica un modelo",
        }),
      );
      return;
    }
    // Bloqueo: tenant sin key del provider activo. SuperAdmin no entra
    // acá (isGlobalScope=true).
    if (tenantNeedsKey) {
      toast.error(
        t("aiModel.apiKeyRequiredToast", {
          provider: PROVIDER_LABELS[draftProvider],
          defaultValue:
            `Configura la API key de ${PROVIDER_LABELS[draftProvider]} antes de guardar. ` +
            `Tu institución debe usar su propia key (la del SuperAdmin no se hereda).`,
        }),
      );
      return;
    }
    setSaving(true);
    try {
      // Resolución de keys: si el admin no las tocó ("__keep"), heredan
      // las del activeRow. Si las cambió, usa el nuevo valor (incluido "" = borrar).
      const nextOpenaiKey =
        draftOpenaiKey === "__keep" ? (activeRow?.openai_api_key ?? null) : draftOpenaiKey || null;
      const nextGeminiKey =
        draftGeminiKey === "__keep" ? (activeRow?.gemini_api_key ?? null) : draftGeminiKey || null;

      // UPSERT correcto: si la fila del scope ya existe, hacemos UPDATE.
      // Si no, INSERT. Antes hacíamos UPDATE-to-false + INSERT, que con
      // tenants existentes que tenían is_active=true rompía contra el
      // unique partial index (síntoma: "Ya existe un registro con esos
      // datos"). Ahora tocamos la fila existente in-place.
      if (activeRow?.id) {
        const { error: updErr } = await db
          .from("ai_model_settings")
          .update({
            provider: draftProvider,
            model: draftModel.trim(),
            is_active: true,
            updated_by: user.id,
            openai_api_key: nextOpenaiKey,
            gemini_api_key: nextGeminiKey,
          })
          .eq("id", activeRow.id);
        if (updErr) {
          toast.error(friendlyError(updErr));
          return;
        }
      } else {
        const insertPayload: Record<string, unknown> = {
          provider: draftProvider,
          model: draftModel.trim(),
          is_active: true,
          updated_by: user.id,
          openai_api_key: nextOpenaiKey,
          gemini_api_key: nextGeminiKey,
        };
        if (isGlobalScope) insertPayload.tenant_id = null;
        const { error: insErr } = await db.from("ai_model_settings").insert(insertPayload);
        if (insErr) {
          toast.error(friendlyError(insErr));
          return;
        }
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
      toast.success(
        i18n.t("toast.modules_admin_AdminModelPanel.modelConfigUpdated", {
          defaultValue: "Configuración del modelo actualizada",
        }),
      );
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
          {t("aiModel.activeTitle", { defaultValue: "Modelo activo" })}
          {activeRow && (
            <Badge variant="secondary" className="text-[10px]">
              {PROVIDER_LABELS[activeRow.provider]} · {activeRow.model}
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground mt-1">
          {t("aiModel.subtitle", {
            defaultValue: "Define qué modelo usa el edge function de calificación con IA.",
          })}
        </p>
        {/* Banner de scope: el SuperAdmin (cross-tenant) edita el platform
            default usado por jobs internos. El Admin común edita la
            configuración de su institución — que es OBLIGATORIA: sin
            key, la IA no funciona en su tenant. */}
        <div
          className={`mt-2 rounded-md border px-3 py-2 text-xs ${
            isGlobalScope
              ? "border-violet-500/30 bg-violet-500/5 text-violet-700 dark:text-violet-300"
              : "border-indigo-500/30 bg-indigo-500/5 text-indigo-700 dark:text-indigo-300"
          }`}
        >
          {isGlobalScope ? (
            <>
              <strong>
                {t("aiModel.scopeGlobal", { defaultValue: "Default global de la plataforma." })}
              </strong>{" "}
              {t("aiModel.scopeGlobalBody", {
                defaultValue:
                  "Lo que guardes acá lo usan jobs internos de la plataforma. Las instituciones NO heredan de esta configuración: cada Admin debe pegar su propia API key en su panel.",
              })}
            </>
          ) : (
            <>
              <strong>
                {t("aiModel.scopeTenant", {
                  defaultValue: "Configuración obligatoria de tu institución.",
                })}
              </strong>{" "}
              {t("aiModel.scopeTenantBody", {
                defaultValue:
                  "Pegá la API key del provider que vas a usar — cobra a tu cuenta. La calificación con IA no funciona hasta que esté configurada.",
              })}
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label>
            Proveedor{" "}
            <HelpHint><span dangerouslySetInnerHTML={{ __html: t("help.providerComparison") }} /></HelpHint>
          </Label>
          <Select value={draftProvider} onValueChange={(v) => handleProviderChange(v as Provider)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gemini">{PROVIDER_LABELS.gemini}</SelectItem>
              <SelectItem value="openai">{PROVIDER_LABELS.openai}</SelectItem>
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

        {/* API key del provider ACTIVO solamente. Mostrar las 2 era ruido —
            el admin solo usa uno. Si cambia el provider arriba, el input
            correspondiente aparece debajo.
            UX: sentinel "__keep" = no tocar el valor previo (placeholder
            "••••XXXX"); "" = borrar (solo permitido en scope global);
            cualquier otro string = reemplazar. */}
        <Alert>
          <Info className="h-4 w-4" />
          <AlertDescription className="text-xs">
            {isGlobalScope ? (
              <>
                Esta key se usa para jobs internos de la plataforma. Si la dejás vacía, los jobs
                caen al secret <code>{SECRET_NAME[draftProvider]}</code> en Supabase → Edge
                Function Secrets como último fallback.
              </>
            ) : (
              <>
                Cada institución usa su propia API key del provider activo (cobra a su cuenta).
                <strong> La key es obligatoria</strong> — sin ella la IA no funciona en tu tenant.
                La key se guarda cifrada en la DB y nunca se muestra completa (solo los últimos 4
                caracteres).
              </>
            )}
          </AlertDescription>
        </Alert>

        {draftProvider === "openai" && (
          <ApiKeyInput
            label="API key — OpenAI"
            stored={activeRow?.openai_api_key ?? null}
            value={draftOpenaiKey}
            onChange={setDraftOpenaiKey}
            maskFn={maskKey}
            isGlobalScope={isGlobalScope}
            placeholderEmptyGlobal={t("aiModel.apiKeyEmptyGlobal", {
              defaultValue: "Sin configurar — los jobs internos caen al env secret",
            })}
            placeholderEmptyTenant={t("aiModel.apiKeyEmptyTenant", {
              defaultValue: "Pegá tu API key (obligatorio)",
            })}
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
            isGlobalScope={isGlobalScope}
            placeholderEmptyGlobal={t("aiModel.apiKeyEmptyGlobal", {
              defaultValue: "Sin configurar — los jobs internos caen al env secret",
            })}
            placeholderEmptyTenant={t("aiModel.apiKeyEmptyTenant", {
              defaultValue: "Pegá tu API key (obligatorio)",
            })}
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

        {tenantNeedsKey && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="text-xs">
              <Trans
                i18nKey="aiModel.apiKeyMissingAlert"
                values={{ provider: PROVIDER_LABELS[draftProvider] }}
                defaults="Falta la API key de <strong>{{provider}}</strong>. Sin la key, la calificación con IA no funciona en tu institución. Pegala arriba antes de guardar."
                components={{ strong: <strong /> }}
              />
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2 justify-end pt-1">
          {dirty && activeRow && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDraftProvider(activeRow.provider);
                setDraftModel(activeRow.model);
                setDraftOpenaiKey("__keep");
                setDraftGeminiKey("__keep");
              }}
              disabled={saving}
            >
              Cancelar
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty || tenantNeedsKey}>
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
 *   - Click "Borrar" → setea "" (vacío). Solo visible en scope global —
 *     en scope tenant la key es obligatoria.
 */
function ApiKeyInput({
  label,
  stored,
  value,
  onChange,
  maskFn,
  help,
  helpHint,
  isGlobalScope,
  placeholderEmptyGlobal,
  placeholderEmptyTenant,
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
  /** Si es scope global (SuperAdmin), la key puede quedar vacía. En
   *  tenant scope, es obligatoria y no mostramos el botón "Borrar". */
  isGlobalScope: boolean;
  /** Placeholder traducido para scope global cuando no hay key guardada. */
  placeholderEmptyGlobal: string;
  /** Placeholder traducido para scope tenant cuando no hay key guardada. */
  placeholderEmptyTenant: string;
}) {
  const isKeep = value === "__keep";
  const masked = maskFn(stored);
  // Placeholder distinto según scope: en tenant scope, la key es
  // obligatoria, así que el placeholder lo refleja.
  const placeholder =
    isKeep && masked ? masked : isGlobalScope ? placeholderEmptyGlobal : placeholderEmptyTenant;
  return (
    <div>
      <Label required={!isGlobalScope && !stored}>
        {label}
        {helpHint && <HelpHint>{helpHint}</HelpHint>}
      </Label>
      <div className="flex gap-2">
        <PasswordInput
          value={isKeep ? "" : value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          wrapperClassName="flex-1"
          className="font-mono text-xs"
        />
        {!isKeep && (
          <Button variant="ghost" size="sm" onClick={() => onChange("__keep")}>
            Cancelar
          </Button>
        )}
        {/* Borrar key: solo en scope global. En scope tenant la key es
            obligatoria, así que no exponemos la acción de eliminarla. */}
        {isKeep && stored && isGlobalScope && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            title="Borrar y caer al env secret"
          >
            Borrar
          </Button>
        )}
      </div>
      {help && <p className="text-[11px] text-muted-foreground mt-1">{help}</p>}
    </div>
  );
}

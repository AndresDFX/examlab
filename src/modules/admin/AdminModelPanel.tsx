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
import { Save, Info, Cpu, AlertTriangle, Plus, Trash2 } from "lucide-react";
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
  // Listas de keys de respaldo (failover). El edge intenta la principal y, si
  // falla (429/401/402/403/5xx), rota a estas en orden.
  gemini_fallback_keys: string[] | null;
  openai_fallback_keys: string[] | null;
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
  // Listas de keys de respaldo (failover) por provider. Se cargan con los
  // valores reales (el Admin tiene RLS de lectura sobre su fila); el
  // PasswordInput las oculta por defecto. Al guardar se escriben completas.
  const [draftGeminiFallback, setDraftGeminiFallback] = useState<string[]>([]);
  const [draftOpenaiFallback, setDraftOpenaiFallback] = useState<string[]>([]);
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
      .select(
        "id, provider, model, is_active, openai_api_key, gemini_api_key, gemini_fallback_keys, openai_fallback_keys",
      )
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
      setDraftGeminiFallback(row.gemini_fallback_keys ?? []);
      setDraftOpenaiFallback(row.openai_fallback_keys ?? []);
    } else {
      // Sin fila para este scope — limpiar el activeRow para que el
      // formulario muestre los defaults y la siguiente save haga INSERT
      // sin pre-asumir keys del scope anterior.
      setActiveRow(null);
      setDraftOpenaiKey("__keep");
      setDraftGeminiKey("__keep");
      setDraftGeminiFallback([]);
      setDraftOpenaiFallback([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // Reload cuando cambia el scope (alternar activeRole o tenant override).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce, isGlobalScope, scopeTenantId]);

  // Limpia una lista de keys: trim + descarta vacíos + dedup, preservando orden.
  const cleanKeyList = (xs: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const x of xs) {
      const v = x.trim();
      if (v && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
    return out;
  };
  const listsEqual = (a: string[], b: string[]): boolean => {
    const ca = cleanKeyList(a);
    const cb = cleanKeyList(b);
    return ca.length === cb.length && ca.every((v, i) => v === cb[i]);
  };

  const dirty =
    !activeRow ||
    draftProvider !== activeRow.provider ||
    draftModel !== activeRow.model ||
    draftOpenaiKey !== "__keep" ||
    draftGeminiKey !== "__keep" ||
    !listsEqual(draftGeminiFallback, activeRow.gemini_fallback_keys ?? []) ||
    !listsEqual(draftOpenaiFallback, activeRow.openai_fallback_keys ?? []);

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
      // Listas de respaldo: limpiadas (sin vacíos/duplicados). Array vacío → null
      // para no guardar `{}` en la columna text[].
      const cleanedGeminiFallback = cleanKeyList(draftGeminiFallback);
      const cleanedOpenaiFallback = cleanKeyList(draftOpenaiFallback);
      const nextGeminiFallback = cleanedGeminiFallback.length ? cleanedGeminiFallback : null;
      const nextOpenaiFallback = cleanedOpenaiFallback.length ? cleanedOpenaiFallback : null;

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
            gemini_fallback_keys: nextGeminiFallback,
            openai_fallback_keys: nextOpenaiFallback,
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
          gemini_fallback_keys: nextGeminiFallback,
          openai_fallback_keys: nextOpenaiFallback,
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
          <Spinner size="md" /> {t("hc_modulesAdminAdminModelPanel.loadingConfig")}
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        message={t("hc_modulesAdminAdminModelPanel.loadErrorMessage")}
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
            {t("hc_modulesAdminAdminModelPanel.providerLabel")}{" "}
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
            {t("hc_modulesAdminAdminModelPanel.modelLabel")}{" "}
            <HelpHint>
              <div className="space-y-1.5">
                <p>{t("hc_modulesAdminAdminModelPanel.modelHelpIntro")}</p>
                <p>
                  <strong>{t("hc_modulesAdminAdminModelPanel.modelHelpExamplesTitle")}</strong>
                </p>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>
                    <strong>{t("hc_modulesAdminAdminModelPanel.modelHelpOpenaiLabel")}</strong>{" "}
                    <code>gpt-4o-mini</code> {t("hc_modulesAdminAdminModelPanel.modelHelpOpenaiCheap")},{" "}
                    <code>gpt-4o</code>, <code>gpt-4.1</code>.
                  </li>
                  <li>
                    <strong>{t("hc_modulesAdminAdminModelPanel.modelHelpGeminiLabel")}</strong>{" "}
                    <code>gemini-2.5-flash</code>,{" "}
                    <code>gemini-2.5-pro</code>.
                  </li>
                </ul>
                <p>{t("hc_modulesAdminAdminModelPanel.modelHelpOutro")}</p>
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
              <Trans
                i18nKey="hc_modulesAdminAdminModelPanel.apiKeyAlertGlobal"
                values={{ secret: SECRET_NAME[draftProvider] }}
                defaults="Esta key se usa para jobs internos de la plataforma. Si la dejás vacía, los jobs caen al secret <code>{{secret}}</code> en Supabase → Edge Function Secrets como último fallback."
                components={{ code: <code /> }}
              />
            ) : (
              <Trans
                i18nKey="hc_modulesAdminAdminModelPanel.apiKeyAlertTenant"
                defaults="Cada institución usa su propia API key del provider activo (cobra a su cuenta).<strong> La key es obligatoria</strong> — sin ella la IA no funciona en tu tenant. La key se guarda cifrada en la DB y nunca se muestra completa (solo los últimos 4 caracteres)."
                components={{ strong: <strong /> }}
              />
            )}
          </AlertDescription>
        </Alert>

        {draftProvider === "openai" && (
          <ApiKeyInput
            label={t("hc_modulesAdminAdminModelPanel.apiKeyLabelOpenai")}
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
                  <Trans
                    i18nKey="hc_modulesAdminAdminModelPanel.apiKeyHelpHintOpenaiGenerate"
                    defaults="Generala en <link>platform.openai.com/api-keys</link>."
                    components={{
                      link: (
                        <a
                          href="https://platform.openai.com/api-keys"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        />
                      ),
                    }}
                  />
                </p>
                <p>{t("hc_modulesAdminAdminModelPanel.apiKeyHelpHintOpenaiBilling")}</p>
              </div>
            }
            help={t("hc_modulesAdminAdminModelPanel.apiKeyHelpOpenai")}
          />
        )}
        {draftProvider === "openai" && (
          <FallbackKeysEditor
            providerLabel={PROVIDER_LABELS.openai}
            keys={draftOpenaiFallback}
            onChange={setDraftOpenaiFallback}
          />
        )}
        {draftProvider === "gemini" && (
          <ApiKeyInput
            label={t("hc_modulesAdminAdminModelPanel.apiKeyLabelGemini")}
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
                  <Trans
                    i18nKey="hc_modulesAdminAdminModelPanel.apiKeyHelpHintGeminiGenerate"
                    defaults="Generala en <link>aistudio.google.com/apikey</link>."
                    components={{
                      link: (
                        <a
                          href="https://aistudio.google.com/apikey"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        />
                      ),
                    }}
                  />
                </p>
                <p>{t("hc_modulesAdminAdminModelPanel.apiKeyHelpHintGeminiBilling")}</p>
              </div>
            }
            help={t("hc_modulesAdminAdminModelPanel.apiKeyHelpGemini")}
          />
        )}
        {draftProvider === "gemini" && (
          <FallbackKeysEditor
            providerLabel={PROVIDER_LABELS.gemini}
            keys={draftGeminiFallback}
            onChange={setDraftGeminiFallback}
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
                setDraftGeminiFallback(activeRow.gemini_fallback_keys ?? []);
                setDraftOpenaiFallback(activeRow.openai_fallback_keys ?? []);
              }}
              disabled={saving}
            >
              {t("hc_modulesAdminAdminModelPanel.cancel")}
            </Button>
          )}
          <Button size="sm" onClick={handleSave} disabled={saving || !dirty || tenantNeedsKey}>
            {saving ? <Spinner size="md" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
            {t("hc_modulesAdminAdminModelPanel.saveConfig")}
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
  const { t } = useTranslation();
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
            {t("hc_modulesAdminAdminModelPanel.cancel")}
          </Button>
        )}
        {/* Borrar key: solo en scope global. En scope tenant la key es
            obligatoria, así que no exponemos la acción de eliminarla. */}
        {isKeep && stored && isGlobalScope && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange("")}
            title={t("hc_modulesAdminAdminModelPanel.deleteKeyTitle")}
          >
            {t("hc_modulesAdminAdminModelPanel.delete")}
          </Button>
        )}
      </div>
      {help && <p className="text-[11px] text-muted-foreground mt-1">{help}</p>}
    </div>
  );
}

/**
 * FallbackKeysEditor — lista editable de keys de RESPALDO (failover) del
 * provider activo. El edge intenta la clave principal y, si falla
 * (límite de uso 429, inválida 401/403, sin créditos 402, o caída 5xx),
 * rota a estas EN ORDEN. Así un docente no se queda sin IA cuando una clave
 * agota su cuota del momento.
 *
 * Cada fila es un PasswordInput (oculto por defecto) + botón eliminar.
 * "Agregar clave" añade una fila vacía. El parent limpia/dedup al guardar.
 */
function FallbackKeysEditor({
  providerLabel,
  keys,
  onChange,
}: {
  providerLabel: string;
  keys: string[];
  onChange: (next: string[]) => void;
}) {
  const { t } = useTranslation();
  const setAt = (i: number, v: string) => onChange(keys.map((k, idx) => (idx === i ? v : k)));
  const removeAt = (i: number) => onChange(keys.filter((_, idx) => idx !== i));
  const add = () => onChange([...keys, ""]);
  const count = keys.filter((k) => k.trim()).length;
  return (
    <div className="rounded-md border border-dashed border-muted-foreground/30 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs mb-0">
          {t("aiModel.fallbackKeysLabel", {
            provider: providerLabel,
            defaultValue: "Claves de respaldo de {{provider}}",
          })}{" "}
          <HelpHint>
            {t("aiModel.fallbackKeysHelp", {
              defaultValue:
                "Si la clave principal falla (límite de uso, inválida, sin créditos o caída del proveedor), la IA reintenta automáticamente con estas claves, en orden. Útil para no quedarte sin IA cuando una clave agota su cuota del momento.",
            })}
          </HelpHint>
        </Label>
        <Badge variant="secondary" className="text-[10px]">
          {t("aiModel.fallbackKeysCount", {
            count,
            defaultValue: "{{count}} configurada(s)",
          })}
        </Badge>
      </div>
      {keys.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          {t("aiModel.fallbackKeysEmpty", {
            defaultValue: "Sin claves de respaldo. Solo se usa la principal.",
          })}
        </p>
      )}
      {keys.map((k, i) => (
        // eslint-disable-next-line react/no-array-index-key
        <div key={i} className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground w-5 shrink-0 text-right">
            {i + 1}.
          </span>
          <PasswordInput
            value={k}
            placeholder={t("aiModel.fallbackKeysPlaceholder", {
              defaultValue: "Pegá una clave de respaldo",
            })}
            onChange={(e) => setAt(i, e.target.value)}
            wrapperClassName="flex-1"
            className="font-mono text-xs"
          />
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-destructive shrink-0"
            onClick={() => removeAt(i)}
            title={t("aiModel.fallbackKeysRemove", { defaultValue: "Eliminar esta clave" })}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={add} className="w-full">
        <Plus className="h-4 w-4 mr-1" />
        {t("aiModel.fallbackKeysAdd", { defaultValue: "Agregar clave de respaldo" })}
      </Button>
    </div>
  );
}

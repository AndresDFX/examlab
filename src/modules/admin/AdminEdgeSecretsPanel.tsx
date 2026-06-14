/**
 * Panel de gestión de Edge Function Secrets (Admin).
 *
 * Lista los secrets actualmente configurados (con valor enmascarado a
 * los últimos 4 chars) y permite agregar/actualizar/borrar.
 *
 * Implementación: cliente llama al edge function `manage-edge-secrets`
 * que internamente usa el Supabase Management API. El cliente nunca
 * ve el Personal Access Token (PAT) — vive solo en el server.
 *
 * Secrets filtrados automáticamente (no aparecen ni se pueden setear):
 *   SUPABASE_URL, SUPABASE_*, RESERVED_*, etc.
 *   Los que el plano de Supabase autoinjecta y romper deja el proyecto
 *   inservible.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/shared/lib/edge-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { formatDate } from "@/shared/lib/format";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RowAction } from "@/components/ui/row-action";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { toast } from "sonner";
import {
  KeyRound,
  Plus,
  Eye,
  EyeOff,
  RefreshCcw,
  Save,
  Trash2,
  Info,
  AlertTriangle,
} from "lucide-react";

interface SecretRow {
  name: string;
  value_masked: string;
  length: number;
  updated_at: string | null;
}

export function AdminEdgeSecretsPanel() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);

  // Dialog state — crear/editar.
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorName, setEditorName] = useState("");
  const [editorValue, setEditorValue] = useState("");
  const [editorIsEdit, setEditorIsEdit] = useState(false);
  const [showValue, setShowValue] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    setConfigError(null);
    const { data, error } = await supabase.functions.invoke("manage-edge-secrets", {
      body: { action: "list" },
    });
    setLoading(false);
    if (error || data?.error) {
      const detail = await extractEdgeError(error, data);
      setConfigError(detail || t("hc_modulesAdminAdminEdgeSecretsPanel.unknownError"));
      return;
    }
    setSecrets((data?.secrets ?? []) as SecretRow[]);
  };

  useEffect(() => {
    void load();
  }, []);

  const openCreate = () => {
    setEditorName("");
    setEditorValue("");
    setEditorIsEdit(false);
    setShowValue(false);
    setEditorOpen(true);
  };

  const openEdit = (s: SecretRow) => {
    setEditorName(s.name);
    setEditorValue("");
    setEditorIsEdit(true);
    setShowValue(false);
    setEditorOpen(true);
  };

  const save = async () => {
    if (!editorName.trim() || !editorValue) {
      toast.error(
        i18n.t("toast.modules_admin_AdminEdgeSecretsPanel.nameAndValueRequired", {
          defaultValue: "Nombre y valor son obligatorios",
        }),
      );
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.functions.invoke("manage-edge-secrets", {
      body: { action: "set", name: editorName.trim(), value: editorValue },
    });
    setSaving(false);
    if (error || data?.error) {
      const detail = await extractEdgeError(error, data);
      toast.error(detail || t("hc_modulesAdminAdminEdgeSecretsPanel.saveError"));
      return;
    }
    toast.success(
      editorIsEdit
        ? t("hc_modulesAdminAdminEdgeSecretsPanel.secretUpdated")
        : t("hc_modulesAdminAdminEdgeSecretsPanel.secretCreated"),
      {
        description: t("hc_modulesAdminAdminEdgeSecretsPanel.secretSavedDescription"),
        duration: 8000,
      },
    );
    setEditorOpen(false);
    void load();
  };

  const remove = async (s: SecretRow) => {
    const ok = await confirm({
      title: t("hc_modulesAdminAdminEdgeSecretsPanel.deleteSecretTitle", { name: s.name }),
      description: t("hc_modulesAdminAdminEdgeSecretsPanel.deleteSecretDescription"),
      confirmLabel: t("hc_modulesAdminAdminEdgeSecretsPanel.deleteLabel"),
      tone: "destructive",
    });
    if (!ok) return;
    const { data, error } = await supabase.functions.invoke("manage-edge-secrets", {
      body: { action: "unset", name: s.name },
    });
    if (error || data?.error) {
      const detail = await extractEdgeError(error, data);
      toast.error(detail || t("hc_modulesAdminAdminEdgeSecretsPanel.deleteError"));
      return;
    }
    toast.success(
      i18n.t("toast.modules_admin_AdminEdgeSecretsPanel.secretDeleted", {
        defaultValue: 'Secret "{{name}}" borrada',
        name: s.name,
      }),
    );
    void load();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-amber-500" />
            Edge Function Secrets
            <HelpHint>{t("help.edgeFunctionSecretsDescription")}</HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {t("hc_modulesAdminAdminEdgeSecretsPanel.maskedValuesNote")}
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {configError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs space-y-2">
                <p>
                  <strong>{t("hc_modulesAdminAdminEdgeSecretsPanel.loadSecretsError")}</strong>{" "}
                  {configError}
                </p>
                {configError.includes("MANAGEMENT_PAT") && (
                  <div className="text-xs">
                    <p className="mt-1 font-medium">
                      {t("hc_modulesAdminAdminEdgeSecretsPanel.setupOnce")}
                    </p>
                    <ol className="list-decimal list-inside space-y-0.5 mt-1">
                      <li>
                        {t("hc_modulesAdminAdminEdgeSecretsPanel.setupGenerateToken")}{" "}
                        <a
                          href="https://supabase.com/dashboard/account/tokens"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          supabase.com/dashboard/account/tokens
                        </a>
                      </li>
                      <li>{t("hc_modulesAdminAdminEdgeSecretsPanel.setupGoToDashboard")}</li>
                      <li>
                        {t("hc_modulesAdminAdminEdgeSecretsPanel.setupAddSecret")}{" "}
                        <code className="text-[11px]">MANAGEMENT_PAT</code>{" "}
                        {t("hc_modulesAdminAdminEdgeSecretsPanel.setupAddSecretSuffix")}{" "}
                        <code>sbp_</code>)
                      </li>
                      <li>{t("hc_modulesAdminAdminEdgeSecretsPanel.setupReload")}</li>
                    </ol>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {loading
                    ? t("hc_modulesAdminAdminEdgeSecretsPanel.loading")
                    : t("hc_modulesAdminAdminEdgeSecretsPanel.secretsCount", {
                        count: secrets.length,
                      })}
                </p>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void load()}
                    disabled={loading}
                  >
                    <RefreshCcw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
                    {t("hc_modulesAdminAdminEdgeSecretsPanel.reload")}
                  </Button>
                  <Button size="sm" onClick={openCreate} disabled={loading}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    {t("hc_modulesAdminAdminEdgeSecretsPanel.new")}
                  </Button>
                </div>
              </div>

              {loading ? (
                <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
                  <Spinner size="sm" /> {t("hc_modulesAdminAdminEdgeSecretsPanel.loadingSecrets")}
                </div>
              ) : secrets.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground border rounded-md">
                  {t("hc_modulesAdminAdminEdgeSecretsPanel.noSecrets")}
                </div>
              ) : (
                <div className="border rounded-md divide-y">
                  {secrets.map((s) => (
                    <div
                      key={s.name}
                      className="flex items-center gap-3 px-3 py-2 hover:bg-muted/40 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs font-medium truncate">{s.name}</div>
                        <div className="text-[11px] text-muted-foreground flex items-center gap-2 mt-0.5">
                          <span className="font-mono">
                            {s.value_masked || t("hc_modulesAdminAdminEdgeSecretsPanel.empty")}
                          </span>
                          <span>·</span>
                          <span>
                            {t("hc_modulesAdminAdminEdgeSecretsPanel.chars", { count: s.length })}
                          </span>
                          {s.updated_at && (
                            <>
                              <span>·</span>
                              <span>
                                {t("hc_modulesAdminAdminEdgeSecretsPanel.modified", {
                                  date: formatDate(s.updated_at),
                                })}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <RowAction
                          icon={Save}
                          label={t("hc_modulesAdminAdminEdgeSecretsPanel.edit")}
                          onClick={() => openEdit(s)}
                        />
                        <RowAction
                          icon={Trash2}
                          label={t("hc_modulesAdminAdminEdgeSecretsPanel.delete")}
                          tone="destructive"
                          onClick={() => void remove(s)}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription className="text-xs">
                  {t("hc_modulesAdminAdminEdgeSecretsPanel.reservedPrefix")} (
                  <code>SUPABASE_URL</code>, <code>SUPABASE_SERVICE_ROLE_KEY</code>
                  {t("hc_modulesAdminAdminEdgeSecretsPanel.reservedSuffix")}
                </AlertDescription>
              </Alert>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editorIsEdit
                ? t("hc_modulesAdminAdminEdgeSecretsPanel.editTitle", { name: editorName })
                : t("hc_modulesAdminAdminEdgeSecretsPanel.newSecretTitle")}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {editorIsEdit
                ? t("hc_modulesAdminAdminEdgeSecretsPanel.editDescription")
                : t("hc_modulesAdminAdminEdgeSecretsPanel.createDescription")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t("hc_modulesAdminAdminEdgeSecretsPanel.nameLabel")}</Label>
              <Input
                value={editorName}
                onChange={(e) => setEditorName(e.target.value.toUpperCase())}
                placeholder="MY_API_KEY"
                className="font-mono text-sm"
                disabled={editorIsEdit}
              />
              {!editorIsEdit && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  {t("hc_modulesAdminAdminEdgeSecretsPanel.nameHint")} <code>SUPABASE_</code>.
                </p>
              )}
            </div>
            <div>
              <Label>{t("hc_modulesAdminAdminEdgeSecretsPanel.valueLabel")}</Label>
              {/* Toggle de visibilidad ABSOLUTO dentro del input (patrón
                  estándar de password fields). Antes era un Button al
                  lado en flex-row: con `max-w-md` el botón quedaba pegado
                  al input y el ojo se veía superpuesto al borde derecho.
                  Padding-right del input reserva el espacio del ícono. */}
              <div className="relative">
                <Input
                  type={showValue ? "text" : "password"}
                  value={editorValue}
                  onChange={(e) => setEditorValue(e.target.value)}
                  placeholder={
                    editorIsEdit
                      ? t("hc_modulesAdminAdminEdgeSecretsPanel.valuePlaceholderEdit")
                      : t("hc_modulesAdminAdminEdgeSecretsPanel.valuePlaceholderNew")
                  }
                  className="font-mono text-sm pr-10"
                  autoComplete="off"
                />
                <button
                  type="button"
                  aria-label={
                    showValue
                      ? t("hc_modulesAdminAdminEdgeSecretsPanel.hideValue")
                      : t("hc_modulesAdminAdminEdgeSecretsPanel.showValue")
                  }
                  onClick={() => setShowValue((v) => !v)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              {t("hc_modulesAdminAdminEdgeSecretsPanel.cancel")}
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              {t("hc_modulesAdminAdminEdgeSecretsPanel.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

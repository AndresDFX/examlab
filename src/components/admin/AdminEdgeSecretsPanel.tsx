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
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/lib/edge-error";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RowAction } from "@/components/ui/row-action";
import { useConfirm } from "@/components/ConfirmDialog";
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
      setConfigError(detail || "Error desconocido");
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
      toast.error("Nombre y valor son obligatorios");
      return;
    }
    setSaving(true);
    const { data, error } = await supabase.functions.invoke("manage-edge-secrets", {
      body: { action: "set", name: editorName.trim(), value: editorValue },
    });
    setSaving(false);
    if (error || data?.error) {
      const detail = await extractEdgeError(error, data);
      toast.error(detail || "Error al guardar");
      return;
    }
    toast.success(editorIsEdit ? "Secret actualizada" : "Secret creada");
    setEditorOpen(false);
    void load();
  };

  const remove = async (s: SecretRow) => {
    const ok = await confirm({
      title: `¿Borrar secret "${s.name}"?`,
      description:
        "Los edge functions que dependen de este secret dejarán de funcionar inmediatamente. Esta acción no se puede deshacer.",
      confirmLabel: "Borrar",
      tone: "destructive",
    });
    if (!ok) return;
    const { data, error } = await supabase.functions.invoke("manage-edge-secrets", {
      body: { action: "unset", name: s.name },
    });
    if (error || data?.error) {
      const detail = await extractEdgeError(error, data);
      toast.error(detail || "Error al borrar");
      return;
    }
    toast.success(`Secret "${s.name}" borrada`);
    void load();
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-amber-500" />
            Edge Function Secrets
            <HelpHint>
              Variables de entorno que ven las edge functions de Supabase. Aquí editas API keys
              (Gemini, OpenAI, OnlineCompiler, AWS Runner, etc.) sin tener que ir al dashboard de
              Supabase ni redeployar.
            </HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Los valores se muestran enmascarados (últimos 4 chars). Para ver el valor completo de un
            secret, recupéralo de la fuente original — Supabase nunca lo devuelve en claro después
            de creado.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {configError ? (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs space-y-2">
                <p>
                  <strong>No se pudo cargar secrets:</strong> {configError}
                </p>
                {configError.includes("MANAGEMENT_PAT") && (
                  <div className="text-xs">
                    <p className="mt-1 font-medium">Setup (una sola vez):</p>
                    <ol className="list-decimal list-inside space-y-0.5 mt-1">
                      <li>
                        Genera un Personal Access Token en{" "}
                        <a
                          href="https://supabase.com/dashboard/account/tokens"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline"
                        >
                          supabase.com/dashboard/account/tokens
                        </a>
                      </li>
                      <li>Ve a Supabase Dashboard → Project Settings → Edge Functions → Secrets</li>
                      <li>
                        Agrega <code className="text-[11px]">MANAGEMENT_PAT</code> con el
                        valor del token (empieza con <code>sbp_</code>)
                      </li>
                      <li>Recarga esta pantalla</li>
                    </ol>
                  </div>
                )}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-muted-foreground">
                  {loading ? "Cargando…" : `${secrets.length} secret(s) configurado(s).`}
                </p>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void load()}
                    disabled={loading}
                  >
                    <RefreshCcw className={`h-3.5 w-3.5 mr-1 ${loading ? "animate-spin" : ""}`} />
                    Recargar
                  </Button>
                  <Button size="sm" onClick={openCreate} disabled={loading}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Nueva
                  </Button>
                </div>
              </div>

              {loading ? (
                <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
                  <Spinner size="sm" /> Cargando secrets…
                </div>
              ) : secrets.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground border rounded-md">
                  No hay secrets configurados. Crea uno con el botón "Nueva".
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
                          <span className="font-mono">{s.value_masked || "(vacío)"}</span>
                          <span>·</span>
                          <span>{s.length} chars</span>
                          {s.updated_at && (
                            <>
                              <span>·</span>
                              <span>
                                Modificado {new Date(s.updated_at).toLocaleDateString("es-CO")}
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <RowAction icon={Save} label="Editar" onClick={() => openEdit(s)} />
                        <RowAction
                          icon={Trash2}
                          label="Borrar"
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
                  Secrets reservados (<code>SUPABASE_URL</code>,{" "}
                  <code>SUPABASE_SERVICE_ROLE_KEY</code>, etc.) se filtran automáticamente y no se
                  pueden modificar desde aquí — son inyectados por la plataforma.
                </AlertDescription>
              </Alert>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editorIsEdit ? `Editar ${editorName}` : "Nueva secret"}</DialogTitle>
            <DialogDescription className="text-xs">
              {editorIsEdit
                ? "Sobreescribe el valor actual. Los edge functions usarán el nuevo valor en la próxima invocación."
                : "Crea una nueva variable de entorno disponible para todas las edge functions."}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nombre</Label>
              <Input
                value={editorName}
                onChange={(e) => setEditorName(e.target.value.toUpperCase())}
                placeholder="MY_API_KEY"
                className="font-mono text-sm"
                disabled={editorIsEdit}
              />
              {!editorIsEdit && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  MAYÚSCULAS_CON_GUIONES_BAJOS. No puede empezar con <code>SUPABASE_</code>.
                </p>
              )}
            </div>
            <div>
              <Label>Valor</Label>
              <div className="flex items-center gap-1.5">
                <Input
                  type={showValue ? "text" : "password"}
                  value={editorValue}
                  onChange={(e) => setEditorValue(e.target.value)}
                  placeholder={editorIsEdit ? "(escribe el nuevo valor)" : "Valor del secret"}
                  className="font-mono text-sm"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowValue((v) => !v)}
                >
                  {showValue ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditorOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

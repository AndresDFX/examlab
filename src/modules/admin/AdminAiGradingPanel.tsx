/**
 * Panel admin: configuración de calificación IA + códigos override.
 *
 * Dos secciones en el mismo panel:
 *
 *   1) Modo de procesamiento (`ai_model_settings.processing_mode`):
 *      sync vs async (default async). Toggle ÚNICO global de la
 *      plataforma. En async, todas las llamadas IA se encolan en
 *      `ai_grading_queue` y un worker hourly las drena.
 *
 *   2) Códigos override (`ai_override_codes`): genera códigos one-time
 *      con TTL configurable. Cuando un docente necesita IA inmediata,
 *      le pasas el código por canal externo (email/Slack) — él lo
 *      activa en la UI y le abre una ventana de N minutos en modo
 *      sync (saltea la cola).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { TableEmpty, ErrorState } from "@/components/ui/empty-state";
import { HelpHint } from "@/components/ui/help-hint";
import { RowAction } from "@/components/ui/row-action";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Cpu, Plus, Copy, Trash2, Zap, Clock } from "lucide-react";
import {
  useMultiSelect,
  MultiSelectHeaderCheckbox,
  MultiSelectCheckbox,
  MultiSelectToolbar,
  BulkDeleteDialog,
} from "@/components/ui/multi-select";
import { toast } from "sonner";
import { invalidateModeCache } from "@/modules/ai/ai-grading";
import { formatDateTime } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface OverrideCodeRow {
  id: string;
  code: string;
  label: string | null;
  max_uses: number;
  uses_count: number;
  window_minutes: number;
  /** NULL = sin tope. Cap de mensajes IA que cada activación puede
   *  consumir antes de caer en async. Ver migración 20260603103200. */
  max_messages_per_activation: number | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

function randomCode(len = 8): string {
  // Letras y dígitos sin ambigüedades (sin 0/O, 1/I/L).
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

export function AdminAiGradingPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const confirm = useConfirm();
  const [mode, setMode] = useState<"sync" | "async">("async");
  const [savingMode, setSavingMode] = useState(false);
  const [loadingMode, setLoadingMode] = useState(true);

  const [codes, setCodes] = useState<OverrideCodeRow[]>([]);
  // Total de mensajes IA consumidos por código (sumados a lo largo de
  // todas las activaciones del código). El cap por activación vive en
  // `ai_override_codes.max_messages_per_activation`; el budget total
  // teórico es `max_uses × cap`. Lo calculamos aquí para mostrar
  // "consumidos / total" en el grid.
  const [consumedByCode, setConsumedByCode] = useState<Record<string, number>>({});
  const [loadingCodes, setLoadingCodes] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newWindowMin, setNewWindowMin] = useState(60);
  const [newMaxUses, setNewMaxUses] = useState(1);
  // Cap de mensajes IA por activación. "" = sin tope (NULL en DB).
  // Por defecto 10 — balance razonable entre permitir trabajo real al
  // docente y limitar el consumo accidental de cuota Gemini.
  const [newMaxMessages, setNewMaxMessages] = useState<number | "">(10);
  const [newTtlHours, setNewTtlHours] = useState<number | "">(24);
  // Multi-select para bulk delete de códigos IA. El hook deriva el set
  // de seleccionados; cuando count > 0, MultiSelectToolbar aparece
  // arriba de la tabla con el botón "Eliminar (N)".
  const sel = useMultiSelect(codes);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const loadMode = async () => {
    setLoadingMode(true);
    const { data } = await db
      .from("ai_model_settings")
      .select("processing_mode")
      .eq("is_active", true)
      .maybeSingle();
    setMode((data?.processing_mode as "sync" | "async") ?? "async");
    setLoadingMode(false);
  };

  const [codesError, setCodesError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const loadCodes = async () => {
    setLoadingCodes(true);
    setCodesError(null);
    const { data, error } = await db
      .from("ai_override_codes")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      setCodesError(friendlyError(error, "No pudimos cargar los códigos de override."));
      setLoadingCodes(false);
      return;
    }
    const rows = (data ?? []) as OverrideCodeRow[];
    setCodes(rows);
    // Cargamos en paralelo las activaciones para sumar `messages_consumed`
    // por código. La policy de SELECT permite a Admin leerlas todas, así
    // que un único query basta. Si esto falla no rompemos el grid — los
    // counts quedan en 0 y el resto sigue funcionando.
    const { data: acts } = await db
      .from("ai_override_activations")
      .select("code_id, messages_consumed");
    if (acts) {
      const sum: Record<string, number> = {};
      for (const a of acts as Array<{ code_id: string; messages_consumed: number | null }>) {
        sum[a.code_id] = (sum[a.code_id] ?? 0) + (a.messages_consumed ?? 0);
      }
      setConsumedByCode(sum);
    }
    setLoadingCodes(false);
  };

  useEffect(() => {
    void loadMode();
    void loadCodes();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const saveMode = async (next: "sync" | "async") => {
    setSavingMode(true);
    const { error } = await db
      .from("ai_model_settings")
      .update({ processing_mode: next })
      .eq("is_active", true);
    setSavingMode(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    setMode(next);
    invalidateModeCache();
    toast.success(
      i18n.t("toast.modules_admin_AdminAiGradingPanel.modeSaved", {
        defaultValue: "Modo IA: {{mode}}",
        mode:
          next === "async"
            ? i18n.t("toast.modules_admin_AdminAiGradingPanel.modeQueueLabel", {
                defaultValue: "Cola (batch)",
              })
            : i18n.t("toast.modules_admin_AdminAiGradingPanel.modeSyncLabel", {
                defaultValue: "Sincrónico",
              }),
      }),
    );
  };

  const createCode = async () => {
    if (!user) return;
    if (newWindowMin < 1 || newWindowMin > 1440) {
      toast.error(
        i18n.t("toast.modules_admin_AdminAiGradingPanel.windowRange", {
          defaultValue: "Ventana debe estar entre 1 y 1440 minutos.",
        }),
      );
      return;
    }
    if (newMaxUses < 1) {
      toast.error(
        i18n.t("toast.modules_admin_AdminAiGradingPanel.maxUsesMin", {
          defaultValue: "Máximo de usos debe ser >= 1",
        }),
      );
      return;
    }
    if (
      typeof newMaxMessages === "number" &&
      (newMaxMessages < 1 || newMaxMessages > 10000)
    ) {
      toast.error(
        i18n.t("toast.modules_admin_AdminAiGradingPanel.maxMessagesRange", {
          defaultValue:
            "Máximo de mensajes debe estar entre 1 y 10 000 (o vacío = sin tope).",
        }),
      );
      return;
    }
    const code = randomCode(8);
    setCreating(true);
    const payload: Record<string, unknown> = {
      code,
      label: newLabel.trim() || null,
      max_uses: newMaxUses,
      window_minutes: newWindowMin,
      // null en DB = sin tope; sólo persistimos si el admin tipeó un número.
      max_messages_per_activation:
        typeof newMaxMessages === "number" ? newMaxMessages : null,
      created_by: user.id,
    };
    if (typeof newTtlHours === "number" && newTtlHours > 0) {
      const exp = new Date(Date.now() + newTtlHours * 3600 * 1000).toISOString();
      payload.expires_at = exp;
    }
    const { error } = await db.from("ai_override_codes").insert(payload);
    setCreating(false);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.modules_admin_AdminAiGradingPanel.codeCreated", {
        defaultValue: "Código creado: {{code}} (cópialo y pásalo al docente)",
        code,
      }),
    );
    setNewLabel("");
    await loadCodes();
  };

  const copyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(
        i18n.t("toast.modules_admin_AdminAiGradingPanel.codeCopied", {
          defaultValue: "Código copiado",
        }),
      );
    } catch {
      toast.error(
        i18n.t("toast.modules_admin_AdminAiGradingPanel.copyFailed", {
          defaultValue: "No se pudo copiar — selecciónalo a mano.",
        }),
      );
    }
  };

  const revokeCode = async (row: OverrideCodeRow) => {
    const ok = await confirm({
      title: t("adminAiGradingPanel.revokeTitle", { code: row.code }),
      description: t("adminAiGradingPanel.revokeDesc"),
      tone: "warning",
      confirmLabel: t("adminAiGradingPanel.revokeConfirm"),
    });
    if (!ok) return;
    const { error } = await db
      .from("ai_override_codes")
      .update({ revoked_at: new Date().toISOString(), revoked_by: user?.id })
      .eq("id", row.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.modules_admin_AdminAiGradingPanel.codeRevoked", {
        defaultValue: "Código revocado",
      }),
    );
    void loadCodes();
  };

  const deleteCode = async (row: OverrideCodeRow) => {
    const ok = await confirm({
      title: t("adminAiGradingPanel.deleteTitle", { code: row.code }),
      description: t("adminAiGradingPanel.deleteDesc"),
      tone: "destructive",
      confirmLabel: t("adminAiGradingPanel.deleteConfirm"),
    });
    if (!ok) return;
    const { error } = await db.from("ai_override_codes").delete().eq("id", row.id);
    if (error) {
      toast.error(friendlyError(error));
      return;
    }
    toast.success(
      i18n.t("toast.modules_admin_AdminAiGradingPanel.codeDeleted", {
        defaultValue: "Código eliminado",
      }),
    );
    void loadCodes();
  };

  /**
   * Bulk delete: borra todos los códigos seleccionados via `.in('id', ids)`
   * en una sola query atómica. Si la query falla, ningún código se
   * elimina (Postgres garantiza all-or-nothing en un solo DELETE).
   * BulkDeleteDialog muestra preview de los códigos antes de confirmar.
   */
  const bulkDeleteSelected = async () => {
    const ids = Array.from(sel.selectedIds);
    if (ids.length === 0) return;
    const { error } = await db.from("ai_override_codes").delete().in("id", ids);
    if (error) {
      toast.error(friendlyError(error, "No se pudieron eliminar los códigos"));
      return;
    }
    toast.success(
      i18n.t("toast.modules_admin_AdminAiGradingPanel.codesBulkDeleted", {
        defaultValue: "{{count}} código(s) eliminado(s)",
        count: ids.length,
      }),
    );
    sel.clear();
    void loadCodes();
  };

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Cpu className="h-4 w-4 text-primary" />
            {t("adminAiGradingPanel.cardProcessingTitle")}
            <HelpHint>
              {t("adminAiGradingPanel.cardProcessingHint")}
            </HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadingMode ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" /> {t("adminAiGradingPanel.loading")}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={mode === "async" ? "default" : "outline"}
                onClick={() => void saveMode("async")}
                disabled={savingMode || mode === "async"}
              >
                <Clock className="h-3.5 w-3.5 mr-1" />
                {t("adminAiGradingPanel.modeAsync")}
              </Button>
              <Button
                size="sm"
                variant={mode === "sync" ? "default" : "outline"}
                onClick={() => void saveMode("sync")}
                disabled={savingMode || mode === "sync"}
              >
                <Zap className="h-3.5 w-3.5 mr-1" />
                {t("adminAiGradingPanel.modeSync")}
              </Button>
              <Badge variant="outline" className="text-[10px] ml-auto">
                {t("adminAiGradingPanel.current", { mode: mode === "async" ? t("adminAiGradingPanel.modeQueueShort") : "sync" })}
              </Badge>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t("adminAiGradingPanel.processingNote")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4 text-amber-500" />
            {t("adminAiGradingPanel.cardCodesTitle")}
            <HelpHint><span dangerouslySetInnerHTML={{ __html: t("help.overrideCodesPurpose") }} /></HelpHint>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
            <div>
              <Label className="text-[11px]">{t("adminAiGradingPanel.labelField")}</Label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder={t("adminAiGradingPanel.labelPlaceholder")}
              />
            </div>
            <div>
              <Label className="text-[11px]">
                {t("adminAiGradingPanel.windowField")}
                <HelpHint>{t("help.windowDurationHelp")}</HelpHint>
              </Label>
              <Input
                type="number"
                min={1}
                max={1440}
                value={newWindowMin}
                onChange={(e) => setNewWindowMin(Number(e.target.value) || 60)}
              />
            </div>
            <div>
              <Label className="text-[11px]">
                {t("adminAiGradingPanel.maxActivationsField")}
                <HelpHint>{t("help.maxActivationsHelp")}</HelpHint>
              </Label>
              <Input
                type="number"
                min={1}
                value={newMaxUses}
                onChange={(e) => setNewMaxUses(Number(e.target.value) || 1)}
              />
            </div>
            <div>
              <Label className="text-[11px]">
                {t("adminAiGradingPanel.maxMessagesField")}
                <HelpHint>{t("help.maxMessagesHelp")}</HelpHint>
              </Label>
              <Input
                type="number"
                min={1}
                max={10000}
                value={newMaxMessages === "" ? "" : newMaxMessages}
                onChange={(e) =>
                  setNewMaxMessages(e.target.value === "" ? "" : Number(e.target.value))
                }
                placeholder={t("adminAiGradingPanel.noLimit")}
              />
            </div>
            <div>
              <Label className="text-[11px]">{t("adminAiGradingPanel.expiresField")}</Label>
              <Input
                type="number"
                min={1}
                value={newTtlHours === "" ? "" : newTtlHours}
                onChange={(e) =>
                  setNewTtlHours(e.target.value === "" ? "" : Number(e.target.value))
                }
                placeholder={t("adminAiGradingPanel.noExpiry")}
              />
            </div>
          </div>
          <Button size="sm" onClick={() => void createCode()} disabled={creating}>
            {creating ? <Spinner size="sm" className="mr-1" /> : <Plus className="h-4 w-4 mr-1" />}
            {t("adminAiGradingPanel.btnGenerate")}
          </Button>

          {loadingCodes ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
              <Spinner size="sm" /> {t("adminAiGradingPanel.loadingCodes")}
            </div>
          ) : codesError ? (
            <ErrorState
              message={t("adminAiGradingPanel.codesLoadError")}
              hint={codesError}
              onRetry={() => setRetryNonce((n) => n + 1)}
            />
          ) : codes.length === 0 ? (
            <TableEmpty
              icon={Zap}
              title={t("adminAiGradingPanel.emptyCodesTitle")}
              description={t("adminAiGradingPanel.emptyCodesDesc")}
            />
          ) : (
            <>
              {/* Toolbar de selección múltiple — solo se renderiza cuando
                  hay al menos 1 código seleccionado (count > 0 internamente).
                  El handler `onDelete` abre BulkDeleteDialog para confirm
                  con preview de los códigos antes de borrar. */}
              <MultiSelectToolbar
                count={sel.count}
                onClear={sel.clear}
                onDelete={() => setBulkDeleteOpen(true)}
                entityNameSingular={t("adminAiGradingPanel.entitySingular")}
                entityNamePlural={t("adminAiGradingPanel.entityPlural")}
              />
              <div className="overflow-x-auto">
                <Table fixed resizable>
                  <TableHeader>
                    <TableRow>
                      {/* Header checkbox "select all / none / indeterminate".
                          Opera sobre el array `codes` completo (no filtra). */}
                      <TableHead className="w-10">
                        <MultiSelectHeaderCheckbox state={sel} />
                      </TableHead>
                      <TableHead className="w-32">{t("adminAiGradingPanel.colCode")}</TableHead>
                      <TableHead>{t("adminAiGradingPanel.colLabel")}</TableHead>
                      <TableHead className="w-24">{t("adminAiGradingPanel.colActivations")}</TableHead>
                      <TableHead className="w-24">{t("adminAiGradingPanel.colWindow")}</TableHead>
                      <TableHead className="w-28">{t("adminAiGradingPanel.colMessages")}</TableHead>
                      <TableHead className="w-24">{t("adminAiGradingPanel.colStatus")}</TableHead>
                      <TableHead className="w-44">{t("adminAiGradingPanel.colCreated")}</TableHead>
                      <TableHead className="w-[120px]">{t("adminAiGradingPanel.colActions")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {codes.map((c) => {
                    const exhausted = c.uses_count >= c.max_uses;
                    const expired = c.expires_at ? new Date(c.expires_at) < new Date() : false;
                    const revoked = !!c.revoked_at;
                    const status = revoked
                      ? { label: t("adminAiGradingPanel.statusRevoked"), variant: "destructive" as const }
                      : exhausted
                        ? { label: t("adminAiGradingPanel.statusExhausted"), variant: "secondary" as const }
                        : expired
                          ? { label: t("adminAiGradingPanel.statusExpired"), variant: "secondary" as const }
                          : { label: t("adminAiGradingPanel.statusActive"), variant: "default" as const };
                    return (
                      <TableRow key={c.id}>
                        <TableCell>
                          <MultiSelectCheckbox id={c.id} state={sel} />
                        </TableCell>
                        <TableCell>
                          <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-muted">
                            {c.code}
                          </code>
                        </TableCell>
                        <TableCell className="text-xs" truncate title={c.label ?? undefined}>{c.label ?? "—"}</TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {c.uses_count} / {c.max_uses}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {t("adminAiGradingPanel.windowValue", { min: c.window_minutes })}
                        </TableCell>
                        <TableCell className="text-xs tabular-nums">
                          {(() => {
                            // Sin cap por activación → mostramos sólo el
                            // consumido (sin denominador).
                            const consumed = consumedByCode[c.id] ?? 0;
                            if (c.max_messages_per_activation == null) {
                              return `${consumed} / ${t("adminAiGradingPanel.noLimit")}`;
                            }
                            // Budget total = cap × max_uses. Refleja el
                            // "techo absoluto" si todas las activaciones
                            // se consumieran completas.
                            const total = c.max_messages_per_activation * c.max_uses;
                            return `${consumed} / ${total}`;
                          })()}
                        </TableCell>
                        <TableCell>
                          <Badge variant={status.variant} className="text-[10px]">
                            {status.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-[11px] text-muted-foreground">
                          {formatDateTime(c.created_at)}
                          {c.expires_at && (
                            <div className="text-[10px]">exp {formatDateTime(c.expires_at)}</div>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1">
                            <RowAction
                              label={t("adminAiGradingPanel.actionCopy")}
                              icon={Copy}
                              onClick={() => void copyCode(c.code)}
                            />
                            {!revoked && (
                              <RowAction
                                label={t("adminAiGradingPanel.actionRevoke")}
                                icon={Zap}
                                onClick={() => void revokeCode(c)}
                              />
                            )}
                            <RowAction
                              label={t("adminAiGradingPanel.actionDelete")}
                              icon={Trash2}
                              tone="destructive"
                              onClick={() => void deleteCode(c)}
                            />
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Dialog de confirmación para bulk delete. Muestra preview de
          los códigos seleccionados (label o el código en sí si no tiene
          label) antes de borrar. El bulk-delete-handler hace un único
          DELETE atómico con `.in('id', ids)`. */}
      <BulkDeleteDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        items={Array.from(sel.selectedIds).map((id) => {
          const c = codes.find((x) => x.id === id);
          return {
            id,
            label: c ? `${c.code}${c.label ? ` (${c.label})` : ""}` : id,
          };
        })}
        entityNameSingular={t("adminAiGradingPanel.entitySingular")}
        entityNamePlural={t("adminAiGradingPanel.entityPlural")}
        extraWarning={t("adminAiGradingPanel.bulkDeleteWarning")}
        onConfirm={async () => {
          await bulkDeleteSelected();
        }}
      />
    </div>
  );
}

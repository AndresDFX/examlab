/**
 * Panel de retención de audit_logs (Admin).
 *
 * Días a conservar por severidad. 0 = ilimitado (default).
 * El admin programa el cron por separado en Supabase:
 *   SELECT cron.schedule('audit-logs-purge', '0 3 1 * *',
 *     $$ SELECT public.purge_audit_logs(); $$);
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { HelpHint } from "@/components/ui/help-hint";
import { toast } from "sonner";
import { Save, Info, ScrollText, Trash2 } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface RetentionRow {
  id: string;
  info_days: number;
  warning_days: number;
  error_days: number;
  updated_at: string;
}

export function AdminAuditRetentionPanel() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [row, setRow] = useState<RetentionRow | null>(null);
  const [draft, setDraft] = useState({ info: 0, warning: 0, error: 0 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [purging, setPurging] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    const { data, error } = await db
      .from("audit_retention_settings")
      .select("id, info_days, warning_days, error_days, updated_at")
      .maybeSingle();
    if (error) {
      setLoadError(friendlyError(error, "No pudimos cargar la configuración."));
      setLoading(false);
      return;
    }
    if (data) {
      const r = data as RetentionRow;
      setRow(r);
      setDraft({ info: r.info_days, warning: r.warning_days, error: r.error_days });
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryNonce]);

  const dirty =
    !row ||
    draft.info !== row.info_days ||
    draft.warning !== row.warning_days ||
    draft.error !== row.error_days;

  const handleSave = async () => {
    if (!user || !row) return;
    setSaving(true);
    try {
      const { error } = await db
        .from("audit_retention_settings")
        .update({
          info_days: draft.info,
          warning_days: draft.warning,
          error_days: draft.error,
          updated_by: user.id,
        })
        .eq("id", row.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      void logEvent({
        action: "audit_retention.updated",
        category: "system",
        severity: "warning",
        metadata: {
          previous: {
            info_days: row.info_days,
            warning_days: row.warning_days,
            error_days: row.error_days,
          },
          new: draft,
        },
      });
      toast.success("Retención actualizada");
      await load();
    } finally {
      setSaving(false);
    }
  };

  const handleRunNow = async () => {
    setPurging(true);
    try {
      const { data, error } = await db.rpc("purge_audit_logs");
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      const r = Array.isArray(data) ? data[0] : data;
      const total =
        Number(r?.info_purged ?? 0) +
        Number(r?.warning_purged ?? 0) +
        Number(r?.error_purged ?? 0);
      toast.success(
        total === 0
          ? "Sin registros para purgar"
          : `Purgados: ${r.info_purged} info, ${r.warning_purged} warning, ${r.error_purged} error/critical`,
      );
    } finally {
      setPurging(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="sm" /> Cargando configuración…
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar la configuración de retención"
        hint={loadError}
        onRetry={() => setRetryNonce((n) => n + 1)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ScrollText className="h-4 w-4 text-indigo-500" />
            Retención de auditoría
            <HelpHint>{t("help.retentionHelp")}</HelpHint>
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Los registros antiguos se borran automáticamente. Severidades más altas suelen
            conservarse más tiempo.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <Label>Info (días)</Label>
              <Input
                type="number"
                min={0}
                value={draft.info}
                onChange={(e) => setDraft((d) => ({ ...d, info: Number(e.target.value) || 0 }))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Eventos rutinarios (entregas, calificaciones, etc.)
              </p>
            </div>
            <div>
              <Label>Warning (días)</Label>
              <Input
                type="number"
                min={0}
                value={draft.warning}
                onChange={(e) => setDraft((d) => ({ ...d, warning: Number(e.target.value) || 0 }))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Eventos sensibles (cambios de peso, sospechas, roles).
              </p>
            </div>
            <div>
              <Label>Error / Critical (días)</Label>
              <Input
                type="number"
                min={0}
                value={draft.error}
                onChange={(e) => setDraft((d) => ({ ...d, error: Number(e.target.value) || 0 }))}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Fallos y eventos críticos. Conservar más tiempo.
              </p>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs space-y-1">
              <p>
                <strong>Para activar la purga automática</strong>, programa el cron en Supabase
                SQL Editor:
              </p>
              <pre className="text-[11px] font-mono bg-muted p-2 rounded mt-1 overflow-x-auto">
                {`SELECT cron.schedule('audit-logs-purge', '0 3 1 * *',
  $$ SELECT public.purge_audit_logs(); $$);`}
              </pre>
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2 justify-end pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleRunNow()}
              disabled={purging || saving}
            >
              {purging ? <Spinner size="sm" className="mr-1" /> : <Trash2 className="h-4 w-4 mr-1" />}
              Purgar ahora
            </Button>
            {dirty && row && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setDraft({
                    info: row.info_days,
                    warning: row.warning_days,
                    error: row.error_days,
                  })
                }
                disabled={saving}
              >
                Cancelar
              </Button>
            )}
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || !dirty}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

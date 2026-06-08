/**
 * PlatformSettingsPanel — controles cross-tenant del SuperAdmin.
 *
 * Esta vista vive en `/app/superadmin/system` → tab "Plataforma".
 * Lee/escribe `public.platform_settings` (single-row, mig
 * 20260907000000). RLS asegura que solo el SA pueda hacer UPDATE.
 *
 * Toggles disponibles hoy:
 *   - support_emails_enabled: cuando ON, los triggers del módulo Soporte
 *     mandan notif in-app + email a cada parte. Cuando OFF, sigue la
 *     notif in-app pero NO sale el email. Útil para silenciar la
 *     bandeja del SA durante un debug, o cuando el SA prefiere gestionar
 *     todo desde el panel sin saturar el correo.
 *
 * Convención: si en el futuro se agregan más toggles globales, se
 * suman acá. Si crece mucho, se split-tea en sub-componentes pero el
 * panel principal queda en este archivo para que el SA tenga UN solo
 * lugar para "configuración de plataforma".
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ErrorState } from "@/components/ui/empty-state";
import { Settings2, Save, LifeBuoy, Info } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface PlatformSettings {
  id: number;
  support_emails_enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

export function PlatformSettingsPanel() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [draftSupportEmails, setDraftSupportEmails] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setLoadError(null);
      const { data, error } = await db
        .from("platform_settings")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        setLoadError(friendlyError(error, "No pudimos cargar la configuración de plataforma."));
        setLoading(false);
        return;
      }
      const row = data as PlatformSettings | null;
      if (row) {
        setSettings(row);
        setDraftSupportEmails(row.support_emails_enabled);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [retryNonce]);

  const dirty =
    settings != null && draftSupportEmails !== settings.support_emails_enabled;

  const save = async () => {
    if (!user || saving) return;
    setSaving(true);
    try {
      const { error } = await db
        .from("platform_settings")
        .update({ support_emails_enabled: draftSupportEmails })
        .eq("id", 1);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(i18n.t("toast.modules_superadmin_PlatformSettingsPanel.savedOk", { defaultValue: "Configuración guardada" }));
      void logEvent({
        action: "platform_settings.updated",
        category: "system",
        severity: "warning",
        metadata: {
          support_emails_enabled: draftSupportEmails,
          previous_support_emails_enabled: settings?.support_emails_enabled ?? null,
        },
      });
      setSettings({
        id: 1,
        support_emails_enabled: draftSupportEmails,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="md" /> Cargando…
        </CardContent>
      </Card>
    );
  }

  if (loadError) {
    return (
      <ErrorState
        message="No pudimos cargar la configuración"
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
            <Settings2 className="h-4 w-4 text-violet-500" />
            Configuración de plataforma
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Controles cross-tenant exclusivos del SuperAdmin. Aplican a TODAS las instituciones.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className={`flex items-start gap-3 rounded-lg border p-3 transition-colors ${
              draftSupportEmails
                ? "border-emerald-500/40 bg-emerald-500/5"
                : "border-muted bg-muted/30"
            }`}
          >
            <LifeBuoy className="h-5 w-5 text-primary mt-0.5 shrink-0" />
            <div className="flex-1 space-y-1">
              <Label className="text-sm font-medium flex items-center gap-2 cursor-pointer">
                Correos de Soporte
                <Switch
                  checked={draftSupportEmails}
                  onCheckedChange={setDraftSupportEmails}
                  disabled={saving}
                />
              </Label>
              <p className="text-xs text-muted-foreground">
                Cuando está activo, cada interacción del módulo Soporte (apertura de ticket,
                respuesta, cambio de estado) dispara <strong>email</strong> al destinatario.
                Cuando está desactivado, las notificaciones siguen apareciendo en la campana
                in-app pero NO sale email — útil si gestionás todo desde el panel sin saturar
                la bandeja.
              </p>
            </div>
          </div>

          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription className="text-xs">
              Este toggle aplica a TODOS los tenants (no se puede configurar por institución
              individual). El Admin del tenant no puede modificarlo — solo el SuperAdmin.
            </AlertDescription>
          </Alert>

          <div className="flex flex-wrap gap-2 justify-end pt-1">
            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraftSupportEmails(settings?.support_emails_enabled ?? true)}
                disabled={saving}
              >
                Cancelar
              </Button>
            )}
            <Button size="sm" onClick={() => void save()} disabled={saving || !dirty}>
              {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
              Guardar configuración
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

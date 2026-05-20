/**
 * Panel de configuración de correos (Admin).
 * Extraído de app.admin.email-settings para poder reutilizarse
 * tanto en la ruta /admin/email-settings como en /admin/settings.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { logEvent } from "@/shared/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Mail,
  Save,
  AlertTriangle,
  FileText,
  Hammer,
  FolderKanban,
  Award,
  MessageSquareText,
  Send,
  Server,
} from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface EnabledKinds {
  exam?: boolean;
  workshop?: boolean;
  project?: boolean;
  grade?: boolean;
  feedback?: boolean;
  messages?: boolean;
  /** Alertas del sistema a admins (storage threshold). Antes este kind
   *  se emailaba sin toggle — la migración 20260603104500 lo registró. */
  system_alerts?: boolean;
}

interface EmailSettings {
  id: number;
  globally_enabled: boolean;
  enabled_kinds: EnabledKinds;
  updated_at: string;
  updated_by: string | null;
}

const CATEGORIES: Array<{
  key: keyof EnabledKinds;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}> = [
  {
    key: "exam",
    label: "Exámenes",
    desc: "Asignación, publicación, recordatorios, notas de apoyo aprobadas/rechazadas",
    icon: FileText,
    color: "text-violet-500",
  },
  {
    key: "workshop",
    label: "Talleres",
    desc: "Nuevos talleres publicados y recordatorios de vencimiento",
    icon: Hammer,
    color: "text-amber-500",
  },
  {
    key: "project",
    label: "Proyectos",
    desc: "Nuevos proyectos y recordatorios de vencimiento",
    icon: FolderKanban,
    color: "text-rose-500",
  },
  {
    key: "grade",
    label: "Calificaciones",
    desc: "Cuando se publica la nota de una entrega",
    icon: Award,
    color: "text-emerald-500",
  },
  {
    key: "feedback",
    label: "Retroalimentación",
    desc: "Comentarios nuevos, cierre/apertura de conversaciones",
    icon: MessageSquareText,
    color: "text-pink-500",
  },
  {
    key: "messages",
    label: "Mensajes 1-a-1",
    desc: "Chat interno (rate-limited a 1 por conversación / 10 min)",
    icon: Send,
    color: "text-cyan-500",
  },
  {
    key: "system_alerts",
    label: "Alertas del sistema",
    desc: "Notificaciones a admins cuando se cruza un umbral (almacenamiento, errores, etc.). NO afecta correos transaccionales (reset de contraseña, cambio de email).",
    icon: Server,
    color: "text-slate-500",
  },
];

export function AdminEmailSettingsPanel() {
  const { roles } = useAuth();
  const isAdmin = roles.includes("Admin");
  const [settings, setSettings] = useState<EmailSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [globallyEnabled, setGloballyEnabled] = useState(true);
  const [enabledKinds, setEnabledKinds] = useState<EnabledKinds>({});

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await db
        .from("email_settings")
        .select("*")
        .eq("id", 1)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        toast.error(`No se pudo cargar la configuración: ${friendlyError(error)}`);
        setLoading(false);
        return;
      }
      const row = data as EmailSettings | null;
      if (row) {
        setSettings(row);
        setGloballyEnabled(row.globally_enabled);
        setEnabledKinds(row.enabled_kinds ?? {});
      }
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [isAdmin]);

  const dirty =
    settings != null &&
    (globallyEnabled !== settings.globally_enabled ||
      JSON.stringify(enabledKinds) !== JSON.stringify(settings.enabled_kinds ?? {}));

  const save = async () => {
    setSaving(true);
    const { error } = await db
      .from("email_settings")
      .update({ globally_enabled: globallyEnabled, enabled_kinds: enabledKinds })
      .eq("id", 1);
    if (error) {
      toast.error(friendlyError(error));
      setSaving(false);
      return;
    }
    toast.success("Configuración guardada");
    void logEvent({
      action: "email_settings.updated",
      category: "system",
      severity: "warning",
      metadata: { globally_enabled: globallyEnabled, enabled_kinds: enabledKinds },
    });
    setSettings({
      id: 1,
      globally_enabled: globallyEnabled,
      enabled_kinds: enabledKinds,
      updated_at: new Date().toISOString(),
      updated_by: null,
    });
    setSaving(false);
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-muted-foreground">
          <Spinner size="md" /> Cargando…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Kill switch global */}
      <Card className={!globallyEnabled ? "border-destructive/40 bg-destructive/5" : undefined}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle
              className={`h-4 w-4 ${!globallyEnabled ? "text-destructive" : "text-amber-500"}`}
            />
            Interruptor global
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <Label htmlFor="globally-enabled" className="text-sm font-medium">
                Envío de correos habilitado
              </Label>
              <p className="text-xs text-muted-foreground">
                Cuando se desactiva, NINGÚN correo se envía — independiente de los toggles por
                categoría. Las notificaciones in-app y push siguen funcionando.
              </p>
              {!globallyEnabled && (
                <Badge variant="destructive" className="text-[10px] mt-1">
                  Correos desactivados globalmente
                </Badge>
              )}
            </div>
            <Switch
              id="globally-enabled"
              checked={globallyEnabled}
              onCheckedChange={setGloballyEnabled}
            />
          </div>
        </CardContent>
      </Card>

      {/* Toggles por categoría */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Mail className="h-4 w-4 text-indigo-500" />
            Por categoría
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {CATEGORIES.map((cat) => {
            const Icon = cat.icon;
            const isOn = enabledKinds[cat.key] !== false;
            return (
              <div
                key={cat.key}
                className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`mt-0.5 ${cat.color}`}>
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <Label htmlFor={`kind-${cat.key}`} className="text-sm font-medium cursor-pointer">
                      {cat.label}
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">{cat.desc}</p>
                  </div>
                </div>
                <Switch
                  id={`kind-${cat.key}`}
                  checked={isOn}
                  disabled={!globallyEnabled}
                  onCheckedChange={(v) =>
                    setEnabledKinds((prev) => ({ ...prev, [cat.key]: v }))
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      <div className="flex items-center justify-between">
        {settings && (
          <p className="text-[11px] text-muted-foreground">
            Última actualización: {formatDateTime(settings.updated_at)}
          </p>
        )}
        <Button size="sm" onClick={() => void save()} disabled={saving || !dirty} className="ml-auto">
          {saving ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
          Guardar cambios
        </Button>
      </div>
    </div>
  );
}

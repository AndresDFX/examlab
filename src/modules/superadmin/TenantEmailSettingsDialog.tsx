/**
 * Configuración de envío de correo (SMTP) POR TENANT.
 *
 * Cada institución puede usar su propia cuenta SMTP en vez de compartir la
 * global. Cuando `use_custom_smtp` está activo y las credenciales están
 * completas, el edge `send-email` las usa para los correos de ese tenant
 * (resuelve el tenant por el destinatario). Si no, cae al SMTP global.
 *
 * Acceso: SuperAdmin (cualquier tenant) y Admin del propio tenant (RLS).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { Mail } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantName: string;
}

interface Form {
  use_custom_smtp: boolean;
  smtp_host: string;
  smtp_port: string;
  smtp_user: string;
  smtp_password: string;
  email_from: string;
  email_from_name: string;
  reply_to: string;
}

const EMPTY: Form = {
  use_custom_smtp: false,
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_password: "",
  email_from: "",
  email_from_name: "",
  reply_to: "",
};

export function TenantEmailSettingsDialog({ open, onOpenChange, tenantId, tenantName }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Form>(EMPTY);

  useEffect(() => {
    if (!open || !tenantId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data } = await db
        .from("tenant_email_settings")
        .select(
          "use_custom_smtp, smtp_host, smtp_port, smtp_user, smtp_password, email_from, email_from_name, reply_to",
        )
        .eq("tenant_id", tenantId)
        .maybeSingle();
      if (cancelled) return;
      setForm(
        data
          ? {
              use_custom_smtp: !!data.use_custom_smtp,
              smtp_host: data.smtp_host ?? "",
              smtp_port: data.smtp_port != null ? String(data.smtp_port) : "587",
              smtp_user: data.smtp_user ?? "",
              smtp_password: data.smtp_password ?? "",
              email_from: data.email_from ?? "",
              email_from_name: data.email_from_name ?? "",
              reply_to: data.reply_to ?? "",
            }
          : EMPTY,
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tenantId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((p) => ({ ...p, [k]: v }));

  const save = async () => {
    // Validación: si usa SMTP propio, exigir los campos mínimos.
    if (form.use_custom_smtp) {
      const port = Number(form.smtp_port);
      if (
        !form.smtp_host.trim() ||
        !Number.isFinite(port) ||
        port <= 0 ||
        !form.smtp_user.trim() ||
        !form.smtp_password.trim() ||
        !form.email_from.trim()
      ) {
        toast.error(
          t("tenantEmail.incomplete", {
            defaultValue:
              "Completa host, puerto, usuario, contraseña y remitente para usar SMTP propio.",
          }),
        );
        return;
      }
    }
    setSaving(true);
    try {
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db.from("tenant_email_settings").upsert(
        {
          tenant_id: tenantId,
          use_custom_smtp: form.use_custom_smtp,
          smtp_host: form.smtp_host.trim() || null,
          smtp_port: form.smtp_port ? Number(form.smtp_port) : null,
          smtp_user: form.smtp_user.trim() || null,
          smtp_password: form.smtp_password.trim() || null,
          email_from: form.email_from.trim() || null,
          email_from_name: form.email_from_name.trim() || null,
          reply_to: form.reply_to.trim() || null,
          updated_at: new Date().toISOString(),
          updated_by: auth?.user?.id ?? null,
        },
        { onConflict: "tenant_id" },
      );
      if (error) throw error;
      toast.success(t("tenantEmail.saved", { defaultValue: "Configuración de correo guardada" }));
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e, t("tenantEmail.saveError", { defaultValue: "No se pudo guardar" })));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5 text-primary" />
            {t("tenantEmail.title", { defaultValue: "Correo de la institución" })}
            <span className="text-sm font-normal text-muted-foreground truncate">· {tenantName}</span>
          </DialogTitle>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Spinner size="md" /> {t("common.loading", { defaultValue: "Cargando…" })}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-start justify-between gap-3 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label>{t("tenantEmail.useCustom", { defaultValue: "Usar SMTP propio" })}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("tenantEmail.useCustomHint", {
                    defaultValue:
                      "Si lo activas, los correos de esta institución se envían con su propia cuenta. Si no, se usa el SMTP global de la plataforma.",
                  })}
                </p>
              </div>
              <Switch
                checked={form.use_custom_smtp}
                onCheckedChange={(v) => set("use_custom_smtp", v)}
              />
            </div>

            <fieldset
              disabled={!form.use_custom_smtp}
              className={form.use_custom_smtp ? "space-y-3" : "space-y-3 opacity-50"}
            >
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <Label required>{t("tenantEmail.host", { defaultValue: "Servidor SMTP" })}</Label>
                  <Input
                    value={form.smtp_host}
                    onChange={(e) => set("smtp_host", e.target.value)}
                    placeholder="smtp.gmail.com"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label required>{t("tenantEmail.port", { defaultValue: "Puerto" })}</Label>
                  <Input
                    value={form.smtp_port}
                    onChange={(e) => set("smtp_port", e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="587"
                    inputMode="numeric"
                    className="mt-1"
                  />
                </div>
              </div>
              <div>
                <Label required>{t("tenantEmail.user", { defaultValue: "Usuario SMTP" })}</Label>
                <Input
                  value={form.smtp_user}
                  onChange={(e) => set("smtp_user", e.target.value)}
                  placeholder="cuenta@institucion.edu.co"
                  className="mt-1"
                />
              </div>
              <div>
                <Label required>{t("tenantEmail.password", { defaultValue: "Contraseña / App Password" })}</Label>
                <PasswordInput
                  value={form.smtp_password}
                  onChange={(e) => set("smtp_password", e.target.value)}
                  placeholder="••••••••"
                  wrapperClassName="mt-1"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t("tenantEmail.passwordHint", {
                    defaultValue:
                      "Para Gmail usa una App Password (no la contraseña de la cuenta).",
                  })}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label required>{t("tenantEmail.from", { defaultValue: "Remitente (From)" })}</Label>
                  <Input
                    value={form.email_from}
                    onChange={(e) => set("email_from", e.target.value)}
                    placeholder="no-reply@institucion.edu.co"
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label>{t("tenantEmail.fromName", { defaultValue: "Nombre del remitente" })}</Label>
                  <Input
                    value={form.email_from_name}
                    onChange={(e) => set("email_from_name", e.target.value)}
                    placeholder={tenantName}
                    className="mt-1"
                  />
                </div>
              </div>
            </fieldset>

            {/* Reply-To: aplica SIEMPRE (con o sin SMTP propio). El From no
                cambia (sigue el remitente verificado), solo el canal de respuesta. */}
            <div>
              <Label>{t("tenantEmail.replyTo", { defaultValue: "Correo de respuesta (Reply-To)" })}</Label>
              <Input
                value={form.reply_to}
                onChange={(e) => set("reply_to", e.target.value)}
                placeholder="contacto@institucion.edu.co"
                className="mt-1"
              />
              <p className="text-xs text-muted-foreground mt-1">
                {t("tenantEmail.replyToHint", {
                  defaultValue:
                    "A dónde llegan las respuestas de los alumnos. Se aplica aunque no uses SMTP propio; el remitente (From) no cambia. En difusiones, la respuesta va al docente que las envió.",
                })}
              </p>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button onClick={() => void save()} disabled={saving || loading}>
            {saving ? <Spinner size="md" className="mr-1" /> : null}
            {t("common.save", { defaultValue: "Guardar" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * TenantBillingDialog — editor COMERCIAL de una institución (SuperAdmin only).
 *
 * Permite configurar el plan, el modo de IA y el CICLO DE FACTURACIÓN
 * (fecha inicio/fin, ciclo, monto, gracia en días hábiles, auto-suspensión) de
 * un tenant. Sin esto el cron `process_tenant_subscriptions` queda inerte
 * (nadie tiene billing_end). La escritura es SA-only (RLS `tenants_update` =
 * is_super_admin + guard `tg_guard_tenant_commercial_columns`).
 *
 * Aislado del diálogo de create/edit de branding para no tocar su form.
 * Textos vía `t(..., {defaultValue})` (patrón del repo) — sin tocar los JSON.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { RotateCcw } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  tenantId: string;
  tenantName: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface BillingForm {
  plan_tier: string;
  ai_mode: string;
  subscription_status: string;
  billing_start: string;
  billing_end: string;
  billing_cycle: string;
  monthly_amount: string;
  currency: string;
  grace_business_days: string;
  auto_suspend: boolean;
  billing_contact_email: string;
}

const EMPTY: BillingForm = {
  plan_tier: "cortesia",
  ai_mode: "shared",
  subscription_status: "active",
  billing_start: "",
  billing_end: "",
  billing_cycle: "monthly",
  monthly_amount: "",
  currency: "USD",
  grace_business_days: "5",
  auto_suspend: false,
  billing_contact_email: "",
};

const CYCLE_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 };

export function TenantBillingDialog({ tenantId, tenantName, open, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<BillingForm>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      const { data } = await db
        .from("tenants")
        .select(
          "plan_tier, ai_mode, subscription_status, billing_start, billing_end, billing_cycle, monthly_amount, currency, grace_business_days, auto_suspend, billing_contact_email",
        )
        .eq("id", tenantId)
        .single();
      if (cancelled) return;
      if (data) {
        setForm({
          plan_tier: data.plan_tier ?? "cortesia",
          ai_mode: data.ai_mode ?? "shared",
          subscription_status: data.subscription_status ?? "active",
          billing_start: data.billing_start ?? "",
          billing_end: data.billing_end ?? "",
          billing_cycle: data.billing_cycle ?? "monthly",
          monthly_amount: data.monthly_amount == null ? "" : String(data.monthly_amount),
          currency: data.currency ?? "USD",
          grace_business_days: data.grace_business_days == null ? "5" : String(data.grace_business_days),
          auto_suspend: !!data.auto_suspend,
          billing_contact_email: data.billing_contact_email ?? "",
        });
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, tenantId]);

  const set = <K extends keyof BillingForm>(k: K, v: BillingForm[K]) =>
    setForm((p) => ({ ...p, [k]: v }));

  // "Renovar +1 ciclo": extiende billing_end un ciclo desde el máximo entre la
  // fecha fin actual y hoy, y reactiva.
  const renew = () => {
    const base = form.billing_end && form.billing_end >= todayStr() ? form.billing_end : todayStr();
    const d = new Date(base + "T00:00:00");
    d.setMonth(d.getMonth() + (CYCLE_MONTHS[form.billing_cycle] ?? 1));
    const end = d.toISOString().slice(0, 10);
    setForm((p) => ({
      ...p,
      billing_end: end,
      billing_start: p.billing_start || todayStr(),
      subscription_status: "active",
    }));
    toast.info(t("superadminTenants.billing.renewedHint", { defaultValue: "Fecha fin extendida — guarda para aplicar." }));
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        plan_tier: form.plan_tier,
        ai_mode: form.ai_mode,
        subscription_status: form.subscription_status,
        billing_start: form.billing_start || null,
        billing_end: form.billing_end || null,
        billing_cycle: form.billing_cycle,
        monthly_amount: form.monthly_amount.trim() === "" ? null : Number(form.monthly_amount.replace(",", ".")),
        currency: form.currency || "USD",
        grace_business_days: form.grace_business_days.trim() === "" ? 5 : parseInt(form.grace_business_days, 10),
        auto_suspend: form.auto_suspend,
        billing_contact_email: form.billing_contact_email || null,
      };
      const { error } = await db.from("tenants").update(payload).eq("id", tenantId);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(t("superadminTenants.billing.saved", { defaultValue: "Facturación actualizada." }));
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("superadminTenants.billing.title", { defaultValue: "Facturación y plan" })}</DialogTitle>
          <DialogDescription>{tenantName}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Spinner size="sm" /> {t("common.loading", { defaultValue: "Cargando…" })}
          </div>
        ) : (
          <div className="space-y-4 max-h-[70dvh] overflow-y-auto pr-1">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>{t("superadminTenants.billing.plan", { defaultValue: "Plan" })}</Label>
                <Select value={form.plan_tier} onValueChange={(v) => set("plan_tier", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cortesia">Cortesía / interno</SelectItem>
                    <SelectItem value="esencial">Esencial</SelectItem>
                    <SelectItem value="profesional">Profesional</SelectItem>
                    <SelectItem value="institucional">Institucional</SelectItem>
                    <SelectItem value="custom">Custom</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("superadminTenants.billing.ai", { defaultValue: "Modo de IA" })}</Label>
                <Select value={form.ai_mode} onValueChange={(v) => set("ai_mode", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="shared">Compartida (plataforma)</SelectItem>
                    <SelectItem value="own">Propia (key del tenant)</SelectItem>
                    <SelectItem value="managed">Gestionada (proveedor)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("superadminTenants.billing.start", { defaultValue: "Fecha inicio" })}</Label>
                <Input type="date" className="mt-1" value={form.billing_start} onChange={(e) => set("billing_start", e.target.value)} />
              </div>
              <div>
                <Label>{t("superadminTenants.billing.end", { defaultValue: "Fecha fin (vencimiento)" })}</Label>
                <Input type="date" className="mt-1" value={form.billing_end} onChange={(e) => set("billing_end", e.target.value)} />
              </div>
              <div>
                <Label>{t("superadminTenants.billing.cycle", { defaultValue: "Ciclo" })}</Label>
                <Select value={form.billing_cycle} onValueChange={(v) => set("billing_cycle", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">Mensual</SelectItem>
                    <SelectItem value="quarterly">Trimestral</SelectItem>
                    <SelectItem value="yearly">Anual</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("superadminTenants.billing.status", { defaultValue: "Estado" })}</Label>
                <Select value={form.subscription_status} onValueChange={(v) => set("subscription_status", v)}>
                  <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="trial">Trial</SelectItem>
                    <SelectItem value="active">Activa</SelectItem>
                    <SelectItem value="past_due">En gracia</SelectItem>
                    <SelectItem value="suspended">Suspendida</SelectItem>
                    <SelectItem value="cancelled">Cancelada</SelectItem>
                    <SelectItem value="expired">Vencida</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>{t("superadminTenants.billing.amount", { defaultValue: "Monto" })}</Label>
                <Input className="mt-1" inputMode="decimal" value={form.monthly_amount} onChange={(e) => set("monthly_amount", e.target.value)} placeholder="0" />
              </div>
              <div>
                <Label>{t("superadminTenants.billing.currency", { defaultValue: "Moneda" })}</Label>
                <Input className="mt-1" value={form.currency} onChange={(e) => set("currency", e.target.value.toUpperCase())} maxLength={3} />
              </div>
              <div>
                <Label>{t("superadminTenants.billing.grace", { defaultValue: "Gracia (días hábiles)" })}</Label>
                <Input className="mt-1" inputMode="numeric" value={form.grace_business_days} onChange={(e) => set("grace_business_days", e.target.value)} />
              </div>
              <div>
                <Label>{t("superadminTenants.billing.contact", { defaultValue: "Email de facturación" })}</Label>
                <Input className="mt-1" type="email" value={form.billing_contact_email} onChange={(e) => set("billing_contact_email", e.target.value)} />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{t("superadminTenants.billing.autoSuspend", { defaultValue: "Auto-suspender al vencer" })}</p>
                <p className="text-xs text-muted-foreground">
                  {t("superadminTenants.billing.autoSuspendHint", {
                    defaultValue: "Si se activa, el cron suspende la institución al pasar la gracia en días hábiles.",
                  })}
                </p>
              </div>
              <Switch checked={form.auto_suspend} onCheckedChange={(v) => set("auto_suspend", v)} />
            </div>

            <Button variant="outline" size="sm" onClick={renew} className="w-full">
              <RotateCcw className="h-4 w-4 mr-1" />
              {t("superadminTenants.billing.renew", { defaultValue: "Renovar +1 ciclo" })}
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {t("common.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button onClick={() => void save()} disabled={saving || loading}>
            {saving && <Spinner size="sm" className="mr-1" />}
            {t("common.save", { defaultValue: "Guardar" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

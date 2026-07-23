/**
 * TenantBillingBanner — aviso al Admin de una institución cuando su suscripción
 * está por vencer, en gracia (past_due) o suspendida. Se alimenta del RPC
 * `my_tenant_billing()` (SECURITY DEFINER, sin campos sensibles — no expone
 * monto ni notas). Solo-lectura: el Admin no edita nada comercial (eso es
 * SA-only). Se monta en AppLayout para el rol Admin.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle } from "lucide-react";
import { formatDateOnly } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Billing {
  subscription_status: string;
  plan_tier: string;
  billing_end: string | null;
  days_left: number | null;
}

export function TenantBillingBanner() {
  const { t } = useTranslation();
  const [b, setB] = useState<Billing | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await db.rpc("my_tenant_billing");
        if (cancelled) return;
        setB(((data ?? [])[0] as Billing) ?? null);
      } catch {
        /* migración no publicada / sin tenant → sin banner */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!b) return null;
  const s = b.subscription_status;
  const soon = b.days_left != null && b.days_left >= 0 && b.days_left <= 7;
  const critical = s === "suspended" || s === "expired";
  const warn = s === "past_due" || soon;
  if (!critical && !warn) return null;

  const cls = critical
    ? "border-destructive/50 bg-destructive/10 text-destructive"
    : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  const msg = critical
    ? t("billingBanner.suspended", {
        defaultValue: "Tu suscripción está suspendida. Contacta a tu proveedor para reactivarla.",
      })
    : s === "past_due"
      ? b.billing_end
        ? t("billingBanner.pastDue", {
            date: formatDateOnly(b.billing_end),
            defaultValue: "Tu suscripción venció el {{date}}. Regularízala para no perder el acceso.",
          })
        : t("billingBanner.pastDueNoDate", {
            defaultValue: "Tu suscripción venció. Regularízala para no perder el acceso.",
          })
      : t("billingBanner.soon", {
          count: b.days_left ?? 0,
          defaultValue: "Tu suscripción vence en {{count}} días. Contacta a tu proveedor.",
        });

  return (
    <div className={`sticky top-14 md:top-0 z-30 flex items-center gap-2 border-b px-4 py-2 text-sm ${cls}`}>
      <AlertTriangle className="h-4 w-4 shrink-0" />
      <span className="min-w-0">{msg}</span>
    </div>
  );
}

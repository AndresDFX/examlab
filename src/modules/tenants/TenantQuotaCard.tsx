/**
 * TenantQuotaCard — widget reusable que muestra "X / Y" de licencias
 * por rol del tenant activo. Carga `tenant_user_counts` RPC + lee los
 * límites del `useTenant()`.
 *
 * Se monta:
 *   - Configuración → Institución → "Mi institución" (sigue ahí inline).
 *   - app.admin.users (encima del grid) para que el Admin vea cuántas
 *     licencias le quedan ANTES de crear un usuario nuevo.
 *
 * Reusa el Card + grid del design system. Cada tile (rol) muestra:
 *   - Label
 *   - "X / Y" con tabular-nums; "∞" cuando Y es null (ilimitado).
 *   - Barra horizontal de progreso (oculta si ilimitado).
 *   - Estado destructive cuando current >= max (cuota llena).
 *
 * El widget NO permite editar — los límites los configura el SuperAdmin.
 *
 * Gate de visibilidad (single source of truth, no en los callers):
 * cuando el caller es SuperAdmin con activeRole=SuperAdmin y SIN
 * override "ver como X" activo, retornamos null. El concepto de
 * "cuotas" es por-tenant; en modo cross-tenant del SuperAdmin no
 * aplica ("X / Y" de qué tenant?). Esto cierra el item #2 del audit
 * RBAC: antes el SuperAdmin veía las cuotas de su tenant default y
 * asumía que eran "globales", confundiendo el modo cross-tenant.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useTenant, readTenantOverride } from "@/modules/tenants/use-tenant";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { Spinner } from "@/components/ui/spinner";
import { Users as UsersIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Counts {
  admins: number;
  teachers: number;
  students: number;
}

interface TenantQuotaCardProps {
  /** Mostrar en variante compacta (1 fila horizontal) o card completo. */
  compact?: boolean;
  /** Título del Card. Default: t("tenantQuota.defaultTitle"). */
  title?: string;
}

export function TenantQuotaCard({
  compact = false,
  title,
}: TenantQuotaCardProps) {
  const { t } = useTranslation();
  const { tenant, loading: tenantLoading } = useTenant();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [loading, setLoading] = useState(true);

  // Gate de visibilidad — ver header del archivo. SuperAdmin operando
  // cross-tenant no debe ver cuotas (concepto por-tenant que no aplica
  // en su contexto). Si elige "Ver como X" desde /app/superadmin/tenants
  // el override se activa y las cuotas vuelven a mostrarse para ESE
  // tenant elegido. Calculado en cada render porque depende del state
  // de localStorage; es síncrono y barato.
  const isSuperAdminCrossTenant =
    roles.includes("SuperAdmin") && activeRole === "SuperAdmin" && readTenantOverride() === null;

  useEffect(() => {
    if (!tenant?.id || isSuperAdminCrossTenant) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      // Pasar el tenant resuelto por useTenant (respeta "Ver como X") para que el
      // numerador salga del MISMO tenant que el denominador (max_*). El RPC valida
      // que sea el propio tenant o SuperAdmin. Sin el arg usaría current_tenant_id()
      // (NULL para el SA en override) → mostraba "0 / N".
      const { data } = await db.rpc("tenant_user_counts", { _tenant_id: tenant.id });
      if (cancelled) return;
      const c = data as { admins?: number; teachers?: number; students?: number } | null;
      setCounts(
        c
          ? { admins: c.admins ?? 0, teachers: c.teachers ?? 0, students: c.students ?? 0 }
          : { admins: 0, teachers: 0, students: 0 },
      );
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tenant?.id, isSuperAdminCrossTenant]);

  // Gate: SuperAdmin cross-tenant no ve el card. Retornamos null en
  // lugar de un placeholder visible para no agregar ruido — el
  // SuperAdmin ya tiene su propio dashboard global con métricas
  // cross-tenant (SuperAdminDashboard).
  if (isSuperAdminCrossTenant) return null;

  if (tenantLoading || loading || !counts || !tenant) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground flex items-center gap-2">
          <Spinner size="sm" /> {t("tenantQuota.loading")}
        </CardContent>
      </Card>
    );
  }

  const tiles = (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <QuotaTile label={t("tenantQuota.labelAdmins")} current={counts.admins} max={tenant.max_admins} />
      <QuotaTile label={t("tenantQuota.labelTeachers")} current={counts.teachers} max={tenant.max_teachers} />
      <QuotaTile label={t("tenantQuota.labelStudents")} current={counts.students} max={tenant.max_students} />
    </div>
  );

  if (compact) {
    return (
      <Card>
        <CardContent className="p-3">{tiles}</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2">
          <UsersIcon className="h-4 w-4 text-indigo-500" />
          {title ?? t("tenantQuota.defaultTitle")}
        </CardTitle>
      </CardHeader>
      <CardContent>{tiles}</CardContent>
    </Card>
  );
}

/**
 * Celda interna "X / Y" con barra horizontal. Se exporta por si algún
 * caller necesita pintar un tile individual fuera del Card (raro).
 */
export function QuotaTile({
  label,
  current,
  max,
}: {
  label: string;
  current: number;
  max: number | null;
}) {
  const unlimited = max == null;
  const atLimit = !unlimited && current >= (max as number);
  const pct = unlimited
    ? 0
    : Math.min(100, Math.round((current / Math.max(1, max as number)) * 100));
  return (
    <div className="rounded-md border p-2 bg-background">
      <div className="text-[11px] text-muted-foreground truncate">{label}</div>
      <div
        className={`text-sm font-semibold tabular-nums mt-0.5 ${
          atLimit ? "text-destructive" : ""
        }`}
      >
        {current} / {unlimited ? "∞" : max}
      </div>
      {!unlimited && (
        <div className="h-1 mt-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className={`h-full transition-all ${atLimit ? "bg-destructive" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

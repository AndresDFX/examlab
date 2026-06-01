/**
 * TenantOverrideBanner — banner azul "Viendo como institución X"
 * cuando el SuperAdmin tiene `examlab_tenant_override` activo.
 *
 * El override vive en localStorage (no en URL — ver `TenantUrlGuard.tsx`
 * para historia). El banner se monta a nivel AppLayout y aparece
 * cuando:
 *   - El usuario tiene rol SuperAdmin.
 *   - `activeRole === "SuperAdmin"` (no cambió al role-switcher).
 *   - `readTenantOverride()` retorna un slug válido.
 *
 * Click en "Salir del modo institución" limpia el override y refresca
 * el hook `useTenant` via CustomEvent.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { readTenantOverride, setTenantOverride } from "./use-tenant";

interface TenantInfo {
  slug: string;
  name: string;
}

export function TenantOverrideBanner() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const [overrideSlug, setOverrideSlug] = useState<string | null>(() => readTenantOverride());
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);

  // Subscribe a cambios del override: setTenantOverride dispara
  // CustomEvent; storage event cubre cross-tab.
  useEffect(() => {
    const refresh = () => setOverrideSlug(readTenantOverride());
    window.addEventListener("examlab:tenant-override-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("examlab:tenant-override-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Resolver nombre del tenant para mostrarlo legible.
  useEffect(() => {
    if (!overrideSlug) {
      setTenantInfo(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("tenants")
        .select("slug, name")
        .eq("slug", overrideSlug)
        .maybeSingle();
      if (cancelled) return;
      if (!data) {
        // Slug inválido en localStorage (tenant renombrado/eliminado).
        // Limpiamos para que el banner desaparezca y la app vuelva al
        // tenant del profile.
        setTenantOverride(null);
        setOverrideSlug(null);
        setTenantInfo(null);
        return;
      }
      setTenantInfo(data as TenantInfo);
    })();
    return () => {
      cancelled = true;
    };
  }, [overrideSlug]);

  const isSuperAdmin = roles.includes("SuperAdmin");
  if (!isSuperAdmin) return null;
  if (activeRole !== "SuperAdmin") return null;
  if (!overrideSlug) return null;

  const handleExit = () => {
    setTenantOverride(null);
  };

  return (
    <div className="sticky top-0 z-50 bg-blue-600 text-white px-4 py-2 shadow-md flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 text-sm font-medium min-w-0">
        <Eye className="h-4 w-4 shrink-0" />
        <span className="truncate">
          {t("tenant.overrideBannerViewingAs")} <strong>{tenantInfo?.name ?? overrideSlug}</strong>
          <span className="hidden sm:inline text-blue-100 font-normal">
            {" — "}
            {t("tenant.overrideBannerHint")}
          </span>
        </span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={handleExit}
        className="shrink-0"
        title={t("tenant.overrideBannerExitTitle")}
      >
        <X className="h-3.5 w-3.5 mr-1" />
        {t("tenant.overrideBannerExit")}
      </Button>
    </div>
  );
}

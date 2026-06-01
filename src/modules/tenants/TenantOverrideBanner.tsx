/**
 * TenantOverrideBanner — banner sticky cuando el SuperAdmin está
 * viendo el app en el contexto de UN tenant específico (URL con
 * prefijo `/t/<slug>/...`).
 *
 * Recordatorio constante de que TODO lo que ve abajo está filtrado al
 * tenant en URL (no es vista cross-tenant). Sin esto, el SuperAdmin se
 * puede confundir pensando que ve datos globales.
 *
 * Diferencia clave vs ImpersonationBanner:
 *   - ImpersonationBanner: actúa como OTRO USUARIO (sesión reemplazada).
 *     Tono ámbar (alerta — privilege escalation visible).
 *   - TenantOverrideBanner: el SuperAdmin sigue siendo él, pero
 *     filtrando la vista a 1 institución. Tono azul (cambio de
 *     contexto, no de identidad).
 *
 * Auto-oculta cuando:
 *   - Usuario no es SuperAdmin.
 *   - `activeRole` no es SuperAdmin (cambió a Admin/Docente).
 *   - URL no tiene prefijo `/t/<slug>` (modo cross-tenant).
 *
 * Se monta a nivel AppLayout. NO depende de la ruta.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouterState } from "@tanstack/react-router";
import { Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { getTenantSlugFromUrl, hardNavigateToTenant } from "./url";

interface TenantInfo {
  slug: string;
  name: string;
}

export function TenantOverrideBanner() {
  const { t } = useTranslation();
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  // Suscribimos al pathname del router para re-evaluar el slug cuando
  // cambie la URL (raro — el slug usualmente es estable por sesión).
  const routerPathname = useRouterState({ select: (s) => s.location.pathname });
  const [overrideSlug, setOverrideSlug] = useState<string | null>(() => getTenantSlugFromUrl());
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);

  // Sincronizar el slug local con el de la URL ante cualquier cambio
  // de path. Necesario para popstate / soft navigations dentro del
  // mismo basepath.
  useEffect(() => {
    setOverrideSlug(getTenantSlugFromUrl());
  }, [routerPathname]);

  // Cargar nombre del tenant para mostrarlo legible.
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
        setTenantInfo(null);
        return;
      }
      setTenantInfo(data as TenantInfo);
    })();
    return () => {
      cancelled = true;
    };
  }, [overrideSlug]);

  // Gate de visibilidad: solo SuperAdmin con activeRole SuperAdmin y
  // slug en URL. Cualquier otro estado → no renderiza.
  const isSuperAdmin = roles.includes("SuperAdmin");
  if (!isSuperAdmin) return null;
  if (activeRole !== "SuperAdmin") return null;
  if (!overrideSlug) return null;

  const handleExit = () => {
    // Hard navigate sin prefijo → recarga + router re-init en modo
    // cross-tenant. Es la única forma de "salir" porque el URL es la
    // fuente de verdad.
    hardNavigateToTenant(null, "/app");
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

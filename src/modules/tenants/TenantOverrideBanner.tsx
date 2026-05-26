/**
 * TenantOverrideBanner — banner sticky cuando el SuperAdmin activó
 * "Ver como esta institución" desde /app/superadmin/tenants.
 *
 * Sirve como recordatorio constante de que TODO lo que ve abajo está
 * filtrado al tenant elegido (no es vista cross-tenant). Sin este
 * banner, el SuperAdmin podía olvidarse del override y confundirse
 * pensando que veía datos globales.
 *
 * Diferencia clave vs ImpersonationBanner:
 *   - ImpersonationBanner: el Admin actúa como OTRO USUARIO (sesión
 *     reemplazada). Tono ámbar (alerta — privilege escalation visible).
 *   - TenantOverrideBanner: el SuperAdmin sigue siendo él mismo, pero
 *     filtrando la vista a 1 institución. Tono azul (informativo —
 *     cambio de contexto, no de identidad).
 *
 * Auto-oculta cuando:
 *   - El usuario no es SuperAdmin (no tiene la opción).
 *   - El activeRole no es SuperAdmin (cambió a Admin/Docente, ya no
 *     aplica el concepto de override cross-tenant).
 *   - No hay override activo (localStorage limpio).
 *
 * Se monta a nivel AppLayout. NO depende de la ruta.
 */
import { useEffect, useState } from "react";
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
  const { roles } = useAuth();
  const activeRole = useActiveRole();
  const [overrideSlug, setOverrideSlug] = useState<string | null>(() => readTenantOverride());
  const [tenantInfo, setTenantInfo] = useState<TenantInfo | null>(null);

  // Subscribe a cambios del override (setTenantOverride dispara un
  // CustomEvent custom; storage event cubre cross-tab).
  useEffect(() => {
    const refresh = () => setOverrideSlug(readTenantOverride());
    window.addEventListener("examlab:tenant-override-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("examlab:tenant-override-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  // Cargar nombre del tenant overrideado para mostrarlo legible (el
  // slug solo no comunica suficiente).
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
      setTenantInfo((data as TenantInfo | null) ?? { slug: overrideSlug, name: overrideSlug });
    })();
    return () => {
      cancelled = true;
    };
  }, [overrideSlug]);

  // Gate de visibilidad: solo SuperAdmin con activeRole SuperAdmin y
  // override seteado. Cualquier otro estado → no renderiza.
  const isSuperAdmin = roles.includes("SuperAdmin");
  if (!isSuperAdmin) return null;
  if (activeRole !== "SuperAdmin") return null;
  if (!overrideSlug) return null;

  const handleExit = () => {
    setTenantOverride(null);
    // setTenantOverride dispara el event, el state local se actualiza
    // y el banner desmonta. No necesitamos recargar la página.
  };

  return (
    <div className="sticky top-0 z-50 bg-blue-600 text-white px-4 py-2 shadow-md flex items-center justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-2 text-sm font-medium min-w-0">
        <Eye className="h-4 w-4 shrink-0" />
        <span className="truncate">
          Viendo como institución <strong>{tenantInfo?.name ?? overrideSlug}</strong>
          <span className="hidden sm:inline text-blue-100 font-normal">
            {" "}
            — los datos están filtrados a este tenant.
          </span>
        </span>
      </div>
      <Button
        size="sm"
        variant="secondary"
        onClick={handleExit}
        className="shrink-0"
        title="Volver al modo cross-tenant del SuperAdmin"
      >
        <X className="h-3.5 w-3.5 mr-1" />
        Salir del modo institución
      </Button>
    </div>
  );
}

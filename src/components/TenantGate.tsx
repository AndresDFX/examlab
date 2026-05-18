/**
 * Gate de tenant que se monta arriba del Outlet en `__root.tsx`.
 *
 * Flow de resolución:
 *   1) Mount: llama `resolveTenant()` (subdomain → query param → localStorage)
 *   2) Si resolvió, aplica branding inmediato (CSS vars)
 *   3) Si NO resolvió pero el user se loguea, hace SELECT a `tenants`
 *      (la RLS RESTRICTIVE filtra al propio tenant del user, así trae 1)
 *      y aplica branding. Esto cubre el caso "usuario llega al dominio
 *      raíz sin slug en la URL"
 *   4) Si el tenant está SUSPENDED, muestra overlay bloqueante en lugar
 *      de la app
 *
 * IMPORTANTE: este componente NO bloquea el render mientras carga. La
 * resolución es fire-and-forget para no agregar latencia al boot. El
 * branding aparece progresivamente, lo cual es aceptable.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { resolveTenant, applyTenantBranding, type ResolvedTenant } from "@/lib/tenant";
import { AlertTriangle, Mail } from "lucide-react";

interface TenantGateProps {
  children: React.ReactNode;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export function TenantGate({ children }: TenantGateProps) {
  const [tenant, setTenant] = useState<ResolvedTenant | null>(null);

  // ── Paso 1: resolver pre-login desde slug (subdomain/query/localStorage)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const t = await resolveTenant();
      if (cancelled) return;
      setTenant(t);
      applyTenantBranding(t);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Paso 2: post-login — si no hay tenant resuelto pero el user se
  // loguea, hacer SELECT a tenants. La RLS RESTRICTIVE filtra al propio
  // tenant del user, así que devuelve 1 fila (o 0 si es Superadmin sin
  // tenant). Esto cubre el caso "usuario abrió examlab.com sin slug".
  useEffect(() => {
    let cancelled = false;
    const resolveFromAuth = async (uid: string | null) => {
      if (cancelled) return;
      if (!uid || tenant) return;
      const { data } = await db
        .from("tenants")
        .select("id, slug, name, status, logo_url, primary_color, secondary_color")
        .limit(1)
        .maybeSingle();
      if (cancelled || !data) return;
      const resolved = data as ResolvedTenant;
      setTenant(resolved);
      applyTenantBranding(resolved);
    };

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, sess) => {
      void resolveFromAuth(sess?.user?.id ?? null);
    });
    void supabase.auth.getSession().then(({ data: { session } }) => {
      void resolveFromAuth(session?.user?.id ?? null);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [tenant]);

  // Tenant suspendido → overlay bloqueante en lugar de la app
  if (tenant?.status === "suspended") {
    return <TenantSuspendedScreen tenant={tenant} />;
  }

  return <>{children}</>;
}

function TenantSuspendedScreen({ tenant }: { tenant: ResolvedTenant }) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-lg border bg-card p-6 space-y-4 text-center shadow-sm">
        <div className="mx-auto w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertTriangle className="h-8 w-8 text-destructive" />
        </div>
        <div>
          <h1 className="text-xl font-semibold">Instancia suspendida</h1>
          <p className="text-sm text-muted-foreground mt-1">
            <strong>{tenant.name}</strong> está temporalmente fuera de servicio.
          </p>
        </div>
        <div className="rounded border bg-muted/30 p-3 text-sm text-left">
          <p className="text-muted-foreground">
            Los usuarios de esta instancia no pueden ingresar mientras la cuenta esté suspendida.
            Si crees que es un error, contacta al administrador de tu institución o al equipo de
            soporte.
          </p>
        </div>
        <a
          href="mailto:soporte@examlab.io"
          className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
        >
          <Mail className="h-3.5 w-3.5" />
          soporte@examlab.io
        </a>
      </div>
    </div>
  );
}

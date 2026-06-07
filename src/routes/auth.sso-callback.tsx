/**
 * Ruta callback del flow SSO (Google / Microsoft).
 *
 * Supabase OAuth redirige aquí tras completar el login del proveedor.
 * El access_token llega como hash `#access_token=...` (implicit flow) o
 * como `?code=...` (PKCE flow — Supabase JS SDK lo intercambia solo).
 *
 * Aquí solo:
 *  1. Esperamos que `supabase.auth.getSession()` resuelva con la sesión
 *     creada por el SDK.
 *  2. Llamamos al edge `auth-sso-verify`: confirma que existe un profile
 *     pre-aprovisionado con el `institutional_email = user.email`. Si NO
 *     hay match, el edge YA borró el auth.user y nosotros cerramos sesión
 *     en el cliente, mostramos toast y volvemos a /auth.
 *  3. Si OK, redirigimos a /app (TenantUrlGuard se encarga del slug).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { GraduationCap, AlertTriangle } from "lucide-react";
import { logEvent } from "@/shared/lib/audit";

// El path "/auth/sso-callback" se agrega a FileRoutesByPath cuando
// vite-plugin-router regenera routeTree.gen.ts en build. El plugin
// no tolera la aserción `as never` en el literal — su parser estático
// no la reconoce y aborta la generación con "Crawling result not
// available" (rompía `bun build` en Publish). Path como string literal
// puro: el plugin lo detecta y crea la entry en FileRoutesByPath.
export const Route = createFileRoute("/auth/sso-callback")({
  head: () => ({
    meta: [{ title: "Iniciando sesión — ExamLab" }],
  }),
  component: SsoCallbackPage,
});

function SsoCallbackPage() {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // 1) Esperar a que la sesión esté disponible. Supabase JS SDK
        //    procesa el hash/code automáticamente al cargar la página,
        //    pero el getSession() inmediato puede ser null. Reintento
        //    breve con backoff.
        let session = null;
        for (let i = 0; i < 6 && !session; i++) {
          const { data } = await supabase.auth.getSession();
          session = data.session;
          if (!session) await new Promise((r) => setTimeout(r, 250));
          if (cancelled) return;
        }
        if (!session) {
          setError(
            t("auth.sso.noSession", {
              defaultValue:
                "No se pudo recuperar la sesión del proveedor. Vuelve a intentar.",
            }),
          );
          return;
        }

        // 2) Verificar contra el edge — si el email NO está pre-aprovisionado,
        //    el edge borra auth.user + nos manda { ok:false, reason:'not_provisioned' }.
        const { data: verifyData, error: verifyErr } = await supabase.functions.invoke(
          "auth-sso-verify",
          { body: {} },
        );
        if (cancelled) return;

        const result = verifyData as {
          ok: boolean;
          tenant_slug?: string | null;
          reason?: string;
          message?: string;
        } | null;

        if (verifyErr || !result?.ok) {
          // El edge ya borró el auth.user huérfano; acá cerramos la
          // sesión local para que el SDK no quede con tokens válidos
          // hacia un user inexistente.
          await supabase.auth.signOut();
          const msg =
            result?.message ??
            (result?.reason === "not_provisioned"
              ? t("auth.sso.notProvisioned", {
                  defaultValue:
                    "Tu cuenta no está registrada en la plataforma. Pídele a un administrador que te cree primero.",
                })
              : result?.reason === "duplicate_email"
                ? t("auth.sso.duplicateEmail", {
                    defaultValue:
                      "Tu correo ya tiene una cuenta con contraseña. Entra con tu contraseña o pídele a un admin que vincule el SSO.",
                  })
                : t("auth.sso.verifyError", {
                    defaultValue: "No se pudo verificar tu cuenta. Vuelve a intentar.",
                  }));
          setError(msg);
          // Auditar el intento rechazado para que el admin pueda detectar
          // si alguien intenta loguearse con un email no autorizado.
          void logEvent({
            action: "user.sso_rejected",
            category: "user",
            severity: "warning",
            entityType: "user",
            entityName: session.user.email ?? null,
            metadata: { reason: result?.reason ?? "unknown" },
          });
          return;
        }

        // 3) Match perfecto — auditar login OK y redirigir.
        void logEvent({
          action: "user.login_success",
          category: "user",
          severity: "info",
          entityType: "user",
          entityId: session.user.id,
          entityName: session.user.email ?? null,
          metadata: { method: "sso" },
        });
        toast.success(t("auth.welcome"));
        // Hard navigate (no client routing) — `useTenant` se rehidrata
        // en el reload con el `tenant_slug` resuelto en el edge. Si el
        // user es SuperAdmin sin tenant, /app maneja el caso.
        window.location.href = "/app";
      } catch (e) {
        if (cancelled) return;
        setError(
          (e as Error).message ||
            t("auth.sso.verifyError", {
              defaultValue: "No se pudo verificar tu cuenta. Vuelve a intentar.",
            }),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <Card className="w-full max-w-md shadow-sm">
        <CardContent className="p-4 sm:p-8 space-y-4 text-center">
          <div className="flex justify-center">
            <div className="h-11 w-11 rounded-xl bg-primary flex items-center justify-center">
              <GraduationCap className="h-6 w-6 text-primary-foreground" />
            </div>
          </div>
          {error ? (
            <>
              <div className="flex justify-center text-destructive">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <h1 className="text-lg font-semibold">
                {t("auth.sso.rejectedTitle", {
                  defaultValue: "No pudimos iniciar tu sesión",
                })}
              </h1>
              <p className="text-sm text-muted-foreground">{error}</p>
              <a
                href="/auth"
                className="inline-block text-sm text-primary hover:underline mt-2"
              >
                {t("auth.sso.backToLogin", {
                  defaultValue: "Volver al inicio de sesión",
                })}
              </a>
            </>
          ) : (
            <>
              <Spinner size="lg" className="mx-auto" />
              <h1 className="text-lg font-semibold">
                {t("auth.sso.verifying", { defaultValue: "Verificando tu cuenta…" })}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t("auth.sso.verifyingHint", {
                  defaultValue:
                    "Confirmamos que tu correo esté autorizado en la institución.",
                })}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

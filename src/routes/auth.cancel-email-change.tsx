/**
 * Cancel email change — destino del link de cancelación que va al
 * correo ANTERIOR cuando se solicita un cambio de email.
 *
 * Flow:
 *  1. Llega el correo de aviso al old_email con el link de cancel.
 *  2. Usuario click → aterriza acá con ?token=<cancel_token>.
 *  3. Frontend llama edge `cancel-email-change` con { cancelToken }.
 *  4. Edge marca cancelled_at; el cron de aplicación no procesará la fila.
 *  5. UI muestra confirmación al usuario.
 *
 * El click solo es la acción — no requiere autenticación ni
 * formulario; lo que da la legitimidad es haber recibido el correo
 * (el atacante no controla el old email).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { GraduationCap, ShieldCheck, AlertTriangle, ShieldAlert } from "lucide-react";

export const Route = createFileRoute("/auth/cancel-email-change")({
  head: () => ({
    meta: [
      { title: "Cancelar cambio de correo — ExamLab" },
      { name: "description", content: "Cancela un cambio de correo solicitado en tu cuenta" },
    ],
  }),
  component: CancelEmailChangePage,
});

type State =
  | { kind: "checking" }
  | { kind: "success"; alreadyCancelled: boolean }
  | { kind: "error"; code: string };

function CancelEmailChangePage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: "checking" });
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const cancelToken = params.get("token")?.trim() ?? "";
    if (!cancelToken) {
      setState({ kind: "error", code: "missing_token" });
      return;
    }
    void (async () => {
      const { data, error } = await supabase.functions.invoke("cancel-email-change", {
        body: { cancelToken },
      });
      const respError = (data as { error?: string } | null)?.error;
      if (error || respError) {
        const code = respError ?? error?.message ?? "unknown";
        setState({ kind: "error", code });
        return;
      }
      const alreadyCancelled = Boolean(
        (data as { alreadyCancelled?: boolean } | null)?.alreadyCancelled,
      );
      setState({ kind: "success", alreadyCancelled });
    })();
  }, []);

  const errorMessage = (code: string): string => {
    if (code === "already_applied") {
      return t("auth.cancelEmailChange.errorAlreadyApplied", {
        defaultValue:
          "El cambio de correo ya fue aplicado y no puede revertirse desde acá. Contacta a soporte si no reconoces esta acción.",
      });
    }
    if (code === "missing_token") {
      return t("auth.cancelEmailChange.errorMissingToken", {
        defaultValue: "El enlace no contiene el token de cancelación.",
      });
    }
    return t("auth.cancelEmailChange.errorGeneric", {
      defaultValue:
        "El enlace es inválido o expiró. Si crees que es un intento de toma de cuenta, cambia tu contraseña.",
    });
  };

  return (
    <div className="min-h-screen grid place-items-center bg-background p-6">
      <Card className="w-full max-w-md shadow-sm">
        <CardHeader>
          <div className="flex items-center gap-2 mb-2">
            <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
              <GraduationCap className="h-5 w-5 text-primary-foreground" />
            </div>
            <span className="font-semibold text-lg">ExamLab</span>
          </div>
          <CardTitle className="text-2xl flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            {t("auth.cancelEmailChange.title", { defaultValue: "Cancelar cambio de correo" })}
          </CardTitle>
          <CardDescription>
            {t("auth.cancelEmailChange.subtitle", {
              defaultValue: "Estamos procesando la cancelación del cambio solicitado.",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.kind === "checking" && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t("auth.cancelEmailChange.cancelling", {
                defaultValue: "Cancelando…",
              })}
            </div>
          )}

          {state.kind === "success" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-md border border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400 text-sm">
                <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">
                    {state.alreadyCancelled
                      ? t("auth.cancelEmailChange.alreadyCancelledTitle", {
                          defaultValue: "Ya estaba cancelado",
                        })
                      : t("auth.cancelEmailChange.successTitle", {
                          defaultValue: "Cambio cancelado",
                        })}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {t("auth.cancelEmailChange.successBody", {
                      defaultValue:
                        "El correo de tu cuenta NO se cambiará. Tu acceso sigue funcionando con tu correo actual.",
                    })}
                  </p>
                </div>
              </div>
              <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
                <p className="font-medium text-amber-700 dark:text-amber-400 mb-1">
                  {t("auth.cancelEmailChange.securityHintTitle", {
                    defaultValue: "🛡️ Recomendación de seguridad",
                  })}
                </p>
                <p className="text-amber-700/90 dark:text-amber-400/90 text-xs leading-relaxed">
                  {t("auth.cancelEmailChange.securityHint", {
                    defaultValue:
                      "Si NO solicitaste este cambio, alguien pudo haber comprometido tu contraseña. Cámbiala ahora desde el login (¿olvidaste tu contraseña?).",
                  })}
                </p>
              </div>
              <Link to="/auth" className="block">
                <Button className="w-full">
                  {t("auth.cancelEmailChange.goToLogin", {
                    defaultValue: "Ir al inicio de sesión",
                  })}
                </Button>
              </Link>
            </div>
          )}

          {state.kind === "error" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-md border border-destructive/40 bg-destructive/5 text-destructive text-sm">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>{errorMessage(state.code)}</p>
              </div>
              <Link to="/auth" className="block">
                <Button variant="outline" className="w-full">
                  {t("auth.cancelEmailChange.backToLogin", {
                    defaultValue: "Volver a iniciar sesión",
                  })}
                </Button>
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

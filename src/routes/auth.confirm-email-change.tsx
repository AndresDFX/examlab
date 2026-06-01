/**
 * Confirm email change — destino del link que llega al correo del
 * usuario tras solicitar un cambio de email desde el perfil. FLOW
 * CUSTOM (sin Supabase Auth email confirmation).
 *
 * Flujo:
 *  1. Usuario en EditProfileDialog cambia su email institucional →
 *     frontend llama edge `request-email-change` con { newEmail }.
 *  2. Edge function genera token (32 bytes URL-safe, válido 1h) en
 *     `email_change_tokens` + inserta notif → pipeline send-email manda
 *     correo con link a `/auth/confirm-email-change?token=<token>`.
 *  3. Usuario click en el link → aterriza acá. Auto-confirma el token
 *     (sin formulario adicional — el solo hecho de abrir el link es
 *     la confirmación).
 *  4. Frontend llama edge `confirm-email-change` con { token }.
 *  5. Edge actualiza auth.users.email + profiles.institutional_email
 *     usando service_role + email_confirm:true (suprime el correo
 *     nativo de Supabase Auth).
 *  6. UI muestra success → CTA "Volver a iniciar sesión" (el JWT viejo
 *     ya está atado al email anterior; el usuario debe re-login).
 *
 * Edge cases:
 *  - Sin token en URL → estado "invalid" inmediato.
 *  - Token expirado / usado / inválido → mensaje genérico.
 *  - Email ya tomado por otro user en el ínterin → mensaje específico.
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { GraduationCap, Mail, AlertTriangle, CheckCircle2 } from "lucide-react";
import { formatDateTime } from "@/shared/lib/format";

export const Route = createFileRoute("/auth/confirm-email-change")({
  head: () => ({
    meta: [
      { title: "Confirmar cambio de correo — ExamLab" },
      { name: "description", content: "Confirma el cambio de correo de tu cuenta" },
    ],
  }),
  component: ConfirmEmailChangePage,
});

type State =
  | { kind: "checking" }
  | { kind: "success"; newEmail: string; applyAfter: string | null }
  | { kind: "error"; code: string };

function ConfirmEmailChangePage() {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ kind: "checking" });
  // StrictMode en dev monta el effect dos veces; el guard evita
  // consumir el token dos veces (la segunda llamada vería token_invalid).
  const consumedRef = useRef(false);

  useEffect(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    const params = new URLSearchParams(window.location.search);
    const token = params.get("token")?.trim() ?? "";
    if (!token) {
      setState({ kind: "error", code: "missing_token" });
      return;
    }
    void (async () => {
      const { data, error } = await supabase.functions.invoke("confirm-email-change", {
        body: { token },
      });
      const respError = (data as { error?: string } | null)?.error;
      if (error || respError) {
        const code = respError ?? error?.message ?? "unknown";
        setState({ kind: "error", code });
        return;
      }
      const newEmail = (data as { newEmail?: string } | null)?.newEmail ?? "";
      const applyAfter = (data as { applyAfter?: string } | null)?.applyAfter ?? null;
      setState({ kind: "success", newEmail, applyAfter });
    })();
  }, []);

  // Formatea la fecha de aplicación con el helper centralizado del
  // design system (locale es-CO hardcoded, evita inconsistencias por OS).
  const formatApplyAt = (iso: string): string => formatDateTime(iso, iso);

  // Mensaje legible por código de error. Genérico para no facilitar
  // enumeración (mismo mensaje para token_invalid / inexistente).
  const errorMessage = (code: string): string => {
    if (code === "token_expired") {
      return t("auth.confirmEmailChange.errorExpired", {
        defaultValue:
          "El enlace expiró (vigencia 1h). Vuelve a solicitar el cambio desde tu perfil.",
      });
    }
    if (code === "token_cancelled") {
      return t("auth.confirmEmailChange.errorCancelled", {
        defaultValue:
          "Este cambio fue cancelado desde el correo anterior. Si fuiste tú, solicita uno nuevo desde tu perfil.",
      });
    }
    if (code === "token_already_confirmed") {
      return t("auth.confirmEmailChange.errorAlreadyConfirmed", {
        defaultValue:
          "Este cambio ya fue confirmado. Espera a que se aplique (24h tras la confirmación) o cancela desde el correo anterior si no fuiste tú.",
      });
    }
    if (code === "email_already_taken") {
      return t("auth.confirmEmailChange.errorEmailTaken", {
        defaultValue:
          "El correo destino ya está en uso por otra cuenta. Solicita el cambio nuevamente con una dirección diferente.",
      });
    }
    if (code === "missing_token") {
      return t("auth.confirmEmailChange.errorMissingToken", {
        defaultValue:
          "El enlace no contiene el token de confirmación. Verifica que abriste el correo completo.",
      });
    }
    return t("auth.confirmEmailChange.errorGeneric", {
      defaultValue:
        "El enlace es inválido o ya fue utilizado. Pide uno nuevo desde tu perfil si aún necesitas cambiar el correo.",
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
            <Mail className="h-5 w-5 text-primary" />
            {t("auth.confirmEmailChange.title", { defaultValue: "Confirmar cambio de correo" })}
          </CardTitle>
          <CardDescription>
            {t("auth.confirmEmailChange.subtitle", {
              defaultValue: "Estamos validando tu enlace para actualizar el correo de tu cuenta.",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {state.kind === "checking" && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t("auth.confirmEmailChange.verifying", {
                defaultValue: "Confirmando el cambio…",
              })}
            </div>
          )}

          {state.kind === "success" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-md border border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400 text-sm">
                <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">
                    {t("auth.confirmEmailChange.pendingTitle", {
                      defaultValue: "Cambio confirmado — pendiente de aplicar",
                    })}
                  </p>
                  <p className="mt-1 text-muted-foreground">
                    {t("auth.confirmEmailChange.pendingBody", {
                      defaultValue:
                        "Tu nuevo correo quedará activo, por seguridad, 24 horas después de la confirmación:",
                    })}
                  </p>
                  <p className="mt-1 font-mono text-xs break-all text-foreground">
                    {state.newEmail}
                  </p>
                  {state.applyAfter && (
                    <p className="mt-2 text-xs">
                      <span className="text-muted-foreground">
                        {t("auth.confirmEmailChange.willApplyAt", {
                          defaultValue: "Se aplicará el:",
                        })}{" "}
                      </span>
                      <span className="font-semibold">{formatApplyAt(state.applyAfter)}</span>
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("auth.confirmEmailChange.cancelHint", {
                      defaultValue:
                        "Mientras tanto, tu correo actual sigue funcionando. Si recibís un correo de cancelación en tu correo anterior, ese link permite frenar el cambio.",
                    })}
                  </p>
                </div>
              </div>
              <Link to="/auth" className="block">
                <Button className="w-full">
                  {t("auth.confirmEmailChange.backToLoginCurrent", {
                    defaultValue: "Volver al inicio de sesión",
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
                  {t("auth.confirmEmailChange.backToLogin", {
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

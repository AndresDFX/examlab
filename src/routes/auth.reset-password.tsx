/**
 * Reset password — destino del link que llega al correo del usuario
 * tras pedir recuperación desde /auth. FLOW CUSTOM (sin Supabase Auth
 * recovery).
 *
 * Flujo:
 *  1. Usuario click "¿Olvidaste tu contraseña?" en /auth → modal pide email
 *  2. Frontend llama edge function `request-password-reset`
 *  3. Edge function genera token (32 bytes URL-safe, válido 1h) en
 *     `password_reset_tokens` + inserta notif → pipeline send-email
 *     manda correo con link a `/auth/reset-password?token=<token>`
 *  4. Usuario click en el link → aterriza acá. NO hay sesión Supabase;
 *     leemos el token del query string.
 *  5. Usuario escribe nueva password → frontend llama edge function
 *     `confirm-password-reset` con { token, password }
 *  6. Edge function valida token (existe, no usado, no expirado) y
 *     actualiza la password via auth.admin.updateUserById()
 *  7. Marca token usado + retorna ok → frontend redirige a /auth
 *     para que el usuario inicie sesión con la nueva password.
 *
 * Edge cases:
 *  - Sin token en la URL: estado "invalid" inmediato.
 *  - Token inválido / expirado / ya usado: error genérico (sin distinguir
 *    causas, para no ayudar a enumeración).
 *  - Passwords no coinciden: validación cliente.
 */
import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { GraduationCap, KeyRound, AlertTriangle, CheckCircle2, Eye, EyeOff } from "lucide-react";

export const Route = createFileRoute("/auth/reset-password")({
  head: () => ({
    meta: [
      { title: "Restablecer contraseña — ExamLab" },
      { name: "description", content: "Define una nueva contraseña" },
    ],
  }),
  component: ResetPasswordPage,
});

function ResetPasswordPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // Token desde el query string. Si no está, no podemos hacer nada.
  // sessionState ahora se llama tokenState, distingue:
  //   - "checking" — leyendo token de la URL
  //   - "ready" — tenemos token, mostrar form
  //   - "invalid" — sin token o token vacío (lo "real" lo valida el
  //     backend en confirm, acá solo chequeamos presencia)
  const [token, setToken] = useState<string | null>(null);
  const [tokenState, setTokenState] = useState<"checking" | "ready" | "invalid">("checking");

  useEffect(() => {
    // Token viene como query string ?token=... porque la edge function
    // construye el link así. NO usamos el hash de URL (eso era el flow
    // viejo de Supabase Auth).
    const params = new URLSearchParams(window.location.search);
    const t = params.get("token")?.trim() ?? "";
    if (!t) {
      setTokenState("invalid");
      return;
    }
    setToken(t);
    setTokenState("ready");
  }, []);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 8) {
      toast.error(t("auth.reset.passwordTooShort", { defaultValue: "Mínimo 8 caracteres" }));
      return;
    }
    if (password !== confirm) {
      toast.error(t("auth.reset.passwordsDontMatch", { defaultValue: "Las contraseñas no coinciden" }));
      return;
    }
    if (!token) return;
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("confirm-password-reset", {
      body: { token, password },
    });
    setLoading(false);
    // La edge devuelve 4xx con un {error} string en el body cuando el token es
    // inválido/expirado o la password es corta. functions.invoke NO parsea ese
    // body a `data` en respuestas non-2xx (data queda null) — expone el Response
    // crudo en error.context. Lo leemos para recuperar el código real; sin esto
    // `code` era el genérico "Edge Function returned a non-2xx status code" y los
    // branches token_invalid/token_expired quedaban muertos (nunca cambiaba a la
    // pantalla de enlace inválido).
    const respError = (data as { error?: string } | null)?.error;
    let code = respError ?? "";
    if (error && !code) {
      const ctx = (error as { context?: Response }).context;
      try {
        const bodyJson = ctx ? await ctx.clone().json() : null;
        code = (bodyJson as { error?: string } | null)?.error ?? "";
      } catch {
        /* body no-JSON */
      }
      if (!code) code = error.message ?? "";
    }
    if (error || code) {
      if (code === "token_invalid") {
        toast.error(
          t("auth.reset.tokenInvalid", {
            defaultValue: "Token inválido o ya usado. Solicita un nuevo enlace.",
          }),
        );
        setTokenState("invalid");
      } else if (code === "token_expired") {
        toast.error(
          t("auth.reset.tokenExpired", {
            defaultValue: "El enlace expiró (vigencia 1h). Solicita uno nuevo.",
          }),
        );
        setTokenState("invalid");
      } else if (code === "password_too_short") {
        toast.error(t("auth.reset.passwordTooShort", { defaultValue: "Mínimo 8 caracteres" }));
      } else {
        toast.error(
          code ||
            t("auth.reset.genericError", {
              defaultValue: "No se pudo restablecer la contraseña.",
            }),
        );
      }
      return;
    }
    toast.success(
      t("auth.reset.success", {
        defaultValue: "Contraseña actualizada. Inicia sesión con la nueva.",
      }),
    );
    navigate({ to: "/auth" });
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
            <KeyRound className="h-5 w-5 text-primary" />
            {t("auth.reset.title", { defaultValue: "Restablecer contraseña" })}
          </CardTitle>
          <CardDescription>
            {t("auth.reset.subtitle", {
              defaultValue: "Define una nueva contraseña para tu cuenta.",
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tokenState === "checking" && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t("auth.reset.verifying", { defaultValue: "Verificando el enlace…" })}
            </div>
          )}

          {tokenState === "invalid" && (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-md border border-destructive/40 bg-destructive/5 text-destructive text-sm">
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                <p>
                  {t("auth.reset.invalidLink", {
                    defaultValue:
                      "El enlace es inválido o ya expiró (vigencia 1h). Pide uno nuevo desde la pantalla de inicio de sesión.",
                  })}
                </p>
              </div>
              <Link to="/auth" className="block">
                <Button variant="outline" className="w-full">
                  {t("auth.reset.backToLogin", { defaultValue: "Volver a iniciar sesión" })}
                </Button>
              </Link>
            </div>
          )}

          {tokenState === "ready" && (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="rp-password" required>
                  {t("auth.reset.newPassword", { defaultValue: "Nueva contraseña" })}
                </Label>
                <div className="relative">
                  <Input
                    id="rp-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    autoFocus
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    aria-label={
                      showPassword
                        ? t("auth.hidePassword", { defaultValue: "Ocultar contraseña" })
                        : t("auth.showPassword", { defaultValue: "Mostrar contraseña" })
                    }
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("auth.reset.minChars", { defaultValue: "Mínimo 8 caracteres." })}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rp-confirm" required>
                  {t("auth.reset.confirmPassword", { defaultValue: "Confirmar contraseña" })}
                </Label>
                <div className="relative">
                  <Input
                    id="rp-confirm"
                    type={showConfirm ? "text" : "password"}
                    placeholder="••••••••"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    minLength={8}
                    className="pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm((v) => !v)}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
                    aria-label={
                      showConfirm
                        ? t("auth.hidePassword", { defaultValue: "Ocultar contraseña" })
                        : t("auth.showPassword", { defaultValue: "Mostrar contraseña" })
                    }
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? (
                  <Spinner size="sm" className="mr-2" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 mr-2" />
                )}
                {t("auth.reset.submit", { defaultValue: "Actualizar contraseña" })}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Reset password — destino del link que llega al correo del usuario
 * tras pedir recuperación desde /auth.
 *
 * Flujo Supabase Auth:
 *  1. Usuario hace click en "¿Olvidaste tu contraseña?" en /auth
 *  2. Modal pide email → llama supabase.auth.resetPasswordForEmail()
 *  3. Supabase envía correo con link tipo
 *     https://tudominio.com/auth/reset-password#access_token=...&type=recovery
 *  4. Usuario hace click → aterriza acá
 *  5. supabase-js detecta el hash y establece una sesión temporal
 *     de tipo "recovery". Esa sesión solo permite UPDATE de password.
 *  6. Usuario escribe nueva contraseña → updateUser({ password })
 *  7. Redirige a /app con sesión normal ya logueada.
 *
 * Edge cases:
 *  - Link expirado (>1h por default en Supabase): no hay sesión activa
 *    cuando llega, mostramos error + link a pedir uno nuevo.
 *  - Usuario ya logueado y entra sin link: tratamos como caso normal —
 *    le permitimos cambiar password (UX redundante con el "Cambiar
 *    contraseña" del menú, pero no es bug).
 *  - Contraseñas que no coinciden: validación cliente, no llega al API.
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
import { GraduationCap, KeyRound, AlertTriangle, CheckCircle2 } from "lucide-react";

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
  // sessionState distingue los 3 estados terminales del flujo:
  //   - "checking" — esperando a que supabase-js procese el hash de URL
  //   - "ready" — tenemos sesión válida, mostrar form de nueva password
  //   - "invalid" — sin sesión / link expirado, mostrar error
  const [sessionState, setSessionState] = useState<"checking" | "ready" | "invalid">("checking");

  useEffect(() => {
    // Pequeño delay para dar tiempo a supabase-js a procesar el hash
    // de URL (#access_token=...&type=recovery). El cliente lo hace
    // automático en onAuthStateChange — escuchamos ese evento.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        setSessionState("ready");
      } else if (session) {
        // El usuario ya tenía sesión activa (caso edge: entró acá sin
        // venir del correo). Lo dejamos cambiar password igual.
        setSessionState("ready");
      }
    });

    // Si pasaron 2s y no hay sesión válida, asumimos que el link expiró
    // o es inválido. Mostramos error.
    const timer = setTimeout(() => {
      supabase.auth.getSession().then(({ data }) => {
        setSessionState((prev) => (prev === "checking" ? (data.session ? "ready" : "invalid") : prev));
      });
    }, 2000);

    return () => {
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
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
    setLoading(true);
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      t("auth.reset.success", { defaultValue: "Contraseña actualizada. Bienvenido de vuelta." }),
    );
    navigate({ to: "/app" });
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
          {sessionState === "checking" && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Spinner size="sm" />
              {t("auth.reset.verifying", { defaultValue: "Verificando el enlace…" })}
            </div>
          )}

          {sessionState === "invalid" && (
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

          {sessionState === "ready" && (
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="rp-password" required>
                  {t("auth.reset.newPassword", { defaultValue: "Nueva contraseña" })}
                </Label>
                <Input
                  id="rp-password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                  autoFocus
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("auth.reset.minChars", { defaultValue: "Mínimo 8 caracteres." })}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rp-confirm" required>
                  {t("auth.reset.confirmPassword", { defaultValue: "Confirmar contraseña" })}
                </Label>
                <Input
                  id="rp-confirm"
                  type="password"
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  minLength={8}
                />
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

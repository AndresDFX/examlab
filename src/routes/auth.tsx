import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { toast } from "sonner";
import { GraduationCap, KeyRound, Mail } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Iniciar sesión — ExamLab" },
      { name: "description", content: "Accede a la plataforma de exámenes" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Estado del dialog "¿Olvidaste tu contraseña?". Pre-rellena el
  // campo email con lo que el usuario ya tipeó en el form de login,
  // así no tiene que escribirlo dos veces.
  const [forgotOpen, setForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const openForgot = () => {
    setForgotEmail(email);
    setForgotSent(false);
    setForgotOpen(true);
  };

  const onForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail.trim()) return;
    setForgotLoading(true);
    // redirectTo apunta a la ruta donde el usuario aterrizará tras
    // hacer click en el correo. Usamos window.location.origin para
    // que funcione en cualquier entorno (dev / staging / prod) sin
    // hardcodear. IMPORTANTE: esta URL debe estar en el allowlist de
    // Supabase → Auth → URL Configuration → Redirect URLs.
    const { error } = await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    });
    setForgotLoading(false);
    if (error) {
      // No leakeamos si la dirección existe o no — mensaje genérico
      // para no convertir esto en oracle de enumeración de usuarios.
      // Solo mostramos error si es un problema técnico (network, etc.).
      console.warn("[auth] resetPasswordForEmail", error);
    }
    // Siempre mostramos el mismo mensaje, exista o no la cuenta. Es
    // la postura estándar de seguridad: el usuario solo sabe "si
    // existe, te llegará un correo".
    setForgotSent(true);
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/app" });
    });
  }, [navigate]);

  const onLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (error) {
      // Auditoría de login fallido — RPC `log_failed_login` es SECURITY
      // DEFINER y acepta anon. Fire-and-forget; nunca bloquea la UI.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (supabase as any).rpc("log_failed_login", {
        p_email: email,
        p_reason: error.message,
      });
      toast.error(t("auth.invalidCredentials"));
      return;
    }
    toast.success(t("auth.welcome"));
    navigate({ to: "/app" });
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Brand panel */}
      <div className="hidden lg:flex flex-col justify-between bg-sidebar text-sidebar-foreground p-10">
        <div className="flex items-center gap-3">
          <div className="h-11 w-11 rounded-xl bg-sidebar-primary flex items-center justify-center">
            <GraduationCap className="h-6 w-6 text-sidebar-primary-foreground" />
          </div>
          <div>
            <div className="text-xl font-semibold">ExamLab</div>
            <div className="text-sm text-sidebar-foreground/60">{t("auth.brandSubtitle")}</div>
          </div>
        </div>
        <div className="space-y-6">
          <h1 className="text-4xl font-semibold tracking-tight leading-tight">
            {t("auth.brandTagline")}
          </h1>
          <ul className="space-y-3 text-sidebar-foreground/80">
            <li>• {t("auth.featureRoles")}</li>
            <li>• {t("auth.featureAssignment")}</li>
            <li>• {t("auth.featureProctoring")}</li>
            <li>• {t("auth.featureAI")}</li>
          </ul>
        </div>
        <div className="text-xs text-sidebar-foreground/50">© ExamLab 2026</div>
      </div>

      {/* Login panel */}
      <div className="flex items-center justify-center p-6">
        <Card className="w-full max-w-md shadow-sm">
          <CardHeader>
            <div className="flex items-center gap-2 mb-2 lg:hidden">
              <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center">
                <GraduationCap className="h-5 w-5 text-primary-foreground" />
              </div>
              <span className="font-semibold text-lg">ExamLab</span>
            </div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <CardTitle className="text-2xl">{t("auth.title")}</CardTitle>
                <CardDescription>{t("auth.instructions")}</CardDescription>
              </div>
              <LanguageSwitcher />
            </div>
          </CardHeader>
          <CardContent>
            <form onSubmit={onLogin} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="li-email" required>
                  {t("auth.institutionalEmail")}
                </Label>
                <Input
                  id="li-email"
                  type="email"
                  placeholder="usuario@institucion.edu"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="li-pass" required>
                    {t("auth.password")}
                  </Label>
                  {/* Link discreto a la derecha del label — patrón
                      estándar de login forms. Tipo button para que no
                      submitea el form del login. */}
                  <button
                    type="button"
                    onClick={openForgot}
                    className="text-xs text-primary hover:underline"
                  >
                    {t("auth.forgotPassword", { defaultValue: "¿Olvidaste tu contraseña?" })}
                  </button>
                </div>
                <Input
                  id="li-pass"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Spinner size="md" className="mr-2" />} {t("auth.submit")}
              </Button>
            </form>
            <p className="text-xs text-muted-foreground mt-4 text-center">
              {t("auth.contactAdmin")}
            </p>
            <div className="mt-4 text-center">
              <Link to="/" className="text-xs text-muted-foreground hover:text-foreground">
                {t("auth.backToHome")}
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Dialog "¿Olvidaste tu contraseña?". Tiene dos estados:
          - Inicial: form con email + botón "Enviar enlace"
          - Post-envío: mensaje genérico (sin leakear si la cuenta existe).
          El botón "Volver al login" cierra el dialog en ambos casos. */}
      <Dialog open={forgotOpen} onOpenChange={setForgotOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              {t("auth.forgot.title", { defaultValue: "Recuperar contraseña" })}
            </DialogTitle>
            <DialogDescription>
              {t("auth.forgot.subtitle", {
                defaultValue:
                  "Ingresa el correo de tu cuenta. Te enviaremos un enlace para definir una nueva contraseña.",
              })}
            </DialogDescription>
          </DialogHeader>

          {!forgotSent ? (
            <form onSubmit={onForgotSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="forgot-email" required>
                  {t("auth.institutionalEmail")}
                </Label>
                <Input
                  id="forgot-email"
                  type="email"
                  placeholder="usuario@institucion.edu"
                  value={forgotEmail}
                  onChange={(e) => setForgotEmail(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setForgotOpen(false)}
                  disabled={forgotLoading}
                >
                  {t("common.cancel")}
                </Button>
                <Button type="submit" disabled={forgotLoading || !forgotEmail.trim()}>
                  {forgotLoading ? (
                    <Spinner size="sm" className="mr-2" />
                  ) : (
                    <Mail className="h-4 w-4 mr-2" />
                  )}
                  {t("auth.forgot.send", { defaultValue: "Enviar enlace" })}
                </Button>
              </DialogFooter>
            </form>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-2 p-3 rounded-md border bg-muted/40 text-sm">
                <Mail className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                <p>
                  {t("auth.forgot.sent", {
                    defaultValue:
                      "Si esa dirección está registrada, recibirás un correo con el enlace de recuperación en los próximos minutos. Revisa también la carpeta de spam.",
                  })}
                </p>
              </div>
              <DialogFooter>
                <Button onClick={() => setForgotOpen(false)} className="w-full">
                  {t("common.close", { defaultValue: "Cerrar" })}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

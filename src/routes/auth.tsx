import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { toast } from "sonner";
import { GraduationCap } from "lucide-react";
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
                <Label htmlFor="li-pass" required>
                  {t("auth.password")}
                </Label>
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
    </div>
  );
}

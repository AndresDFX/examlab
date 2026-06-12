/**
 * Política de Privacidad — versión pública (pre-login).
 *
 * Ruta: /privacy. Accesible SIN autenticación, enlazada desde el footer de la
 * página de inicio de sesión y del landing. Reusa el documento compartido
 * `PrivacyPolicyContent` (la misma fuente que la versión in-app /app/privacy).
 */
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { GraduationCap, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PrivacyPolicyContent } from "@/modules/legal/PrivacyPolicyContent";

export const Route = createFileRoute("/privacy")({ component: PublicPrivacyPage });

function PublicPrivacyPage() {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <GraduationCap className="h-5 w-5 text-primary" />
            ExamLab
          </Link>
          <Button variant="ghost" size="sm" asChild>
            <Link to="/">
              <ArrowLeft className="mr-1 h-4 w-4" />
              {t("auth.backToHome", { defaultValue: "Volver al inicio" })}
            </Link>
          </Button>
        </div>
      </header>
      <main className="px-4 py-8">
        <PrivacyPolicyContent />
      </main>
    </div>
  );
}

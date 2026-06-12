/**
 * Política de Privacidad — versión in-app.
 *
 * Accesible a TODOS los roles autenticados: la regla fallback
 * `{ prefix: "/app", roles: null }` de rbac.ts ya lo permite sin regla
 * específica. Se llega desde el menú "más opciones" del sidebar (visible en
 * todos los roles). El documento vive en `PrivacyPolicyContent` (compartido
 * con la ruta pública `/privacy`).
 */
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { PrivacyPolicyContent } from "@/modules/legal/PrivacyPolicyContent";

export const Route = createFileRoute("/app/privacy")({ component: PrivacyPage });

function PrivacyPage() {
  const { t } = useTranslation();
  return (
    <div className="p-4 sm:p-8">
      <PageHeader
        backTo="/app"
        title={t("privacy.title", { defaultValue: "Política de Privacidad" })}
        icon={<ShieldCheck className="h-6 w-6 text-primary" />}
      />
      <Card>
        <CardContent className="p-4 sm:p-6">
          <PrivacyPolicyContent showHeader={false} />
        </CardContent>
      </Card>
    </div>
  );
}

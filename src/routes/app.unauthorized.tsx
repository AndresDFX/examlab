import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/app/unauthorized")({
  component: UnauthorizedPage,
});

function UnauthorizedPage() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <ShieldAlert className="text-destructive h-14 w-14" />
      <h1 className="text-2xl font-semibold">{t("common.unauthorized")}</h1>
      <p className="text-muted-foreground max-w-md text-sm">{t("common.unauthorizedBody")}</p>
      <Link to="/app">
        <Button>{t("common.goHome")}</Button>
      </Link>
    </div>
  );
}

import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/use-theme";
import { Button } from "@/components/ui/button";
import { Sun, Moon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function ThemeToggle({
  variant = "ghost",
  size = "sm",
}: {
  variant?: "ghost" | "outline";
  size?: "sm" | "icon";
}) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { t } = useTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} className="gap-1.5">
          {resolvedTheme === "dark" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
          <span className="sr-only">{t("nav.changeTheme", { defaultValue: "Cambiar tema" })}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")} className="gap-2">
          <Sun className="h-4 w-4" /> {t("nav.themeLight", { defaultValue: "Claro" })}
          {theme === "light" && <span className="ml-auto text-xs text-primary">✓</span>}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")} className="gap-2">
          <Moon className="h-4 w-4" /> {t("nav.themeDark", { defaultValue: "Oscuro" })}
          {theme === "dark" && <span className="ml-auto text-xs text-primary">✓</span>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

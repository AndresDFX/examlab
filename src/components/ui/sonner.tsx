import { useEffect, useState } from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

// Detecta el modo oscuro a partir de la clase `.dark` en <html>, igual que
// CodeEditor / DiagramEditor. Sin esto, Sonner asume tema "light" por
// defecto y, cuando la app está en dark, los toasts pintan con CSS vars
// de Sonner que terminan en negro sólido sobre texto blanco — nada que
// ver con el design system. Pasarle `theme` resuelve sus propias vars y
// además deja que `bg-background / text-foreground` (que ya seguimos)
// hagan el resto.
function useThemeMode(): "light" | "dark" {
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light",
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    const check = () =>
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    check();
    const obs = new MutationObserver(check);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

const Toaster = ({ ...props }: ToasterProps) => {
  const theme = useThemeMode();
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

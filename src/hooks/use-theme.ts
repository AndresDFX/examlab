import { useEffect, useState, useCallback } from "react";

type Theme = "light" | "dark";

const STORAGE_KEY = "examlab-theme";
// Evento custom para que TODAS las instancias del hook se enteren del
// cambio dentro de la misma pestaña. El evento 'storage' nativo SOLO
// dispara cross-tab — sin esto, cuando ThemeToggle cambiaba el tema,
// los componentes que también usaban useTheme() (TenantThemeProvider)
// no re-renderizaban y seguían aplicando overrides de CSS del tema
// viejo, dejando la UI a medio camino entre claro/oscuro.
const EVENT_NAME = "examlab:theme-changed";

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function readStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "light";
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "dark") return "dark";
  if (raw === "light") return "light";
  // Migra valores legacy ("system") y cualquier basura a claro — el
  // default actual de la app.
  return "light";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readStoredTheme);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t);
    // Notifica a otras instancias del hook montadas en la misma pestaña.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: t }));
    }
  }, []);

  // Aplica el theme al primer mount + sincroniza state desde localStorage
  // si otra instancia/pestaña ya lo cambió.
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Suscribe a cambios disparados por OTRAS instancias del hook
  // (custom event same-tab) o por OTRAS pestañas (storage event).
  useEffect(() => {
    const sync = () => {
      const next = readStoredTheme();
      setThemeState((prev) => (prev === next ? prev : next));
    };
    const onCustom = (e: Event) => {
      const t = (e as CustomEvent<Theme>).detail;
      if (t === "light" || t === "dark") {
        setThemeState((prev) => (prev === t ? prev : t));
      } else {
        sync();
      }
    };
    window.addEventListener(EVENT_NAME, onCustom);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT_NAME, onCustom);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return { theme, setTheme, resolvedTheme: theme };
}

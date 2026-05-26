import { useState, useEffect, useCallback } from "react";

type Theme = "light" | "dark";

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function readStoredTheme(): Theme {
  if (typeof localStorage === "undefined") return "light";
  const raw = localStorage.getItem("examlab-theme");
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
    localStorage.setItem("examlab-theme", t);
    applyTheme(t);
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme: theme };
}

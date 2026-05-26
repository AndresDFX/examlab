/**
 * active-role-signal — bridge entre `ActiveRoleContext` (que vive
 * dentro del AppLayout) y `TenantThemeProvider` (que vive en __root,
 * fuera de cualquier provider de rol).
 *
 * Por qué un signal y no Context:
 *   - TenantThemeProvider está en __root.tsx (envuelve el Outlet entero
 *     para que las páginas pre-login también puedan tener branding).
 *   - ActiveRoleContext vive DENTRO de AppLayout (lo necesita el sidebar
 *     para mostrar el rol activo, hacer RBAC, etc.).
 *   - Como TenantThemeProvider es padre de AppLayout, NO puede leer
 *     ActiveRoleContext con un hook. Necesita un canal lateral.
 *
 * Solución: módulo con estado en cliente + listeners. AppLayout escribe
 * (en un useEffect cuando activeRole cambia) y TenantThemeProvider lee
 * + se suscribe. Cuando el usuario cambia de rol via el Select del
 * sidebar, el signal dispara y TenantThemeProvider re-aplica/limpia el
 * branding inmediatamente.
 *
 * El estado vive en módulo (no localStorage) — el rol activo es
 * efímero a la sesión del tab, no algo que persista entre recargas.
 */
import type { AppRole } from "@/hooks/use-auth";

type ActiveRole = AppRole | null;

let currentRole: ActiveRole = null;
const listeners = new Set<(role: ActiveRole) => void>();

/** Escribe el rol activo y notifica a todos los suscriptores. No-op si
 *  el valor no cambió (evita re-renders inútiles). */
export function setActiveRoleSignal(role: ActiveRole): void {
  if (currentRole === role) return;
  currentRole = role;
  for (const l of listeners) l(role);
}

/** Lee el último valor publicado. Usado por el primer render del
 *  suscriptor antes de que llegue la primera notificación. */
export function getActiveRoleSignal(): ActiveRole {
  return currentRole;
}

/** Suscribe un listener. Devuelve función de cleanup. Patrón estándar
 *  para `useSyncExternalStore` o `useEffect` con cleanup. */
export function subscribeActiveRole(listener: (role: ActiveRole) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

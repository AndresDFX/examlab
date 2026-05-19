/**
 * ModuleGuard — wrap rutas que pertenezcan a un módulo toggle-able.
 *
 * Si el módulo está deshabilitado para el rol activo del usuario,
 * renderiza una pantalla "Módulo no disponible" en lugar de los hijos.
 * Esto cubre el caso de URL directa: el alumno que pegue la ruta en
 * el navegador NO puede saltarse el toggle navegando por sidebar.
 *
 * Reglas:
 *  - Mientras se carga `useAuth` o `useModuleVisibility`, mostramos el
 *    skeleton — NO bloqueamos prematuro (eso daría una flash de
 *    "deshabilitado" antes de saber el rol).
 *  - Si el usuario tiene MÚLTIPLES roles, basta con que UN rol activo
 *    tenga el módulo habilitado para mostrar la ruta. El "rol activo"
 *    en ExamLab es el que tiene seleccionado en el switcher
 *    (use-auth → `activeRole`). Fallback: si no hay activeRole, usamos
 *    el primer rol del array.
 *  - Admin SIEMPRE ve todo (override implícito) — ningún toggle bloquea
 *    a un Admin, así puede testear lo que oculta a otros roles.
 */
import { useAuth } from "@/hooks/use-auth";
import {
  isModuleEnabled,
  useModuleVisibility,
  type ModuleKey,
  type RoleKey,
} from "@/hooks/use-module-visibility";
import { PageLoader } from "@/components/ui/loaders";
import { Card, CardContent } from "@/components/ui/card";
import { Lock } from "lucide-react";

interface Props {
  module: ModuleKey;
  children: React.ReactNode;
}

export function ModuleGuard({ module, children }: Props) {
  const { user, roles } = useAuth();
  const { map, loading } = useModuleVisibility();

  // Mientras carga, no bloquear — evitamos flash de "deshabilitado".
  if (loading || !user) {
    return <PageLoader />;
  }

  // Admin SIEMPRE ve todo (override implícito) — útil para testear qué
  // se le oculta a Docente/Estudiante sin perder acceso uno mismo.
  if (roles?.includes("Admin")) return <>{children}</>;

  // Si el usuario tiene múltiples roles (raro pero posible),
  // basta con que UNO tenga el módulo habilitado para mostrar la ruta.
  const userRoles = (roles ?? []) as RoleKey[];
  const enabled = userRoles.some((r) => isModuleEnabled(map, module, r));

  if (enabled) return <>{children}</>;

  return (
    <div className="max-w-md mx-auto mt-12">
      <Card className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30">
        <CardContent className="p-6 space-y-3 text-center">
          <Lock className="h-10 w-10 text-amber-600 dark:text-amber-400 mx-auto" />
          <h2 className="text-lg font-semibold">Módulo no disponible</h2>
          <p className="text-sm text-muted-foreground">
            Tu administrador ha deshabilitado este módulo temporalmente. Si crees que es un error,
            comunícate con la administración de la plataforma.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

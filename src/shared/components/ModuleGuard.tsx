/**
 * ModuleGuard — wrap rutas que pertenezcan a un módulo toggle-able.
 *
 * Si el módulo está deshabilitado para el ROL ACTIVO del usuario,
 * renderiza una pantalla "Módulo no disponible" en lugar de los hijos.
 * Esto cubre el caso de URL directa: el alumno que pegue la ruta en
 * el navegador NO puede saltarse el toggle navegando por sidebar.
 *
 * Reglas:
 *  - Mientras se carga `useAuth` o `useModuleVisibility`, mostramos el
 *    skeleton — NO bloqueamos prematuro (eso daría una flash de
 *    "deshabilitado" antes de saber el rol).
 *  - Usamos el rol ACTIVO (selector del switcher), no el set completo
 *    de roles. Un Admin que está "actuando como Estudiante" desde el
 *    role-switcher debe respetar el toggle del Estudiante; si el módulo
 *    está apagado para Estudiante, ve "no disponible" aunque tenga rol
 *    Admin de fondo. Antes el guard hacía `roles.some(...)` que dejaba
 *    pasar al Admin siempre — eso convertía al panel de Módulos en
 *    "filtro visual de sidebar", no en "control de permisos".
 *  - Fallback: si por alguna razón no hay activeRole, caemos al primer
 *    rol del array. NUNCA bloqueamos cuando el rol es desconocido —
 *    preferimos "ver de más" a "trabar la app por config".
 *  - Sin bypass implícito de Admin: el Admin que apaga un módulo para
 *    sí mismo pierde acceso a la ruta. Vía de escape: `/app/admin/
 *    settings → Módulos` (esta página NO es togglable porque no aparece
 *    en la matriz de módulos), así puede volver a habilitarlo.
 */
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import {
  isModuleEnabled,
  useModuleVisibility,
  type ModuleKey,
  type RoleKey,
} from "@/hooks/use-module-visibility";
import { Link } from "@tanstack/react-router";
import { PageLoader } from "@/components/ui/loaders";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Lock, Settings } from "lucide-react";

interface Props {
  module: ModuleKey;
  children: React.ReactNode;
}

export function ModuleGuard({ module, children }: Props) {
  const { user, roles, loading: authLoading } = useAuth();
  const activeRole = useActiveRole();
  const { map, loading: modLoading } = useModuleVisibility();

  // Mientras carga (auth O módulos), no bloquear — evitamos flash de
  // "deshabilitado" cuando user ya se hidrató pero roles todavía es [].
  if (authLoading || modLoading || !user) {
    return <PageLoader />;
  }

  // Resolver el rol efectivo para esta ruta: el activo del switcher,
  // o el primero del array como fallback (cuenta con un solo rol).
  const effectiveRole: RoleKey | null =
    (activeRole as RoleKey | null | undefined) ?? ((roles ?? [])[0] as RoleKey | undefined) ?? null;

  // Sin rol resoluble → no bloquear. Loading edge case raro pero
  // preferimos no trabar.
  if (!effectiveRole) return <>{children}</>;

  const enabled = isModuleEnabled(map, module, effectiveRole);
  if (enabled) return <>{children}</>;

  // Solo Admin/SuperAdmin tienen acceso al panel donde reactivar — los
  // demás roles no pueden tocar la matriz, así que el CTA "Configurar"
  // solo aparece para ellos.
  const canFixToggle =
    roles?.includes("Admin") || roles?.includes("SuperAdmin");

  return (
    <div className="max-w-md mx-auto mt-12">
      <Card className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-500/5 dark:border-amber-500/30">
        <CardContent className="p-6 space-y-3 text-center">
          <Lock className="h-10 w-10 text-amber-600 dark:text-amber-400 mx-auto" />
          <h2 className="text-lg font-semibold">Módulo no disponible</h2>
          <p className="text-sm text-muted-foreground">
            Tu administrador ha deshabilitado este módulo para tu rol. Si crees que es un error,
            comunícate con la administración de la plataforma.
          </p>
          {canFixToggle && (
            <Button asChild variant="outline" size="sm">
              <Link to="/app/admin/settings" search={{ tab: "modules" } as never}>
                <Settings className="h-4 w-4 mr-2" />
                Reactivar desde Módulos
              </Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

import { createFileRoute, Outlet } from "@tanstack/react-router";
import { AppLayout } from "@/shared/components/AppLayout";
import { ModuleRouteGuard } from "@/shared/components/ModuleRouteGuard";

export const Route = createFileRoute("/app")({
  component: () => (
    <AppLayout>
      {/* Guard centralizado: mira el pathname y aplica ModuleGuard si
          la URL pertenece a un módulo toggle-able. Admin bypasea
          siempre — esto solo afecta Docente/Estudiante con módulo
          deshabilitado. */}
      <ModuleRouteGuard>
        <Outlet />
      </ModuleRouteGuard>
    </AppLayout>
  ),
});

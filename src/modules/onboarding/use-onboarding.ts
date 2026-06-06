/**
 * useOnboarding — hook que decide cuándo mostrar el tour guiado.
 *
 * Flujo:
 *   1. Espera a que profile + activeRole estén cargados.
 *   2. Si activeRole es SuperAdmin → no muestra nada (no hay tour).
 *   3. Si activeRole ya está en profile.onboarding_completed_roles → no
 *      muestra (ya lo vio).
 *   4. Si NO está en el array → after 1s delay marca `shouldShow=true`.
 *   5. Al completarlo (Skip o Finalizar) llama la RPC
 *      `mark_onboarding_complete(role)` y actualiza state local.
 *
 * El re-disparo manual (botón "Ver tour" del menú avatar) usa la
 * función `restart()` que abre el tour sin tocar la DB. El usuario
 * puede ver el tour cuantas veces quiera.
 */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { getActiveRoleSignal, subscribeActiveRole } from "@/modules/tenants/active-role-signal";

type TourableRole = "Admin" | "Docente" | "Estudiante";

function isTourableRole(role: string | null | undefined): role is TourableRole {
  return role === "Admin" || role === "Docente" || role === "Estudiante";
}

interface UseOnboardingResult {
  /** El rol activo que debería ver el tour AHORA. null = no mostrar. */
  shouldShowFor: TourableRole | null;
  /** Forzar mostrar el tour (botón "Ver tour"). Bypaseo el flag. */
  restart: (role: TourableRole) => void;
  /** Marca el tour como completado para un rol (Skip / Finalizar). */
  complete: (role: TourableRole) => Promise<void>;
  /** Cierra el tour SIN marcar como completado (solo en modo manual,
   *  ej. el usuario abre el tour por el botón y luego lo cierra). */
  dismiss: () => void;
}

export function useOnboarding(): UseOnboardingResult {
  const { profile, loading: authLoading } = useAuth();
  // activeRole viene del signal compartido (mismo que TenantThemeProvider
  // consume). Cuando AppLayout cambia el rol via su Select, el signal
  // dispara y reaccionamos inmediatamente sin necesidad de Context.
  const [activeRole, setActiveRole] = useState<string | null>(getActiveRoleSignal);
  const [shouldShowFor, setShouldShowFor] = useState<TourableRole | null>(null);
  // Tracking de los roles ya completados — sincronizado con DB pero
  // mantenemos copia local para no re-disparar el tour entre re-renders
  // antes de que el refetch del profile traiga el array actualizado.
  const [completedLocal, setCompletedLocal] = useState<Set<string>>(new Set());

  useEffect(() => {
    return subscribeActiveRole((r) => setActiveRole(r));
  }, []);

  // Inicializar completedLocal desde el profile cuando carga.
  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const completed = ((profile as any)?.onboarding_completed_roles ?? []) as string[];
    setCompletedLocal(new Set(completed));
  }, [profile]);

  // Decidir si mostrar el tour. Con 1s de delay para que el dashboard
  // renderice primero (evita parecer un popup intrusivo de entrada).
  useEffect(() => {
    if (authLoading) return;
    if (!profile) return;
    if (!isTourableRole(activeRole)) return;
    if (completedLocal.has(activeRole)) return;

    // Guard mobile: el sidebar desktop está oculto en <md, los nav
    // items NO tienen data-tour-module/data-tour-nav en el drawer, y
    // el drawer auto-cierra al cambiar pathname (rompe los anchors
    // entre steps con route). El tour saldría como 20-25 popovers
    // centrados sin sentido. Solo arrancamos en viewport desktop;
    // si el user rota a desktop después, el effect re-evalúa.
    if (typeof window !== "undefined" && window.innerWidth < 768) return;

    // Guard ForceChangePasswordDialog: si el user es Docente recién
    // creado con must_change_password=true, el dialog bloqueante se
    // monta encima de TODO (overlay no se cierra con Esc). El tour
    // arrancando en paralelo correría por debajo, ilegible. Esperamos
    // a que el user cambie la contraseña primero.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((profile as any)?.must_change_password) return;

    const timer = setTimeout(() => {
      setShouldShowFor(activeRole);
    }, 1000);
    return () => clearTimeout(timer);
  }, [authLoading, profile, activeRole, completedLocal]);

  // Registrar la PRIMERA vez que el tour se abre para este usuario.
  // Reacciona a CUALQUIER transición de `shouldShowFor` a non-null
  // (auto-trigger de primer login O `restart` manual). RPC idempotente:
  // si onboarding_first_seen_at ya está seteado, no hace nada.
  // Fire-and-forget; un fallo de red no bloquea la UX. Migración
  // 20260817000000 crea la columna + la RPC.
  useEffect(() => {
    if (shouldShowFor === null) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (supabase as any)
      .rpc("mark_onboarding_first_seen")
      .then(({ error }: { error: { message: string } | null }) => {
        if (error) {
          console.warn("[onboarding] mark_onboarding_first_seen failed", error);
        }
      });
  }, [shouldShowFor]);

  const complete = useCallback(async (role: TourableRole) => {
    // Optimista: actualizamos local primero para que la UI no parpadee
    // al cerrarse el tour (sin esto, si el RPC tarda, el effect podría
    // re-abrir el tour).
    setCompletedLocal((prev) => {
      const next = new Set(prev);
      next.add(role);
      return next;
    });
    setShouldShowFor(null);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("mark_onboarding_complete", {
        _role: role,
      });
      if (error) {
        console.warn("[onboarding] mark_onboarding_complete failed", error);
        // No revertimos el local — preferimos que el usuario no vuelva
        // a ver el tour aunque la DB no se haya actualizado. El próximo
        // login refetchea el profile y resincroniza.
      }
    } catch (e) {
      console.warn("[onboarding] mark_onboarding_complete threw", e);
    }
  }, []);

  const restart = useCallback((role: TourableRole) => {
    setShouldShowFor(role);
  }, []);

  const dismiss = useCallback(() => {
    setShouldShowFor(null);
  }, []);

  return { shouldShowFor, restart, complete, dismiss };
}

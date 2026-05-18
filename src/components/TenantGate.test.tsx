/**
 * Tests del TenantGate.
 *
 * El gate tiene 3 estados:
 *   1) Antes de resolver: pasa children (no bloquea)
 *   2) Tenant resuelto (active/trial/null): pasa children + aplica branding
 *   3) Tenant suspended: muestra TenantSuspendedScreen en lugar de children
 *
 * Mockeamos `resolveTenant` para controlar el escenario sin red.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mockResolve = vi.fn();
const mockApplyBranding = vi.fn();

vi.mock("@/lib/tenant", () => ({
  resolveTenant: () => mockResolve(),
  applyTenantBranding: (t: unknown) => mockApplyBranding(t),
}));

// Stub supabase para que el segundo useEffect (post-login) no toque idb-keyval
// ni dispare requests reales — solo nos interesa el flujo de branding aquí.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      onAuthStateChange: () => ({
        data: { subscription: { unsubscribe: () => {} } },
      }),
      getSession: () => Promise.resolve({ data: { session: null } }),
    },
    from: () => ({
      select: () => ({
        limit: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    }),
  },
}));

import { TenantGate } from "./TenantGate";

beforeEach(() => {
  mockResolve.mockReset();
  mockApplyBranding.mockReset();
});

afterEach(() => {
  document.documentElement.style.removeProperty("--tenant-primary");
  document.documentElement.style.removeProperty("--tenant-secondary");
});

describe("TenantGate", () => {
  it("renderiza children cuando no hay tenant detectado", async () => {
    mockResolve.mockResolvedValue(null);

    render(
      <TenantGate>
        <div data-testid="app-content">contenido normal</div>
      </TenantGate>,
    );

    // El children renderiza inmediatamente (sin esperar al resolveTenant)
    expect(screen.getByTestId("app-content")).toBeInTheDocument();

    // Espera a que el effect resuelva
    await waitFor(() => {
      expect(mockResolve).toHaveBeenCalled();
    });

    // applyBranding se llama con null (limpia vars)
    expect(mockApplyBranding).toHaveBeenCalledWith(null);
  });

  it("renderiza children y aplica branding cuando tenant.status='active'", async () => {
    const activeTenant = {
      id: "tenant-active",
      slug: "uni",
      name: "Universidad X",
      status: "active",
      logo_url: "https://example.com/logo.png",
      primary_color: "#ff0000",
      secondary_color: "#00ff00",
    };
    mockResolve.mockResolvedValue(activeTenant);

    render(
      <TenantGate>
        <div data-testid="app-content">contenido</div>
      </TenantGate>,
    );

    expect(screen.getByTestId("app-content")).toBeInTheDocument();

    await waitFor(() => {
      expect(mockApplyBranding).toHaveBeenCalledWith(activeTenant);
    });
  });

  it("renderiza TenantSuspendedScreen cuando tenant.status='suspended' y NO el children", async () => {
    const suspendedTenant = {
      id: "tenant-suspended",
      slug: "uni-old",
      name: "Universidad Suspendida",
      status: "suspended",
      logo_url: null,
      primary_color: null,
      secondary_color: null,
    };
    mockResolve.mockResolvedValue(suspendedTenant);

    render(
      <TenantGate>
        <div data-testid="app-content">contenido normal</div>
      </TenantGate>,
    );

    // Inicialmente children visible (antes del effect)
    expect(screen.getByTestId("app-content")).toBeInTheDocument();

    // Tras el effect: children desaparece, overlay aparece
    await waitFor(() => {
      expect(screen.queryByTestId("app-content")).not.toBeInTheDocument();
      expect(screen.getByText(/Instancia suspendida/i)).toBeInTheDocument();
      expect(screen.getByText(/Universidad Suspendida/i)).toBeInTheDocument();
    });
  });

  it("tenant 'trial' se considera activo (no bloquea)", async () => {
    mockResolve.mockResolvedValue({
      id: "t",
      slug: "trial",
      name: "Trial",
      status: "trial",
      logo_url: null,
      primary_color: null,
      secondary_color: null,
    });

    render(
      <TenantGate>
        <div data-testid="app-content">contenido</div>
      </TenantGate>,
    );

    await waitFor(() => {
      expect(mockResolve).toHaveBeenCalled();
    });

    // Trial NO bloquea — children sigue visible
    expect(screen.getByTestId("app-content")).toBeInTheDocument();
    expect(screen.queryByText(/suspendida/i)).not.toBeInTheDocument();
  });

  it("muestra email de soporte en la pantalla suspended", async () => {
    mockResolve.mockResolvedValue({
      id: "t",
      slug: "x",
      name: "X",
      status: "suspended",
      logo_url: null,
      primary_color: null,
      secondary_color: null,
    });

    render(
      <TenantGate>
        <div />
      </TenantGate>,
    );

    await waitFor(() => {
      const link = screen.getByText(/soporte@/i);
      expect(link.closest("a")?.getAttribute("href")).toMatch(/^mailto:/);
    });
  });
});

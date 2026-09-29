import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { PendienteSesion } from "./pendientes-sesion";

/**
 * La tarjeta del tablero: qué ve el estudiante, qué ve el docente, y cuándo NO
 * aparece. Los hooks de datos se sustituyen; la regla de agrupación
 * (`gruposDePendientes`) se deja REAL, que es lo que se quiere ejercitar.
 */
const estado = {
  habilitado: true,
  items: [] as PendienteSesion[],
  sesiones: [] as Array<{ id: string; session_date: string; start_time: string | null }>,
};

vi.mock("./use-pendientes-habilitados", () => ({
  usePendientesHabilitados: () => estado.habilitado,
}));

vi.mock("./use-pendientes-sesion", () => ({
  usePendientesDeSesiones: () => ({
    items: estado.items,
    cargando: false,
    error: null,
    recargar: vi.fn(),
    agregar: vi.fn(),
    agregarVarios: vi.fn(),
    alternar: vi.fn(async () => null),
    editar: vi.fn(),
    borrar: vi.fn(),
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: async () => ({ data: estado.sesiones, error: null }),
        }),
      }),
    }),
  },
}));

// «Hoy» fijo: la tarjeta lo toma de `todayLocalISO` después del montaje.
vi.mock("@/shared/lib/format", async () => {
  const real = await vi.importActual<typeof import("@/shared/lib/format")>("@/shared/lib/format");
  return { ...real, todayLocalISO: () => "2026-09-29" };
});

const { PendientesProximaSesionCard } = await import("./PendientesProximaSesionCard");

const item = (id: string, session_id: string, body: string): PendienteSesion => ({
  id,
  session_id,
  body,
  done_at: null,
  position: 0,
  created_at: "2026-09-22T20:00:00Z",
});

beforeEach(() => {
  estado.habilitado = true;
  estado.sesiones = [
    { id: "s3", session_date: "2026-09-22", start_time: "14:30:00" },
    { id: "s4", session_date: "2026-09-29", start_time: "14:30:00" },
    { id: "s5", session_date: "2026-10-06", start_time: "14:30:00" },
  ];
  estado.items = [
    item("a", "s3", "Traer el taller impreso"),
    item("b", "s4", "Leer el capítulo 3"),
  ];
});

describe("PendientesProximaSesionCard", () => {
  it("el estudiante ve lo de hoy y lo de la próxima, sin casillas", async () => {
    render(<PendientesProximaSesionCard courseId="c1" modo="estudiante" />);
    expect(await screen.findByText("Pendientes para la próxima sesión")).toBeInTheDocument();
    expect(screen.getByText("Traer el taller impreso")).toBeInTheDocument();
    expect(screen.getByText("Leer el capítulo 3")).toBeInTheDocument();
    expect(screen.getByText(/^Para hoy/)).toBeInTheDocument();
    expect(screen.getByText(/^Para la sesión del/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("el docente los puede tachar desde el tablero", async () => {
    render(<PendientesProximaSesionCard courseId="c1" modo="docente" />);
    await screen.findByText("Traer el taller impreso");
    expect(screen.getAllByRole("checkbox", { name: "Marcar como hecho" })).toHaveLength(2);
  });

  it("con la función apagada en la institución no se dibuja", async () => {
    estado.habilitado = false;
    const { container } = render(<PendientesProximaSesionCard courseId="c1" modo="estudiante" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("sin pendientes vigentes no hay tarjeta", async () => {
    estado.items = [item("viejo", "s3", "de hace tiempo")].map((x) => ({
      ...x,
      done_at: "2026-09-29T20:00:00Z",
    }));
    const { container } = render(<PendientesProximaSesionCard courseId="c1" modo="estudiante" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

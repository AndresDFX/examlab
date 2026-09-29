import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PendientesSesionDialog } from "./PendientesSesionDialog";
import type { PendienteSesion } from "./pendientes-sesion";
import type { PendientesDeSesiones } from "./use-pendientes-sesion";

/**
 * Lo que se fija acá es lo que ve el docente: en el diálogo de una sesión, lo
 * que le TOCA (de clases anteriores) y lo que anota para la siguiente, y que
 * tachar un pendiente no lo haga desaparecer bajo el cursor.
 */
const S3 = { id: "s3", session_date: "2026-09-22", start_time: "14:30:00" };
const S4 = { id: "s4", session_date: "2026-09-29", start_time: "14:30:00" };
const S5 = { id: "s5", session_date: "2026-10-06", start_time: "14:30:00" };
const SESIONES = [S3, S4, S5];

const item = (id: string, session_id: string, body: string, done_at: string | null = null): PendienteSesion => ({
  id,
  session_id,
  body,
  done_at,
  position: 0,
  created_at: "2026-09-22T20:00:00Z",
});

/** Un doble del hook con estado real, para ver el efecto de tachar. */
function Arnes({ inicial, session }: { inicial: PendienteSesion[]; session: typeof S4 | null }) {
  const [items, setItems] = useState(inicial);
  const pendientes: PendientesDeSesiones = {
    items,
    cargando: false,
    error: null,
    recargar: vi.fn(),
    agregar: async (sessionId, texto) => {
      setItems((prev) => [...prev, item(`n${prev.length}`, sessionId, texto)]);
      return null;
    },
    agregarVarios: async (sessionId, textos) => {
      setItems((prev) => [...prev, ...textos.map((x, i) => item(`m${prev.length + i}`, sessionId, x))]);
      return null;
    },
    alternar: async (p) => {
      setItems((prev) =>
        prev.map((x) => (x.id === p.id ? { ...x, done_at: x.done_at ? null : "2026-09-29T20:00:00Z" } : x)),
      );
      return null;
    },
    editar: async () => null,
    borrar: async (p) => {
      setItems((prev) => prev.filter((x) => x.id !== p.id));
      return null;
    },
  };
  return (
    <TooltipProvider>
      <PendientesSesionDialog
        session={session}
        sesiones={SESIONES}
        pendientes={pendientes}
        hoy="2026-09-29"
        onClose={() => {}}
      />
    </TooltipProvider>
  );
}

describe("PendientesSesionDialog", () => {
  it("muestra lo que quedó de la clase anterior y lo que se anota para la siguiente", () => {
    render(
      <Arnes
        session={S4}
        inicial={[item("a", "s3", "Retomar el ejemplo de JOINs"), item("b", "s4", "Recordar la entrega del taller")]}
      />,
    );
    expect(screen.getByText("Para esta sesión")).toBeInTheDocument();
    expect(screen.getByText("Retomar el ejemplo de JOINs")).toBeInTheDocument();
    // El mes lo formatea `formatDateShort` (es-CO); acá basta con el día.
    expect(screen.getByText(/De la sesión del 22/)).toBeInTheDocument();
    expect(screen.getByText("Para la próxima sesión")).toBeInTheDocument();
    expect(screen.getByText("Recordar la entrega del taller")).toBeInTheDocument();
    expect(screen.getByText(/hasta la sesión del 6/)).toBeInTheDocument();
  });

  it("sin nada pendiente de antes, no muestra la sección de arriba", () => {
    render(<Arnes session={S4} inicial={[]} />);
    expect(screen.queryByText("Para esta sesión")).not.toBeInTheDocument();
    expect(screen.getByText("Todavía no has anotado pendientes en esta sesión.")).toBeInTheDocument();
  });

  it("en la última sesión avisa que todavía no hay una siguiente", () => {
    render(<Arnes session={S5} inicial={[]} />);
    expect(screen.getByText(/Todavía no hay una sesión después de esta/)).toBeInTheDocument();
  });

  it("tachar un pendiente de antes lo deja visible, tachado, hasta cerrar", async () => {
    const user = userEvent.setup({ delay: null });
    render(<Arnes session={S4} inicial={[item("a", "s3", "Retomar el ejemplo de JOINs")]} />);
    await user.click(screen.getByRole("checkbox", { name: "Marcar como hecho" }));
    const texto = screen.getByText("Retomar el ejemplo de JOINs");
    expect(texto).toBeInTheDocument();
    expect(texto).toHaveClass("line-through");
  });

  it("agregar un pendiente lo suma a la lista de la próxima sesión", async () => {
    const user = userEvent.setup({ delay: null });
    render(<Arnes session={S4} inicial={[]} />);
    await user.type(screen.getByRole("textbox", { name: /Ej\.: traer/ }), "Traer el caso de estudio");
    await user.click(screen.getByRole("button", { name: "Agregar" }));
    expect(screen.getByText("Traer el caso de estudio")).toBeInTheDocument();
  });

  it("el botón de agregar no se habilita con el campo vacío", () => {
    render(<Arnes session={S4} inicial={[]} />);
    expect(screen.getByRole("button", { name: "Agregar" })).toBeDisabled();
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileX } from "lucide-react";
import { EmptyState, TableEmpty } from "./empty-state";

describe("EmptyState", () => {
  it("renderiza el texto principal", () => {
    render(<EmptyState text="Sin datos" />);
    expect(screen.getByText("Sin datos")).toBeInTheDocument();
  });

  it("renderiza el hint cuando se pasa", () => {
    render(<EmptyState text="Sin exámenes" hint="Crea uno para empezar" />);
    expect(screen.getByText("Crea uno para empezar")).toBeInTheDocument();
  });

  it("no renderiza hint cuando no se pasa", () => {
    render(<EmptyState text="Sin datos" />);
    expect(screen.queryByText("Crea uno para empezar")).not.toBeInTheDocument();
  });

  it("renderiza icono cuando se pasa", () => {
    const { container } = render(<EmptyState text="Sin datos" icon={FileX} />);
    // El icono se renderiza como un svg dentro del wrapper redondo
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("renderiza action (CTA) cuando se pasa", () => {
    render(<EmptyState text="Sin datos" action={<button>Crear primero</button>} />);
    expect(screen.getByRole("button", { name: "Crear primero" })).toBeInTheDocument();
  });

  it("acepta className extra", () => {
    const { container } = render(<EmptyState text="Sin datos" className="bg-red-50" />);
    expect((container.firstChild as HTMLElement).className).toMatch(/bg-red-50/);
  });
});

describe("TableEmpty", () => {
  it("renderiza dentro de un <tr> con colSpan", () => {
    render(
      <table>
        <tbody>
          <TableEmpty colSpan={5} text="Sin filas" />
        </tbody>
      </table>,
    );
    const cell = screen.getByText("Sin filas").closest("td");
    expect(cell).toHaveAttribute("colspan", "5");
  });

  it("renderiza hint", () => {
    render(
      <table>
        <tbody>
          <TableEmpty colSpan={3} text="Sin filas" hint="Importa CSV o crea uno" />
        </tbody>
      </table>,
    );
    expect(screen.getByText("Importa CSV o crea uno")).toBeInTheDocument();
  });

  it("renderiza action", () => {
    render(
      <table>
        <tbody>
          <TableEmpty colSpan={3} text="Sin filas" action={<button>Crear</button>} />
        </tbody>
      </table>,
    );
    expect(screen.getByRole("button", { name: "Crear" })).toBeInTheDocument();
  });
});

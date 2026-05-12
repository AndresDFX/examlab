import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DateCell } from "./date-cell";

describe("DateCell — fallbacks", () => {
  it("muestra '—' cuando value es null", () => {
    render(<DateCell value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("muestra '—' cuando value es undefined", () => {
    render(<DateCell value={undefined} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("muestra '—' cuando value es string vacío", () => {
    render(<DateCell value="" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("respeta fallback custom", () => {
    render(<DateCell value={null} fallback="N/A" />);
    expect(screen.getByText("N/A")).toBeInTheDocument();
  });
});

describe("DateCell — variant=auto", () => {
  it("'YYYY-MM-DD' usa formatDateOnly (sin descontar dia por UTC)", () => {
    // Punto critico: el bug del UTC -1 día se manifiesta acá. Con auto
    // detectamos el formato date-only y anclamos a 12:00 local.
    render(<DateCell value="2026-09-30" />);
    expect(screen.getByText(/30.*sep.*2026/i)).toBeInTheDocument();
  });

  it("ISO con hora usa formatDateTime", () => {
    render(<DateCell value="2026-09-30T14:30:00" />);
    expect(screen.getByText(/30.*sep.*2026.*14:30/i)).toBeInTheDocument();
  });
});

describe("DateCell — variant explicit", () => {
  it("variant=date solo muestra fecha", () => {
    render(<DateCell value="2026-09-30T14:30:00" variant="date" />);
    expect(screen.getByText(/30/)).toBeInTheDocument();
    // No debería incluir hora
    expect(screen.queryByText(/14:30/)).not.toBeInTheDocument();
  });

  it("variant=datetime muestra fecha + hora", () => {
    render(<DateCell value="2026-09-30T14:30:00" variant="datetime" />);
    expect(screen.getByText(/14:30/)).toBeInTheDocument();
  });

  it("variant=short omite el año", () => {
    render(<DateCell value="2026-09-30T12:00:00" variant="short" />);
    const el = screen.getByText(/30/);
    expect(el).toBeInTheDocument();
    // Short no debe incluir 2026
    expect(el.textContent).not.toMatch(/2026/);
  });
});

describe("DateCell — withIcon", () => {
  it("muestra icono cuando withIcon=true", () => {
    const { container } = render(<DateCell value="2026-09-30" withIcon />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("NO muestra icono por default", () => {
    const { container } = render(<DateCell value="2026-09-30" />);
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });
});

describe("DateCell — formato visual", () => {
  it("aplica tabular-nums + whitespace-nowrap (alineacion en grids)", () => {
    render(<DateCell value="2026-09-30" />);
    const el = screen.getByText(/30/);
    expect(el.className).toMatch(/tabular-nums/);
    expect(el.className).toMatch(/whitespace-nowrap/);
  });

  it("estado vacío usa text-muted (no tabular-nums)", () => {
    render(<DateCell value={null} />);
    const el = screen.getByText("—");
    expect(el.className).toMatch(/text-muted/);
  });

  it("acepta className extra", () => {
    render(<DateCell value="2026-09-30" className="font-bold" />);
    expect(screen.getByText(/30/).className).toMatch(/font-bold/);
  });
});

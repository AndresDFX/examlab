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
  it("aplica tabular-nums + truncate (anti-overflow en grids)", () => {
    // El cambio del 14-may-2026: pasamos de `whitespace-nowrap` a
    // `truncate` (que incluye overflow:hidden + text-overflow:ellipsis
    // + whitespace:nowrap). Con `<Table fixed>` esto evita que fechas
    // largas como "21 de may de 2026, 18:00" se desborden sobre la
    // celda siguiente.
    render(<DateCell value="2026-09-30" />);
    const el = screen.getByText(/30/);
    expect(el.className).toMatch(/tabular-nums/);
    expect(el.className).toMatch(/truncate/);
  });

  it("agrega title={text} para tooltip nativo al hacer hover", () => {
    // Tooltip nativo del browser cuando el texto se trunca por la
    // celda. Es el mecanismo que pidió el usuario para "ver el texto
    // completo al hacer hover sobre la columna o celda".
    render(<DateCell value="2026-09-30T14:30:00" variant="datetime" />);
    const el = screen.getByText(/14:30/);
    expect(el.getAttribute("title")).toBeTruthy();
    expect(el.getAttribute("title")).toMatch(/30/);
    expect(el.getAttribute("title")).toMatch(/14:30/);
  });

  it("withIcon usa flex + min-w-0 para que truncate funcione", () => {
    // Con ícono, el span externo es flex con min-w-0 (necesario para
    // que truncate funcione dentro de flex). El span interno tiene
    // truncate. El ícono shrink-0 nunca se trunca.
    const { container } = render(<DateCell value="2026-09-30" withIcon />);
    const wrapper = container.querySelector("span");
    expect(wrapper?.className).toMatch(/flex/);
    expect(wrapper?.className).toMatch(/min-w-0/);
    // El title también se aplica al wrapper externo (no al span del texto)
    expect(wrapper?.getAttribute("title")).toBeTruthy();
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

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Pencil, Trash2 } from "lucide-react";
import { RowAction } from "./row-action";

// RowAction usa <Tooltip> internamente — necesita un TooltipProvider
// ancestor. En la app vive en App.tsx; aqui lo proveemos directamente.
function withTooltip(ui: React.ReactNode) {
  return <TooltipProvider>{ui}</TooltipProvider>;
}

describe("RowAction — render", () => {
  it("muestra el ícono y respeta aria-label", () => {
    render(withTooltip(<RowAction label="Editar" icon={Pencil} />));
    const btn = screen.getByRole("button", { name: "Editar" });
    expect(btn).toBeInTheDocument();
    expect(btn.querySelector("svg")).toBeInTheDocument();
  });

  it("aplica clase destructive cuando tone='destructive'", () => {
    render(withTooltip(<RowAction label="Borrar" icon={Trash2} tone="destructive" />));
    const btn = screen.getByRole("button", { name: "Borrar" });
    expect(btn.className).toMatch(/text-destructive/);
  });

  it("NO aplica clase destructive cuando tone='default' (default)", () => {
    render(withTooltip(<RowAction label="Editar" icon={Pencil} />));
    const btn = screen.getByRole("button", { name: "Editar" });
    expect(btn.className).not.toMatch(/text-destructive/);
  });
});

describe("RowAction — interacción", () => {
  it("invoca onClick cuando se clickea", async () => {
    const onClick = vi.fn();
    render(withTooltip(<RowAction label="Editar" icon={Pencil} onClick={onClick} />));
    await userEvent.click(screen.getByRole("button", { name: "Editar" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("NO invoca onClick si está disabled", async () => {
    const onClick = vi.fn();
    render(withTooltip(<RowAction label="Editar" icon={Pencil} onClick={onClick} disabled />));
    const btn = screen.getByRole("button", { name: "Editar" });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("NO invoca onClick mientras está loading", async () => {
    const onClick = vi.fn();
    render(withTooltip(<RowAction label="Editar" icon={Pencil} onClick={onClick} loading />));
    const btn = screen.getByRole("button", { name: "Editar" });
    expect(btn).toBeDisabled();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("RowAction — loading", () => {
  it("muestra spinner en lugar del icono cuando loading=true", () => {
    render(withTooltip(<RowAction label="Procesando" icon={Pencil} loading />));
    // El spinner tiene role="status"
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});

describe("RowAction — type prop", () => {
  it("default type=button", () => {
    render(withTooltip(<RowAction label="Click" icon={Pencil} />));
    expect(screen.getByRole("button", { name: "Click" })).toHaveAttribute("type", "button");
  });

  it("acepta type='submit'", () => {
    render(withTooltip(<RowAction label="Enviar" icon={Pencil} type="submit" />));
    expect(screen.getByRole("button", { name: "Enviar" })).toHaveAttribute("type", "submit");
  });
});

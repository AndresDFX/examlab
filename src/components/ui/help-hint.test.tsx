import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { HelpHint } from "./help-hint";

describe("HelpHint", () => {
  it("renderiza un botón con aria-label 'Más información'", () => {
    render(<HelpHint>Explicación detallada</HelpHint>);
    expect(screen.getByRole("button", { name: "Más información" })).toBeInTheDocument();
  });

  it("renderiza un icono", () => {
    const { container } = render(<HelpHint>texto</HelpHint>);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("el botón tiene type='button' (no envia formularios)", () => {
    render(<HelpHint>texto</HelpHint>);
    expect(screen.getByRole("button", { name: "Más información" })).toHaveAttribute(
      "type",
      "button",
    );
  });

  it("self-contained: no requiere TooltipProvider externo", () => {
    // Si HelpHint fuera dependiente de un TooltipProvider ancestor,
    // este test fallaria con un error. HelpHint envuelve su propio
    // provider — confirmar que el render basico no rompe.
    expect(() =>
      render(<HelpHint>contenido</HelpHint>),
    ).not.toThrow();
  });

  it("acepta className extra", () => {
    render(<HelpHint className="custom-class">texto</HelpHint>);
    const btn = screen.getByRole("button", { name: "Más información" });
    expect(btn.className).toMatch(/custom-class/);
  });

  it("tabIndex=0 (focusable con teclado)", () => {
    render(<HelpHint>texto</HelpHint>);
    expect(screen.getByRole("button", { name: "Más información" })).toHaveAttribute(
      "tabindex",
      "0",
    );
  });
});

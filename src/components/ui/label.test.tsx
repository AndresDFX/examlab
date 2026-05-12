import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Label } from "./label";

describe("Label", () => {
  it("renderiza el texto children", () => {
    render(<Label>Nombre</Label>);
    expect(screen.getByText("Nombre")).toBeInTheDocument();
  });

  it("NO muestra asterisco cuando required no está presente", () => {
    render(<Label>Nombre</Label>);
    expect(screen.queryByText("*")).not.toBeInTheDocument();
  });

  it("muestra asterisco cuando required=true", () => {
    render(<Label required>Nombre</Label>);
    const asterisk = screen.getByText("*");
    expect(asterisk).toBeInTheDocument();
    // El asterisco es decoracion visual — aria-hidden para no
    // duplicar el anuncio del aria-required del control.
    expect(asterisk).toHaveAttribute("aria-hidden", "true");
  });

  it("asterisco con clase destructive (rojo)", () => {
    render(<Label required>Nombre</Label>);
    expect(screen.getByText("*").className).toMatch(/text-destructive/);
  });

  it("acepta className custom", () => {
    render(<Label className="text-lg">Custom</Label>);
    expect(screen.getByText("Custom").className).toMatch(/text-lg/);
  });

  it("pasa props al elemento label (htmlFor)", () => {
    render(<Label htmlFor="email-input">Email</Label>);
    expect(screen.getByText("Email").closest("label")).toHaveAttribute("for", "email-input");
  });
});

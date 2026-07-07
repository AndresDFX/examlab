import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import { Spinner } from "./spinner";

describe("Spinner", () => {
  it("renderiza con role status y label por defecto (common.loading)", () => {
    render(<Spinner />);
    const spinner = screen.getByRole("status");
    expect(spinner).toBeInTheDocument();
    // El default reusa la clave compartida common.loading. Derivamos el
    // valor esperado del MISMO i18n que usa el componente (misma clave +
    // defaultValue) en vez de hardcodear el literal: así el test no se
    // rompe si el texto del catálogo cambia (fue "Cargando", hoy
    // "Cargando…") ni depende de cómo el entorno cargue el catálogo — que
    // fue justo lo que puso el pipeline en rojo.
    expect(spinner).toHaveAttribute(
      "aria-label",
      i18n.t("common.loading", { defaultValue: "Cargando" }),
    );
  });

  it("respeta label custom", () => {
    render(<Spinner label="Procesando..." />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Procesando...");
  });

  it("aplica clase de tamaño según prop size", () => {
    const { rerender } = render(<Spinner size="xs" />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/h-3\b/);

    rerender(<Spinner size="sm" />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/h-3\.5/);

    rerender(<Spinner size="md" />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/h-4\b/);

    rerender(<Spinner size="lg" />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/h-5\b/);

    rerender(<Spinner size="xl" />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/h-6\b/);
  });

  it("tiene animate-spin siempre", () => {
    render(<Spinner />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/animate-spin/);
  });

  it("agrega 'inline' cuando inline=true", () => {
    render(<Spinner inline />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/\binline\b/);
  });

  it("acepta className extra", () => {
    render(<Spinner className="mr-2" />);
    expect(screen.getByRole("status").getAttribute("class")).toMatch(/mr-2/);
  });
});

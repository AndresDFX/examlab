import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SearchInput } from "./search-input";

describe("SearchInput — render", () => {
  it("renderea con placeholder default si no se pasa uno", () => {
    render(<SearchInput value="" onChange={() => {}} />);
    expect(screen.getByPlaceholderText("Buscar…")).toBeInTheDocument();
  });

  it("acepta placeholder custom", () => {
    render(<SearchInput value="" onChange={() => {}} placeholder="Buscar usuario…" />);
    expect(screen.getByPlaceholderText("Buscar usuario…")).toBeInTheDocument();
  });

  it("muestra el valor controlado", () => {
    render(<SearchInput value="andres" onChange={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("andres");
  });

  it("renderea el ícono de lupa", () => {
    const { container } = render(<SearchInput value="" onChange={() => {}} />);
    // El ícono es un SVG dentro del wrapper. lucide-react renderiza
    // <svg> con clases específicas.
    expect(container.querySelector("svg")).toBeInTheDocument();
  });
});

describe("SearchInput — interacción", () => {
  it("dispara onChange al tipear", () => {
    const onChange = vi.fn();
    render(<SearchInput value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("NO muestra botón 'Limpiar' cuando value está vacío", () => {
    render(<SearchInput value="" onChange={() => {}} />);
    expect(screen.queryByTitle("Limpiar")).not.toBeInTheDocument();
  });

  it("muestra botón 'Limpiar' cuando hay value", () => {
    render(<SearchInput value="test" onChange={() => {}} />);
    expect(screen.getByTitle("Limpiar")).toBeInTheDocument();
  });

  it("click en 'Limpiar' dispara onChange con string vacío", () => {
    const onChange = vi.fn();
    render(<SearchInput value="test" onChange={onChange} />);
    fireEvent.click(screen.getByTitle("Limpiar"));
    expect(onChange).toHaveBeenCalledWith("");
  });
});

describe("SearchInput — className personalizado", () => {
  it("acepta className en el wrapper", () => {
    const { container } = render(
      <SearchInput value="" onChange={() => {}} className="my-custom" />,
    );
    expect(container.querySelector(".my-custom")).toBeInTheDocument();
  });

  it("acepta maxWidthClass para customizar ancho", () => {
    const { container } = render(
      <SearchInput value="" onChange={() => {}} maxWidthClass="sm:max-w-md" />,
    );
    expect(container.querySelector(".sm\\:max-w-md")).toBeInTheDocument();
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusBadge } from "./status-badge";

describe("StatusBadge — labels", () => {
  it("muestra label traducido (statusLabel)", () => {
    render(<StatusBadge status="entregado" />);
    expect(screen.getByText("Entregado")).toBeInTheDocument();
  });

  it("status desconocido: fallback con primera letra mayuscula", () => {
    render(<StatusBadge status="foo_bar" />);
    expect(screen.getByText("Foo bar")).toBeInTheDocument();
  });

  it("null/undefined: muestra em-dash", () => {
    render(<StatusBadge status={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("StatusBadge — iconos", () => {
  it("'sospechoso' incluye icono de alerta", () => {
    const { container } = render(<StatusBadge status="sospechoso" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("'requiere_revision' incluye icono de alerta", () => {
    const { container } = render(<StatusBadge status="requiere_revision" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("'calificado' / 'completado' / 'entregado' incluyen check icon", () => {
    for (const status of ["calificado", "completado", "entregado"]) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.querySelector("svg")).toBeInTheDocument();
      unmount();
    }
  });

  it("'iniciado' / 'en_progreso' incluyen icono de reloj", () => {
    for (const status of ["iniciado", "en_progreso"]) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.querySelector("svg")).toBeInTheDocument();
      unmount();
    }
  });

  it("'ai_revisado' incluye icono", () => {
    const { container } = render(<StatusBadge status="ai_revisado" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("'chequeado' (sospechoso revisado) incluye icono shield", () => {
    const { container } = render(<StatusBadge status="chequeado" />);
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("estados neutros (draft, archived, pending) NO tienen icono", () => {
    for (const status of ["draft", "archived", "pending"]) {
      const { container, unmount } = render(<StatusBadge status={status} />);
      expect(container.querySelector("svg")).not.toBeInTheDocument();
      unmount();
    }
  });

  it("hideIcon=true oculta icono incluso en estados que lo tienen", () => {
    const { container } = render(<StatusBadge status="sospechoso" hideIcon />);
    expect(container.querySelector("svg")).not.toBeInTheDocument();
  });
});

describe("StatusBadge — className extra", () => {
  it("acepta className y lo combina", () => {
    render(<StatusBadge status="entregado" className="ml-2" />);
    const badge = screen.getByText("Entregado").closest('[class*="ml-2"]');
    expect(badge).toBeInTheDocument();
  });
});

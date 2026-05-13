import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TruncatedCell,
} from "./table";

// Helper para envolver tabla en estructura mínima válida.
function wrap(children: React.ReactNode) {
  return (
    <Table>
      <TableBody>
        <TableRow>{children}</TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table — prop fixed", () => {
  it("por defecto NO aplica table-fixed (compat con tablas existentes)", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const tableEl = container.querySelector("table");
    expect(tableEl).not.toBeNull();
    expect(tableEl!.className).not.toMatch(/table-fixed/);
  });

  it("con fixed aplica table-fixed", () => {
    const { container } = render(
      <Table fixed>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const tableEl = container.querySelector("table");
    expect(tableEl!.className).toMatch(/table-fixed/);
  });

  it("respeta className adicional", () => {
    const { container } = render(
      <Table className="my-custom-class" fixed>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const tableEl = container.querySelector("table");
    expect(tableEl!.className).toMatch(/my-custom-class/);
    expect(tableEl!.className).toMatch(/table-fixed/);
  });

  it("siempre envuelve en un wrapper con overflow-x-auto", () => {
    const { container } = render(
      <Table>
        <TableBody>
          <TableRow>
            <TableCell>x</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    const wrapper = container.querySelector("div");
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toMatch(/overflow-x-auto/);
  });
});

describe("TableCell — prop truncate", () => {
  it("por defecto renderiza children directamente (sin div truncate)", () => {
    const { container } = render(wrap(<TableCell>Hello world</TableCell>));
    const td = container.querySelector("td");
    expect(td!.textContent).toBe("Hello world");
    // No hay div interno con truncate
    expect(td!.querySelector("div.truncate")).toBeNull();
  });

  it("con truncate envuelve children en div con class truncate", () => {
    const { container } = render(wrap(<TableCell truncate>Hello world</TableCell>));
    const td = container.querySelector("td");
    const inner = td!.querySelector("div.truncate");
    expect(inner).not.toBeNull();
    expect(inner!.textContent).toBe("Hello world");
  });

  it("respeta className adicional", () => {
    const { container } = render(
      wrap(
        <TableCell className="font-medium" truncate>
          x
        </TableCell>,
      ),
    );
    const td = container.querySelector("td");
    expect(td!.className).toMatch(/font-medium/);
  });
});

describe("TableHead — prop truncate", () => {
  it("por defecto renderiza children directamente", () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Col largo</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const th = container.querySelector("th");
    expect(th!.textContent).toBe("Col largo");
    expect(th!.querySelector("div.truncate")).toBeNull();
  });

  it("con truncate envuelve en div con truncate", () => {
    const { container } = render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead truncate>Col largo</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const th = container.querySelector("th");
    const inner = th!.querySelector("div.truncate");
    expect(inner).not.toBeNull();
    expect(inner!.textContent).toBe("Col largo");
  });
});

describe("TruncatedCell", () => {
  it("siempre envuelve children en div con class truncate", () => {
    const { container } = render(wrap(<TruncatedCell>Hello</TruncatedCell>));
    const td = container.querySelector("td");
    const inner = td!.querySelector("div.truncate");
    expect(inner).not.toBeNull();
    expect(inner!.textContent).toBe("Hello");
  });

  it("aplica maxWidth como clase al div interno", () => {
    const { container } = render(
      wrap(
        <TruncatedCell maxWidth="max-w-[200px]">Hello</TruncatedCell>,
      ),
    );
    const div = container.querySelector("td div");
    expect(div!.className).toMatch(/truncate/);
    expect(div!.className).toMatch(/max-w-\[200px\]/);
  });

  it("infiere title del children cuando es string", () => {
    const { container } = render(wrap(<TruncatedCell>Hello mundo</TruncatedCell>));
    const td = container.querySelector("td");
    expect(td!.getAttribute("title")).toBe("Hello mundo");
  });

  it("respeta title explícito sobre el inferido", () => {
    const { container } = render(
      wrap(
        <TruncatedCell title="tooltip custom">
          <span>JSX interno</span>
        </TruncatedCell>,
      ),
    );
    const td = container.querySelector("td");
    expect(td!.getAttribute("title")).toBe("tooltip custom");
  });

  it("title undefined cuando children es JSX y no se da explícito", () => {
    const { container } = render(
      wrap(
        <TruncatedCell>
          <span>JSX</span>
        </TruncatedCell>,
      ),
    );
    const td = container.querySelector("td");
    // No tiene title attribute (o lo tiene vacío); usamos hasAttribute para verificar
    const titleAttr = td!.getAttribute("title");
    expect(titleAttr == null || titleAttr === "").toBe(true);
  });

  it("propaga className al td", () => {
    const { container } = render(
      wrap(
        <TruncatedCell className="text-right text-xs">x</TruncatedCell>,
      ),
    );
    const td = container.querySelector("td");
    expect(td!.className).toMatch(/text-right/);
    expect(td!.className).toMatch(/text-xs/);
  });
});

describe("Table — integración: fixed + truncate funcionan juntos", () => {
  it("la combinación renderiza la estructura esperada", () => {
    render(
      <Table fixed>
        <TableHeader>
          <TableRow>
            <TableHead truncate>Nombre muy largo del header</TableHead>
            <TableHead className="w-32">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TruncatedCell maxWidth="max-w-[200px]">
              Un texto super largo que debería truncar con ellipsis
            </TruncatedCell>
            <TableCell>OK</TableCell>
          </TableRow>
        </TableBody>
      </Table>,
    );
    // El texto largo está presente en el DOM (no se filtra)
    expect(
      screen.getByText("Un texto super largo que debería truncar con ellipsis"),
    ).toBeInTheDocument();
    // El header truncate también
    expect(screen.getByText("Nombre muy largo del header")).toBeInTheDocument();
  });
});

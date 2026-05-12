import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DecimalInput } from "./decimal-input";

// Wrapper que mantiene state externo igual que el padre real, para
// poder testar la sincronizacion value <-> text interno.
function Harness(props: {
  initialValue?: number | null;
  min?: number;
  max?: number;
  onChangeSpy?: (v: number | null) => void;
}) {
  const [v, setV] = useState<number | null | undefined>(props.initialValue ?? null);
  return (
    <DecimalInput
      aria-label="num"
      value={v}
      onChange={(next) => {
        setV(next);
        props.onChangeSpy?.(next);
      }}
      min={props.min}
      max={props.max}
    />
  );
}

describe("DecimalInput — display", () => {
  it("muestra valor inicial con coma", () => {
    render(<Harness initialValue={4.5} />);
    expect(screen.getByLabelText("num")).toHaveValue("4,5");
  });

  it("muestra vacio cuando value es null", () => {
    render(<Harness initialValue={null} />);
    expect(screen.getByLabelText("num")).toHaveValue("");
  });

  it("entero se muestra sin coma", () => {
    render(<Harness initialValue={30} />);
    expect(screen.getByLabelText("num")).toHaveValue("30");
  });
});

describe("DecimalInput — onChange con texto", () => {
  it("escribir dígitos llama onChange con number", async () => {
    const spy = vi.fn();
    render(<Harness onChangeSpy={spy} />);
    const input = screen.getByLabelText("num");
    await userEvent.type(input, "45");
    // El último onChange recibió el valor final 45
    expect(spy).toHaveBeenLastCalledWith(45);
  });

  it("escribir punto se convierte a coma automáticamente", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "4.5");
    // El display final debe tener coma
    expect(input.value).toBe("4,5");
  });

  it("escribir coma directamente queda como coma", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "3,7");
    expect(input.value).toBe("3,7");
  });

  it("bloquea 'e' (notación científica)", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "1e5");
    // 'e' bloqueado, queda "15"
    expect(input.value).toBe("15");
  });

  it("ignora caracteres no permitidos (letras)", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "1abc2");
    // Letras se ignoran (regex no permite); queda solo dígitos
    expect(input.value).toBe("12");
  });

  it("no permite mas de una coma", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "1,2,3");
    // La segunda coma se ignora
    expect(input.value).toBe("1,23");
  });

  it("permite signo negativo al inicio", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "-5");
    expect(input.value).toBe("-5");
  });
});

describe("DecimalInput — blur normaliza", () => {
  it("'4,' al blur queda '4' (parsea 4 → display sin coma)", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "4,");
    fireEvent.blur(input);
    expect(input.value).toBe("4");
  });

  it("recorta al min en blur", async () => {
    render(<Harness min={5} />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "2");
    fireEvent.blur(input);
    expect(input.value).toBe("5");
  });

  it("recorta al max en blur", async () => {
    render(<Harness max={10} />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    await userEvent.type(input, "99");
    fireEvent.blur(input);
    expect(input.value).toBe("10");
  });
});

describe("DecimalInput — atributos", () => {
  it("type='text' con inputMode='decimal'", () => {
    render(<Harness />);
    const input = screen.getByLabelText("num");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "decimal");
  });

  it("placeholder default '0,00'", () => {
    render(<Harness />);
    expect(screen.getByLabelText("num")).toHaveAttribute("placeholder", "0,00");
  });
});

describe("DecimalInput — sincroniza con value externo", () => {
  it("cambio del value externo actualiza el display", async () => {
    function Parent() {
      const [v, setV] = useState<number | null>(1);
      return (
        <>
          <DecimalInput aria-label="num" value={v} onChange={setV} />
          <button onClick={() => setV(99)}>set99</button>
        </>
      );
    }
    render(<Parent />);
    const input = screen.getByLabelText("num") as HTMLInputElement;
    expect(input.value).toBe("1");
    await userEvent.click(screen.getByRole("button", { name: "set99" }));
    expect(input.value).toBe("99");
  });
});

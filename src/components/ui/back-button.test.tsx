import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import es from "@/i18n/locales/es.json";
import en from "@/i18n/locales/en.json";
import { BackButton, BackLink } from "./back-button";

/**
 * Lo que estos tests protegen es que "volver" se vea IGUAL en toda la app.
 *
 * El ícono se comprueba por la clase que lucide le pone al `<svg>`
 * (`lucide-arrow-left`), no por el nombre del import: así el test falla si
 * alguien cambia `BACK_ICON` a un chevron, que es la regresión concreta que
 * originó el componente — había pantallas volviendo con `ChevronLeft`, que es
 * el gesto de "anterior de una serie", no de salir.
 *
 * Solo se ejercitan las variantes con `onClick`: las de `to` necesitan un
 * router de TanStack montado, y lo que interesa acá (ícono, rótulo, hit) no
 * depende de eso.
 */
const ARROW_LEFT = ".lucide-arrow-left";

describe("BackButton", () => {
  it("usa la flecha de volver, nunca un chevron", () => {
    render(<BackButton onClick={() => {}} label="Volver a talleres" />);
    const btn = screen.getByRole("button", { name: "Volver a talleres" });
    expect(btn.querySelector(ARROW_LEFT)).toBeInTheDocument();
    expect(btn.querySelector(".lucide-chevron-left")).toBeNull();
  });

  it("cae al rótulo por defecto cuando no se pasa label", () => {
    render(<BackButton onClick={() => {}} />);
    // `common.back` en es-CO. Si el default se rompe, el botón queda sin texto
    // y sin nombre accesible.
    expect(screen.getByRole("button", { name: "Volver" })).toBeInTheDocument();
  });

  it("iconOnly mantiene el nombre accesible y un hit de 32px", () => {
    render(<BackButton iconOnly onClick={() => {}} label="Volver a la lista" />);
    const btn = screen.getByRole("button", { name: "Volver a la lista" });
    expect(btn.textContent).toBe("");
    // 32px es el piso táctil del proyecto: un ícono de 16px sin padding es
    // imposible de acertar en un teléfono.
    expect(btn.className).toMatch(/h-8/);
    expect(btn.className).toMatch(/w-8/);
    expect(btn.getAttribute("title")).toBe("Volver a la lista");
  });

  it("dispara onClick", async () => {
    const onClick = vi.fn();
    render(<BackButton onClick={onClick} label="Volver" />);
    await userEvent.click(screen.getByRole("button", { name: "Volver" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("BackLink", () => {
  it("comparte el ícono con BackButton aunque se vea distinto", () => {
    render(<BackLink onClick={() => {}} label="Volver al inicio" />);
    const el = screen.getByRole("button", { name: "Volver al inicio" });
    expect(el.querySelector(ARROW_LEFT)).toBeInTheDocument();
    // La miga de pan es chica y apagada a propósito: va ARRIBA del título de
    // una página de detalle y no debe competir con él.
    expect(el.querySelector("span")?.className).toMatch(/text-xs/);
    expect(el.querySelector("span")?.className).toMatch(/text-muted-foreground/);
  });
});

describe("los textos de volver no traen la flecha como carácter", () => {
  // La regresión real: `"backToHome": "← Volver al inicio"` en es.json hacía
  // que el enlace mostrara DOS flechas donde había ícono, y una sola —de
  // texto, no alineada— donde no lo había. Mientras la flecha pueda vivir en
  // el string, cualquier traducción nueva la reintroduce.
  const flatten = (obj: unknown, prefix = ""): [string, string][] => {
    if (typeof obj === "string") return [[prefix, obj]];
    if (obj && typeof obj === "object") {
      return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
        flatten(v, prefix ? `${prefix}.${k}` : k),
      );
    }
    return [];
  };

  it.each([
    ["es", es],
    ["en", en],
  ])("%s no usa ← ni ⟵ en ningún valor", (_locale, dict) => {
    const ofensores = flatten(dict).filter(([, v]) => /[←⟵]|&larr;/.test(v));
    expect(ofensores).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { elegirRolInicial, rolPorDefecto } from "./rol-activo-guardado";

describe("rol activo al recargar", () => {
  it("sin nada guardado entra con el rol por defecto (Docente primero)", () => {
    expect(elegirRolInicial(["Estudiante", "Admin", "Docente"], null)).toBe("Docente");
    expect(rolPorDefecto(["Admin", "Estudiante"])).toBe("Admin");
  });

  it("recargar conserva el rol elegido en la pestaña", () => {
    expect(elegirRolInicial(["Docente", "Estudiante"], "Estudiante")).toBe("Estudiante");
  });

  it("un rol guardado que el usuario ya no tiene se ignora", () => {
    expect(elegirRolInicial(["Docente"], "Admin")).toBe("Docente");
    expect(elegirRolInicial(["Docente"], "basura")).toBe("Docente");
  });

  it("sin roles no hay rol", () => {
    expect(elegirRolInicial([], "Docente")).toBeNull();
  });
});

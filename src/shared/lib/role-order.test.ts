import { describe, it, expect } from "vitest";
import { ROLE_ORDER, sortRolesByDisplay } from "./role-order";
import type { AppRole } from "@/hooks/use-auth";

describe("ROLE_ORDER", () => {
  it("va de mayor a menor alcance", () => {
    expect(ROLE_ORDER).toEqual(["SuperAdmin", "Admin", "Docente", "Estudiante"]);
  });
});

describe("sortRolesByDisplay", () => {
  it("ordena un set completo desordenado al orden jerárquico", () => {
    const input: AppRole[] = ["Estudiante", "SuperAdmin", "Docente", "Admin"];
    expect(sortRolesByDisplay(input)).toEqual(["SuperAdmin", "Admin", "Docente", "Estudiante"]);
  });

  it("ordena el caso típico Admin+Docente (Admin primero)", () => {
    expect(sortRolesByDisplay(["Docente", "Admin"])).toEqual(["Admin", "Docente"]);
  });

  it("deja un solo rol intacto", () => {
    expect(sortRolesByDisplay(["Estudiante"])).toEqual(["Estudiante"]);
  });

  it("no muta el array original", () => {
    const input: AppRole[] = ["Docente", "SuperAdmin"];
    const copy = [...input];
    sortRolesByDisplay(input);
    expect(input).toEqual(copy);
  });

  it("es estable / idempotente al re-ordenar", () => {
    const once = sortRolesByDisplay(["Estudiante", "Admin"]);
    expect(sortRolesByDisplay(once)).toEqual(once);
  });

  it("devuelve [] para input vacío", () => {
    expect(sortRolesByDisplay([])).toEqual([]);
  });
});

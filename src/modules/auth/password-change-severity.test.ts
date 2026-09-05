import { describe, it, expect } from "vitest";

import { severidadCambioContrasena } from "./password-change-severity";

describe("severidadCambioContrasena", () => {
  it("la contraseña repetida es del usuario, no del sistema", () => {
    // El mensaje EXACTO que devolvió Auth en los 3 eventos de producción.
    expect(severidadCambioContrasena("New password should be different from the old password.")).toBe(
      "warning",
    );
  });

  it("una contraseña demasiado corta o débil también", () => {
    expect(severidadCambioContrasena("Password should be at least 6 characters.")).toBe("warning");
    expect(severidadCambioContrasena("Password is known to be weak and easy to guess.")).toBe(
      "warning",
    );
  });

  it("cualquier otra cosa SIGUE siendo error", () => {
    // Lo que importa del cambio: no silenciar los fallos de verdad.
    expect(severidadCambioContrasena("Auth session missing!")).toBe("error");
    expect(severidadCambioContrasena("Failed to fetch")).toBe("error");
    expect(severidadCambioContrasena("Internal Server Error")).toBe("error");
  });

  it("sin mensaje se asume error (no se silencia lo que no se entiende)", () => {
    expect(severidadCambioContrasena(null)).toBe("error");
    expect(severidadCambioContrasena("")).toBe("error");
    expect(severidadCambioContrasena("   ")).toBe("error");
  });
});

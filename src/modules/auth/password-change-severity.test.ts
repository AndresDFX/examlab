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

/**
 * El `code` de `AuthError` manda sobre el texto.
 *
 * La primera versión de este helper clasificaba SOLO por el mensaje en inglés, y su docstring
 * afirmaba que Auth no daba un código estable. Es falso: `same_password` y `weak_password`
 * están en el `ErrorCode` de `@supabase/auth-js`.
 */
describe("severidadCambioContrasena — por código", () => {
  it("reconoce los códigos de Auth sin depender del idioma del mensaje", () => {
    expect(severidadCambioContrasena({ code: "same_password", message: "cualquier cosa" })).toBe(
      "warning",
    );
    // `weak_password` con motivo "characters": el texto NO coincide con ninguna
    // de las frases previstas, y por código igual se clasifica bien.
    expect(
      severidadCambioContrasena({
        code: "weak_password",
        message: "Password does not meet the following criteria: characters",
      }),
    ).toBe("warning");
  });

  it("un código que no es de entrada es error, aunque el texto se le parezca", () => {
    // El código es más específico que la frase: si Auth dice `unexpected_failure`,
    // eso es un error aunque el mensaje mencione la contraseña.
    expect(
      severidadCambioContrasena({
        code: "unexpected_failure",
        message: "new password should be different from the old password",
      }),
    ).toBe("error");
  });

  it("sin código, sigue clasificando por el texto (servidores viejos)", () => {
    expect(
      severidadCambioContrasena({ message: "New password should be different from the old password." }),
    ).toBe("warning");
    expect(severidadCambioContrasena({ message: "Auth session missing!" })).toBe("error");
  });

  it("acepta también un string suelto, como antes", () => {
    expect(severidadCambioContrasena("Password should be at least 6 characters.")).toBe("warning");
    expect(severidadCambioContrasena("Failed to fetch")).toBe("error");
  });
});

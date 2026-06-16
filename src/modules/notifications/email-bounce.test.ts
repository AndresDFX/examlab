import { describe, expect, it } from "vitest";
import { isPermanentMailboxError } from "./email-bounce";

describe("isPermanentMailboxError — auto-supresión sólo en rebotes permanentes", () => {
  it("NO suprime rebotes transitorios 4.x (el servidor reintenta solo)", () => {
    // El caso EXACTO del reporte (Camacho): 452 4.2.2 es TEMPORAL.
    expect(
      isPermanentMailboxError(
        "452 4.2.2 The recipient's inbox is out of storage space. gsmtp",
      ),
    ).toBe(false);
    expect(isPermanentMailboxError("421 4.3.0 Temporary System Problem. gsmtp")).toBe(false);
    expect(isPermanentMailboxError("450 4.2.1 mailbox unavailable, try later")).toBe(false);
  });

  it("suprime rebotes PERMANENTES de buzón lleno (5.2.2)", () => {
    expect(
      isPermanentMailboxError("552 5.2.2 The email account that you tried to reach is over quota"),
    ).toBe(true);
    expect(isPermanentMailboxError("550 5.2.2 Mailbox full")).toBe(true);
  });

  it("suprime usuario inexistente / deshabilitado (5.1.1 / 5.2.1)", () => {
    expect(isPermanentMailboxError("550 5.1.1 The email account does not exist. gsmtp")).toBe(true);
    expect(isPermanentMailboxError("550 5.2.1 The user you are trying to reach is disabled")).toBe(
      true,
    );
    expect(isPermanentMailboxError("550 5.1.1 no such user here")).toBe(true);
  });

  it("NO suprime errores que no son de buzón/usuario aunque sean 5.x", () => {
    // Un 5.7.1 de política/relay no debe sacar a la dirección de circulación.
    expect(isPermanentMailboxError("550 5.7.1 Message rejected due to content policy")).toBe(false);
    expect(isPermanentMailboxError("535 5.7.8 Authentication failed")).toBe(false);
  });

  it("tolera mensajes vacíos / basura", () => {
    expect(isPermanentMailboxError("")).toBe(false);
    expect(isPermanentMailboxError("connection timeout")).toBe(false);
  });
});

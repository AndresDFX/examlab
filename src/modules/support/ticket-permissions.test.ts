import { describe, it, expect } from "vitest";
import { canDeleteSupportTicket } from "./ticket-permissions";

const CREATOR = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

describe("canDeleteSupportTicket", () => {
  it("SuperAdmin puede eliminar cualquier ticket (propio o ajeno)", () => {
    expect(
      canDeleteSupportTicket({
        mode: "superadmin",
        ticketCreatedBy: CREATOR,
        currentUserId: OTHER,
      }),
    ).toBe(true);
  });

  it("SuperAdmin puede eliminar aun sin currentUserId resuelto", () => {
    expect(
      canDeleteSupportTicket({
        mode: "superadmin",
        ticketCreatedBy: CREATOR,
        currentUserId: null,
      }),
    ).toBe(true);
  });

  it("Admin puede eliminar SU propio ticket (creator === current)", () => {
    expect(
      canDeleteSupportTicket({
        mode: "admin",
        ticketCreatedBy: CREATOR,
        currentUserId: CREATOR,
      }),
    ).toBe(true);
  });

  it("Admin NO puede eliminar el ticket de otro", () => {
    expect(
      canDeleteSupportTicket({
        mode: "admin",
        ticketCreatedBy: OTHER,
        currentUserId: CREATOR,
      }),
    ).toBe(false);
  });

  it("Admin sin currentUserId no puede eliminar (control oculto hasta auth)", () => {
    expect(
      canDeleteSupportTicket({
        mode: "admin",
        ticketCreatedBy: CREATOR,
        currentUserId: null,
      }),
    ).toBe(false);
  });

  it("Admin con ticket sin created_by no puede eliminar", () => {
    expect(
      canDeleteSupportTicket({
        mode: "admin",
        ticketCreatedBy: null,
        currentUserId: CREATOR,
      }),
    ).toBe(false);
  });

  it("undefined inputs son seguros (no crashea, devuelve false en modo admin)", () => {
    expect(
      canDeleteSupportTicket({
        mode: "admin",
        ticketCreatedBy: undefined,
        currentUserId: undefined,
      }),
    ).toBe(false);
  });
});

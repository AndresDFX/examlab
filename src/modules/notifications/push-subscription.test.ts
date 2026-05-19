import { describe, expect, it, vi } from "vitest";

// Mock supabase para no romper la importación. No probamos los flujos
// que tocan supabase aquí — solo las helpers puras.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn() },
}));

import { extractKeys, urlBase64ToUint8Array } from "./push-subscription";

describe("urlBase64ToUint8Array", () => {
  it("decodifica 'aGVsbG8' (base64url) a 'hello' como bytes", () => {
    const out = urlBase64ToUint8Array("aGVsbG8");
    expect(Array.from(out)).toEqual([104, 101, 108, 108, 111]); // 'hello'
  });

  it("acepta strings sin padding (base64url estándar)", () => {
    // 'Man' = 'TWFu'
    const out = urlBase64ToUint8Array("TWFu");
    expect(Array.from(out)).toEqual([77, 97, 110]);
  });

  it("traduce '-' a '+' y '_' a '/' (base64url → base64)", () => {
    // Bytes [0xFB, 0xFF] = "+/8=" en base64 estándar; en base64url es "-_8".
    const out = urlBase64ToUint8Array("-_8");
    expect(Array.from(out)).toEqual([0xfb, 0xff]);
  });

  it("retorna Uint8Array con buffer ArrayBuffer (no Shared)", () => {
    const out = urlBase64ToUint8Array("TWFu");
    expect(out).toBeInstanceOf(Uint8Array);
    // El comentario del helper dice explícitamente: ArrayBuffer fresco
    // para que `applicationServerKey` lo acepte.
    expect(out.buffer).toBeInstanceOf(ArrayBuffer);
    expect(out.buffer.constructor.name).toBe("ArrayBuffer");
  });

  it("vacío → Uint8Array vacío", () => {
    const out = urlBase64ToUint8Array("");
    expect(out.length).toBe(0);
  });

  it("longitud no múltiplo de 4 → padding agregado correctamente", () => {
    // "QQ" (decodifica a [0x41]) requiere padding "==".
    const out = urlBase64ToUint8Array("QQ");
    expect(Array.from(out)).toEqual([0x41]);
  });
});

describe("extractKeys", () => {
  function mockSub(p256dh: string | null, auth: string | null): PushSubscription {
    // Sólo implementamos `toJSON()` que es lo que extractKeys usa.
    return {
      toJSON: () => ({
        keys: {
          ...(p256dh ? { p256dh } : {}),
          ...(auth ? { auth } : {}),
        },
      }),
    } as unknown as PushSubscription;
  }

  it("extrae p256dh y auth cuando ambos están presentes", () => {
    const sub = mockSub("abc-p256dh", "xyz-auth");
    expect(extractKeys(sub)).toEqual({ p256dh: "abc-p256dh", auth: "xyz-auth" });
  });

  it("retorna null cuando falta p256dh", () => {
    const sub = mockSub(null, "solo-auth");
    expect(extractKeys(sub)).toBeNull();
  });

  it("retorna null cuando falta auth", () => {
    const sub = mockSub("solo-p256", null);
    expect(extractKeys(sub)).toBeNull();
  });

  it("retorna null cuando faltan ambos", () => {
    const sub = mockSub(null, null);
    expect(extractKeys(sub)).toBeNull();
  });
});

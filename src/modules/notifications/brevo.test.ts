import { describe, expect, it, vi } from "vitest";
import { enviarPorBrevo } from "../../../supabase/functions/_shared/brevo";

const base = {
  apiKey: "k",
  senderEmail: "remitente@gmail.com",
  senderName: "ExamLab",
  to: ["a@x.co", "b@x.co"],
  subject: "ExamLab: Restablece tu contraseña",
  html: "<p>hola</p>",
  text: "hola",
};

describe("envío por Brevo", () => {
  it("arma la petición de la API transaccional con remitente y destinatarios", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "<m1>" }), { status: 201 }));
    const r = await enviarPorBrevo({ ...base, replyTo: "r@x.co" }, fetchMock as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: true, messageId: "<m1>" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("k");
    const body = JSON.parse(String(init.body));
    expect(body.sender).toEqual({ email: "remitente@gmail.com", name: "ExamLab" });
    expect(body.to).toEqual([{ email: "a@x.co" }, { email: "b@x.co" }]);
    expect(body.replyTo).toEqual({ email: "r@x.co" });
  });

  it("un rechazo de Brevo vuelve como error, para caer al SMTP", async () => {
    const fetchMock = vi.fn(async () => new Response('{"code":"unauthorized"}', { status: 401 }));
    const r = await enviarPorBrevo(base, fetchMock as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("401");
  });

  it("un fallo de red también vuelve como error y no lanza", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("timeout");
    });
    const r = await enviarPorBrevo(base, fetchMock as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false });
  });
});

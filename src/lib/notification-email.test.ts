import { describe, expect, it } from "vitest";
import {
  CRITICAL_KINDS,
  MESSAGE_LINK_PREFIX,
  escapeHtml,
  renderEmailHtml,
  shouldSendEmail,
} from "./notification-email";

describe("shouldSendEmail — sin email del destinatario", () => {
  it("retorna 'no_email' cuando hasEmail=false (independiente del kind)", () => {
    const out = shouldSendEmail({ kind: "grade", link: null, hasEmail: false });
    expect(out).toEqual({ send: false, reason: "no_email" });
  });

  it("'no_email' tiene prioridad sobre opt-out (no podemos enviarlo ni queriendo)", () => {
    const out = shouldSendEmail({
      kind: "grade",
      link: null,
      hasEmail: false,
      userOptedOut: true,
    });
    expect(out.reason).toBe("no_email");
  });
});

describe("shouldSendEmail — kinds críticos", () => {
  it.each(CRITICAL_KINDS)("envía para kind crítico '%s'", (kind) => {
    const out = shouldSendEmail({ kind, link: null });
    expect(out).toEqual({ send: true, reason: null });
  });

  it("rechaza kind no incluido como 'system'", () => {
    expect(shouldSendEmail({ kind: "system", link: null })).toEqual({
      send: false,
      reason: "kind_not_critical",
    });
  });

  it("rechaza kind desconocido como 'random_kind'", () => {
    expect(shouldSendEmail({ kind: "random_kind", link: null })).toEqual({
      send: false,
      reason: "kind_not_critical",
    });
  });
});

describe("shouldSendEmail — caso especial 'info' de mensajería", () => {
  it("envía 'info' SI link empieza con /app/messages", () => {
    const out = shouldSendEmail({ kind: "info", link: "/app/messages" });
    expect(out).toEqual({ send: true, reason: null });
  });

  it("envía 'info' con link /app/messages?conv=X (querystring no rompe el prefijo)", () => {
    const out = shouldSendEmail({ kind: "info", link: "/app/messages?conv=abc" });
    expect(out).toEqual({ send: true, reason: null });
  });

  it("rechaza 'info' con link null (sin contexto de mensaje)", () => {
    expect(shouldSendEmail({ kind: "info", link: null }).send).toBe(false);
  });

  it("rechaza 'info' con link a otra ruta", () => {
    expect(shouldSendEmail({ kind: "info", link: "/app/student/grades" }).send).toBe(false);
  });

  it("rechaza 'info' con link que CONTIENE messages pero no como prefijo", () => {
    // Defensa contra SSRF/typo: solo cuenta si EMPIEZA con /app/messages.
    expect(shouldSendEmail({ kind: "info", link: "/app/student/messages" }).send).toBe(false);
  });
});

describe("shouldSendEmail — opt-out del usuario", () => {
  it("respeta userOptedOut=true (no envía aunque el kind sea crítico)", () => {
    const out = shouldSendEmail({ kind: "grade", link: null, userOptedOut: true });
    expect(out).toEqual({ send: false, reason: "user_opted_out" });
  });

  it("userOptedOut=false explícito sí envía", () => {
    const out = shouldSendEmail({ kind: "grade", link: null, userOptedOut: false });
    expect(out.send).toBe(true);
  });

  it("userOptedOut undefined se trata como false (default opt-in)", () => {
    const out = shouldSendEmail({ kind: "grade", link: null });
    expect(out.send).toBe(true);
  });

  it("opt-out NO se evalúa si kind no es crítico (se descarta antes)", () => {
    const out = shouldSendEmail({ kind: "system", link: null, userOptedOut: true });
    // Razón = kind_not_critical, no user_opted_out (orden de filtros).
    expect(out.reason).toBe("kind_not_critical");
  });
});

describe("escapeHtml", () => {
  it("escapa & < > \" ' básicos", () => {
    expect(escapeHtml("<script>alert(\"x\")</script>")).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
  });

  it("escapa apostrofe", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapa ampersand primero (no doble-escapa)", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("texto sin caracteres especiales queda igual", () => {
    expect(escapeHtml("Hola mundo")).toBe("Hola mundo");
  });
});

describe("renderEmailHtml", () => {
  const baseParams = {
    recipientName: "Andrés Castaño",
    title: "Nueva calificación en Cálculo I",
    body: "Tu examen del corte 2 ya está calificado.",
    appUrl: "https://examlab.app",
  };

  it("contiene el saludo con el primer nombre del destinatario", () => {
    const html = renderEmailHtml(baseParams);
    expect(html).toContain("Hola Andrés,");
  });

  it("usa 'Hola,' cuando recipientName es null", () => {
    const html = renderEmailHtml({ ...baseParams, recipientName: null });
    expect(html).toContain("Hola,");
    expect(html).not.toContain("Hola Andrés");
  });

  it("incluye el title escapado en el HTML", () => {
    const html = renderEmailHtml({ ...baseParams, title: "<b>Test</b>" });
    expect(html).toContain("&lt;b&gt;Test&lt;/b&gt;");
    expect(html).not.toContain("<b>Test</b>");
  });

  it("convierte saltos de línea del body en <br>", () => {
    const html = renderEmailHtml({ ...baseParams, body: "línea 1\nlínea 2" });
    expect(html).toContain("línea 1<br>línea 2");
  });

  it("incluye botón CTA cuando hay link", () => {
    const html = renderEmailHtml({ ...baseParams, link: "/app/student/grades" });
    expect(html).toContain("https://examlab.app/app/student/grades");
    expect(html).toContain("Ver en ExamLab");
  });

  it("NO incluye botón CTA cuando link es null", () => {
    const html = renderEmailHtml({ ...baseParams, link: null });
    expect(html).not.toContain("Ver en ExamLab");
  });

  it("normaliza appUrl con trailing slash (no genera doble slash)", () => {
    const html = renderEmailHtml({
      ...baseParams,
      appUrl: "https://examlab.app/",
      link: "/app/student/grades",
    });
    // Buscamos que NO aparezca el doble slash en la URL del CTA.
    expect(html).toMatch(/https:\/\/examlab\.app\/app\/student\/grades/);
    expect(html).not.toMatch(/https:\/\/examlab\.app\/\/app/);
  });

  it("respeta brandName custom (no usa 'ExamLab' hardcoded)", () => {
    const html = renderEmailHtml({ ...baseParams, brandName: "MiEscuela", link: "/x" });
    expect(html).toContain(">MiEscuela<"); // header
    expect(html).toContain("Ver en MiEscuela"); // CTA
    expect(html).toContain("cuenta en MiEscuela"); // footer
  });

  it("escape XSS en el body (script tag)", () => {
    const html = renderEmailHtml({ ...baseParams, body: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escape XSS en recipientName (no escape de HTML en saludo)", () => {
    const html = renderEmailHtml({ ...baseParams, recipientName: "<img src=x>" });
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img");
  });
});

describe("CRITICAL_KINDS export", () => {
  it("expone exactamente los kinds esperados (cambio explícito si se modifica)", () => {
    expect([...CRITICAL_KINDS]).toEqual(["grade", "exam", "feedback"]);
  });
});

describe("MESSAGE_LINK_PREFIX export", () => {
  it("expone /app/messages", () => {
    expect(MESSAGE_LINK_PREFIX).toBe("/app/messages");
  });
});

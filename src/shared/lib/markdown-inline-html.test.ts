import { describe, expect, it } from "vitest";
import { escapeHtml, markdownInlineToHtml } from "./markdown-inline-html";

describe("markdownInlineToHtml", () => {
  it("el caso que lo originó: el PDF de la encuesta imprimía los asteriscos", () => {
    expect(
      markdownInlineToHtml(
        "Opcional y confidencial: **solo yo veo tus respuestas**, no tus compañeros.",
      ),
    ).toBe(
      "Opcional y confidencial: <strong>solo yo veo tus respuestas</strong>, no tus compañeros.",
    );
  });

  it("negrita, itálica, tachado y código", () => {
    expect(markdownInlineToHtml("**a**")).toBe("<strong>a</strong>");
    expect(markdownInlineToHtml("__a__")).toBe("<strong>a</strong>");
    expect(markdownInlineToHtml("*a*")).toBe("<em>a</em>");
    expect(markdownInlineToHtml("~~a~~")).toBe("<del>a</del>");
    expect(markdownInlineToHtml("`a`")).toBe("<code>a</code>");
  });

  it("la negrita gana sobre la itálica (si no, `**x**` quedaría `<em>*x*</em>`)", () => {
    expect(markdownInlineToHtml("**muy** *poco*")).toBe("<strong>muy</strong> <em>poco</em>");
  });

  it("ESCAPA antes de renderizar: el HTML que alguien escriba no se ejecuta", () => {
    // Se usa sobre respuestas abiertas de una encuesta: texto de usuario.
    expect(markdownInlineToHtml("<script>alert(1)</script>")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(markdownInlineToHtml("<b>no</b> **sí**")).toBe(
      "&lt;b&gt;no&lt;/b&gt; <strong>sí</strong>",
    );
    // Y un `&` suelto no se rompe al doble-escapar.
    expect(markdownInlineToHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
  });

  it("dentro de código los asteriscos son literales", () => {
    expect(markdownInlineToHtml("usá `**esto**` para negrita")).toBe(
      "usá <code>**esto**</code> para negrita",
    );
  });

  it("un identificador con guiones bajos NO es itálica", () => {
    // En este proyecto abundan: vocero_marcado_at, session_id, full_name…
    expect(markdownInlineToHtml("la columna vocero_marcado_at")).toBe(
      "la columna vocero_marcado_at",
    );
    expect(markdownInlineToHtml("session_id y user_id")).toBe("session_id y user_id");
    // pero `_así_` entre espacios sí
    expect(markdownInlineToHtml("es _importante_ leerlo")).toBe("es <em>importante</em> leerlo");
  });

  it("los saltos de línea se ven", () => {
    expect(markdownInlineToHtml("uno\ndos")).toBe("uno<br>dos");
    expect(markdownInlineToHtml("uno\r\ndos")).toBe("uno<br>dos");
  });

  it("vacío, null y undefined dan string vacío", () => {
    for (const v of ["", null, undefined]) {
      expect(markdownInlineToHtml(v)).toBe("");
    }
  });

  it("asteriscos sueltos o sin cerrar se dejan como están", () => {
    // Alguien escribe "2 * 3" o "**importante" a medias: no debe quedar HTML roto.
    expect(markdownInlineToHtml("2 * 3 = 6")).toBe("2 * 3 = 6");
    expect(markdownInlineToHtml("**sin cerrar")).toBe("**sin cerrar");
    const r = markdownInlineToHtml("*a **b** c*");
    // Lo único no negociable: no queda una etiqueta sin cerrar.
    expect((r.match(/<strong>/g) ?? []).length).toBe((r.match(/<\/strong>/g) ?? []).length);
    expect((r.match(/<em>/g) ?? []).length).toBe((r.match(/<\/em>/g) ?? []).length);
  });

  it("nunca deja el marcador interno del código a la vista, ni choca con el texto", () => {
    // El marcador es un detalle de implementación: si se filtrara al PDF sería
    // peor que el bug original. Con un marcador de texto plano (`CODE0`) este
    // test FALLABA cuando alguien escribía literalmente "CODE0"; de ahí que el
    // marcador lleve `<`, que no puede existir en texto ya escapado.
    for (const v of [
      "`a` y `b`",
      "CODE0 literal",
      "`x` CODE0 `y`",
      "md-code:0 literal",
      "`x` md-code:0 `y`",
      "sin código",
    ]) {
      const r = markdownInlineToHtml(v);
      // La forma que importa es la del marcador REAL: entre ángulos. Escribir
      // `md-code:0` como texto plano es legítimo y tiene que sobrevivir tal
      // cual — asertar sobre el texto suelto daba un falso positivo.
      expect(r, v).not.toMatch(/<md-code:/);
    }
    // Y el texto literal del usuario sobrevive intacto.
    expect(markdownInlineToHtml("`x` CODE0 `y`")).toBe("<code>x</code> CODE0 <code>y</code>");
    expect(markdownInlineToHtml("`x` md-code:0 `y`")).toBe(
      "<code>x</code> md-code:0 <code>y</code>",
    );
  });

  it("varias marcas en la misma frase", () => {
    expect(markdownInlineToHtml("**a**, *b*, `c` y ~~d~~")).toBe(
      "<strong>a</strong>, <em>b</em>, <code>c</code> y <del>d</del>",
    );
  });
});

describe("escapeHtml", () => {
  it("escapa los cinco caracteres que importan", () => {
    expect(escapeHtml(`<>&"'`)).toBe("&lt;&gt;&amp;&quot;&#39;");
  });
  it("null y undefined dan vacío", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { markdownToPlain, markdownToPlainPreview } from "./markdown-plain";

/**
 * El caso que originó el helper: la descripción de una encuesta de UNIAJ
 * empieza con `**solo yo veo tus respuestas**` y en las vistas truncadas se
 * veían los asteriscos. Ese es el primer test y el que no se puede romper.
 */
describe("markdownToPlain", () => {
  it("quita la negrita del caso real", () => {
    expect(
      markdownToPlain(
        "Opcional y confidencial: **solo yo veo tus respuestas**, no tus compañeros.",
      ),
    ).toBe("Opcional y confidencial: solo yo veo tus respuestas, no tus compañeros.");
  });

  it("vacío y nulo dan cadena vacía", () => {
    expect(markdownToPlain(null)).toBe("");
    expect(markdownToPlain(undefined)).toBe("");
    expect(markdownToPlain("")).toBe("");
  });

  it("negrita, énfasis, tachado y las tres marcas juntas", () => {
    expect(markdownToPlain("**a** *b* ~~c~~ ___d___")).toBe("a b c d");
    expect(markdownToPlain("__negrita__ y _énfasis_")).toBe("negrita y énfasis");
  });

  it("no junta dos marcas separadas como si fueran una", () => {
    // Con un cuantificador greedy, "**a** y **b**" se comería el medio.
    expect(markdownToPlain("**a** y **b**")).toBe("a y b");
  });

  it("código en línea y bloques cercados dejan el contenido", () => {
    expect(markdownToPlain("usá `git status` antes")).toBe("usá git status antes");
    expect(markdownToPlain("```sql\nSELECT 1;\n```")).toBe("SELECT 1;");
  });

  it("los asteriscos DENTRO de código no se tratan como énfasis", () => {
    expect(markdownToPlain("el patrón `a*b*c` es literal")).toBe("el patrón a*b*c es literal");
  });

  it("enlaces dejan el texto, no la URL", () => {
    expect(markdownToPlain("mirá [la guía](https://ejemplo.com/x) acá")).toBe("mirá la guía acá");
  });

  it("imágenes dejan el alt", () => {
    expect(markdownToPlain("![diagrama](/x.png) al lado")).toBe("diagrama al lado");
  });

  it("encabezados, citas, viñetas y listas numeradas pierden el prefijo", () => {
    expect(markdownToPlain("## Título")).toBe("Título");
    expect(markdownToPlain("> una cita")).toBe("una cita");
    expect(markdownToPlain("- uno\n- dos")).toBe("uno dos");
    expect(markdownToPlain("1. uno\n2) dos")).toBe("uno dos");
  });

  it("una viñeta no se confunde con énfasis", () => {
    // Si se quitaran los prefijos ANTES que el énfasis, el `*` de la viñeta
    // se emparejaría con el siguiente y se comería texto.
    expect(markdownToPlain("* uno\n* dos")).toBe("uno dos");
  });

  it("la regla horizontal desaparece", () => {
    expect(markdownToPlain("antes\n\n---\n\ndespués")).toBe("antes después");
  });

  it("respeta los escapes", () => {
    expect(markdownToPlain("literal \\*no es énfasis\\*")).toBe("literal *no es énfasis*");
  });

  it("colapsa todo a una línea, que es para lo que sirve", () => {
    expect(markdownToPlain("una\n\n\ndos   tres\n")).toBe("una dos tres");
  });

  it("los números del texto sobreviven — el centinela no puede estar vacío", () => {
    // Este test existe por un error concreto que casi entró: si `MARCA` queda
    // como cadena vacía (pasa fácil, porque el carácter es INVISIBLE en la
    // fuente y cualquiera lo "limpia"), el regex de restauración pasa a ser
    // /(\d+)/ y se come cualquier número del texto del docente.
    expect(markdownToPlain("Respondiste 3 de 10 preguntas")).toBe("Respondiste 3 de 10 preguntas");
    expect(markdownToPlain("**2026-2** tiene 13 sesiones")).toBe("2026-2 tiene 13 sesiones");
    expect(markdownToPlain("`x = 42` y 7 más")).toBe("x = 42 y 7 más");
  });

  it("nunca devuelve HTML — el que lo consume lo pinta como texto", () => {
    const r = markdownToPlain("**a** [x](y) `z`");
    expect(r).not.toMatch(/[<>]/);
  });
});

describe("markdownToPlainPreview", () => {
  it("deja pasar lo corto sin tocarlo", () => {
    expect(markdownToPlainPreview("**hola**", 50)).toBe("hola");
  });

  it("recorta con elipsis y sin partir una palabra", () => {
    const r = markdownToPlainPreview("palabra ".repeat(40), 20);
    expect(r.endsWith("…")).toBe(true);
    expect(r.length).toBeLessThanOrEqual(21);
    expect(r).not.toMatch(/palab…$/); // no cortó a mitad de palabra
  });

  it("si no hay espacio donde cortar, corta duro", () => {
    const r = markdownToPlainPreview("a".repeat(50), 10);
    expect(r).toBe("a".repeat(10) + "…");
  });
});

import { describe, expect, it } from "vitest";
import { avisoAlPublicar, transicionDeFila } from "./publicacion";

describe("transicionDeFila", () => {
  it("un borrador se publica", () => {
    expect(transicionDeFila("draft")).toEqual({ a: "published", clave: "publicar" });
  });

  it("un publicado vuelve a borrador", () => {
    expect(transicionDeFila("published")).toEqual({ a: "draft", clave: "volverABorrador" });
  });

  it("una actividad CERRADA no ofrece nada desde la fila", () => {
    // Reabrirla habilita entregas sobre notas que quizá ya se publicaron: es
    // una decisión con consecuencias, no un clic de menú.
    expect(transicionDeFila("closed")).toBeNull();
  });

  it("un estado desconocido o ausente no ofrece nada", () => {
    expect(transicionDeFila(null)).toBeNull();
    expect(transicionDeFila(undefined)).toBeNull();
    expect(transicionDeFila("archivado")).toBeNull();
  });
});

describe("avisoAlPublicar", () => {
  const ahora = new Date("2026-09-18T12:00:00Z");

  it("sin fecha de inicio, el aviso sale en el acto", () => {
    expect(avisoAlPublicar(null, ahora)).toBe("ahora");
    expect(avisoAlPublicar(undefined, ahora)).toBe("ahora");
  });

  it("con la fecha a más de un día, el aviso queda diferido al cron", () => {
    expect(avisoAlPublicar("2026-09-24T18:30:00Z", ahora)).toBe("cuandoSeAcerque");
  });

  it("con la fecha dentro de las próximas 24 horas, el aviso sale ya", () => {
    expect(avisoAlPublicar("2026-09-19T08:00:00Z", ahora)).toBe("ahora");
  });

  it("una fecha que ya pasó también avisa en el acto", () => {
    // El trigger no distingue pasado de futuro cercano: en los dos casos la
    // actividad ya es relevante para el estudiante.
    expect(avisoAlPublicar("2026-09-01T08:00:00Z", ahora)).toBe("ahora");
  });

  it("justo en el umbral de 24 horas todavía es inmediato", () => {
    expect(avisoAlPublicar("2026-09-19T12:00:00Z", ahora)).toBe("ahora");
    // Un minuto más allá ya se difiere.
    expect(avisoAlPublicar("2026-09-19T12:01:00Z", ahora)).toBe("cuandoSeAcerque");
  });

  it("una fecha ilegible no oculta el aviso", () => {
    // Ante la duda se avisa que puede salir ya: prometer silencio y que el
    // correo salga igual es el error caro.
    expect(avisoAlPublicar("no es una fecha", ahora)).toBe("ahora");
  });
});

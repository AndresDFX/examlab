import { describe, expect, it } from "vitest";
import {
  avisoAlPublicar,
  avisosAlPublicarVarias,
  CATEGORIA_DE_TABLA,
  planDePublicacionMasiva,
  transicionDeFila,
} from "./publicacion";

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

  it("con la categoría apagada NO se promete ningún aviso", () => {
    // Regresión del bloqueante que encontró la revisión de consistencia: desde
    // que el panel gobierna qué avisa (mig 20262300000000), publicar un taller
    // cuya categoría está apagada no manda NADA — pero el diálogo seguía
    // diciendo "se les avisa ahora mismo... el aviso ya no se puede retirar".
    // El docente publicaba creyendo que el curso se enteró.
    expect(avisoAlPublicar(null, ahora, false)).toBe("silenciado");
    expect(avisoAlPublicar("2026-09-19T08:00:00Z", ahora, false)).toBe("silenciado");
    // La fecha deja de importar: apagada es apagada, cerca o lejos.
    expect(avisoAlPublicar("2027-01-01T08:00:00Z", ahora, false)).toBe("silenciado");
  });

  it("el default es 'encendida', para no romper a quien no pase el tercer argumento", () => {
    expect(avisoAlPublicar(null, ahora)).toBe("ahora");
    expect(avisoAlPublicar(null, ahora, true)).toBe("ahora");
  });
});

describe("CATEGORIA_DE_TABLA", () => {
  it("mapea la TABLA del grid a la clave del panel, que está en singular", () => {
    // Si devolviera el nombre de la tabla (`workshops`), la búsqueda en
    // `enabled_kinds` daría undefined, se leería como "encendido" y el diálogo
    // volvería a prometer un aviso que no sale — el bug que este mapa evita.
    expect(CATEGORIA_DE_TABLA.workshops).toBe("workshop");
    expect(CATEGORIA_DE_TABLA.exams).toBe("exam");
    expect(CATEGORIA_DE_TABLA.projects).toBe("project");
  });
});

describe("planDePublicacionMasiva", () => {
  const filas = [
    { id: "b1", status: "draft" },
    { id: "b2", status: "draft", cursoEnBorrador: true },
    { id: "p1", status: "published" },
    { id: "p2", status: "published", cursoEnBorrador: true },
    { id: "c1", status: "closed" },
    { id: "x", status: null },
  ];

  it("publicar: solo los borradores de cursos activos; cuenta lo que se omite", () => {
    expect(planDePublicacionMasiva(filas, "publicar")).toEqual({
      ids: ["b1"],
      yaEstaban: 2,
      cerradas: 2,
      enCursoBorrador: 1,
    });
  });

  it("volver a borrador: todos los publicados, aunque su curso esté en borrador", () => {
    // Esconder algo nunca está bloqueado: es justo lo que la regla quiere.
    expect(planDePublicacionMasiva(filas, "volverABorrador")).toEqual({
      ids: ["p1", "p2"],
      yaEstaban: 2,
      cerradas: 2,
      enCursoBorrador: 0,
    });
  });

  it("ofrece lo mismo que la fila: una cerrada no cambia desde la lista", () => {
    const plan = planDePublicacionMasiva([{ id: "c", status: "closed" }], "publicar");
    expect(plan.ids).toEqual([]);
    expect(plan.cerradas).toBe(1);
  });

  it("sin filas no hay nada que hacer", () => {
    expect(planDePublicacionMasiva([], "publicar")).toEqual({
      ids: [],
      yaEstaban: 0,
      cerradas: 0,
      enCursoBorrador: 0,
    });
  });
});

describe("avisosAlPublicarVarias", () => {
  const ahora = new Date("2026-09-18T12:00:00Z");

  it("cuenta, fila por fila, cuáles avisan ya y cuáles cuando se acerquen", () => {
    expect(
      avisosAlPublicarVarias([null, "2026-09-19T08:00:00Z", "2026-10-30T12:00:00Z"], ahora),
    ).toEqual({ silenciado: false, ahora: 2, cuandoSeAcerque: 1 });
  });

  it("con la categoría apagada no se promete ningún aviso", () => {
    expect(avisosAlPublicarVarias([null], ahora, false)).toEqual({
      silenciado: true,
      ahora: 0,
      cuandoSeAcerque: 0,
    });
  });
});

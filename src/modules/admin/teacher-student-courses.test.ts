import { describe, expect, it } from "vitest";
import {
  COURSE_NAME_SEPARATOR,
  classifyImportOutcome,
  resolveCourseSelection,
  type TeacherCourseOption,
} from "./teacher-student-courses";

const catalogo: TeacherCourseOption[] = [
  { id: "c1", name: "Programación II" },
  { id: "c2", name: "Bases de Datos II" },
  { id: "c3", name: "Paradigmas de Programación" },
];

describe("resolveCourseSelection", () => {
  it("un solo curso produce el mismo payload que la versión de un Select", () => {
    const sel = resolveCourseSelection(["c2"], catalogo);
    expect(sel.names).toEqual(["Bases de Datos II"]);
    expect(sel.courseNameField).toBe("Bases de Datos II");
    expect(sel.problem).toBeNull();
  });

  it("varios cursos van en UN campo unido por el separador del edge", () => {
    const sel = resolveCourseSelection(["c1", "c2"], catalogo);
    expect(sel.courseNameField).toBe("Programación II|Bases de Datos II");
    expect(COURSE_NAME_SEPARATOR).toBe("|");
  });

  it("el orden es el del catálogo, no el de los clics", () => {
    // Si el orden fuera el de los clics, el mismo par de cursos generaría dos
    // payloads distintos según cómo los marcó el docente.
    const alRevés = resolveCourseSelection(["c3", "c1"], catalogo);
    expect(alRevés.names).toEqual(["Programación II", "Paradigmas de Programación"]);
  });

  it("descarta ids que ya no están en el catálogo", () => {
    // Caso real: el curso pasó a la papelera entre la carga de la pantalla y el
    // guardado, o llegó el sentinel "all" del filtro de curso.
    const sel = resolveCourseSelection(["c1", "all", "borrado"], catalogo);
    expect(sel.names).toEqual(["Programación II"]);
    expect(sel.problem).toBeNull();
  });

  it("sin cursos marcados reporta el problema en vez de mandar un campo vacío", () => {
    const sel = resolveCourseSelection([], catalogo);
    expect(sel.problem).toBe("sin-cursos");
    expect(sel.courseNameField).toBe("");
  });

  it("solo ids inexistentes también es 'sin cursos'", () => {
    expect(resolveCourseSelection(["fantasma"], catalogo).problem).toBe("sin-cursos");
  });

  it("deduplica el mismo curso y los nombres que difieren solo en mayúsculas", () => {
    const conDuplicado: TeacherCourseOption[] = [
      ...catalogo,
      { id: "c4", name: "programación ii" },
    ];
    const sel = resolveCourseSelection(["c1", "c1", "c4"], conDuplicado);
    expect(sel.names).toEqual(["Programación II"]);
    expect(sel.courseNameField).toBe("Programación II");
  });

  it("recorta espacios alrededor del nombre e ignora los vacíos", () => {
    const sucio: TeacherCourseOption[] = [
      { id: "c1", name: "  Programación II  " },
      { id: "c2", name: "   " },
    ];
    const sel = resolveCourseSelection(["c1", "c2"], sucio);
    expect(sel.courseNameField).toBe("Programación II");
  });

  it("un nombre con el separador adentro bloquea el guardado y se nombra", () => {
    // Sin este chequeo el edge partiría el nombre en dos que no resuelven y el
    // docente leería "el curso X no existe" sobre un curso que sí ve en la lista.
    const conPipe: TeacherCourseOption[] = [{ id: "c9", name: "Redes | Avanzadas" }];
    const sel = resolveCourseSelection(["c9"], conPipe);
    expect(sel.problem).toBe("nombre-con-separador");
    expect(sel.namesWithSeparator).toEqual(["Redes | Avanzadas"]);
  });

  it("no muta los argumentos", () => {
    const ids = ["c2", "c1"];
    const copiaCatalogo = [...catalogo];
    resolveCourseSelection(ids, catalogo);
    expect(ids).toEqual(["c2", "c1"]);
    expect(catalogo).toEqual(copiaCatalogo);
  });
});

describe("classifyImportOutcome", () => {
  it("cuenta creada", () => {
    expect(classifyImportOutcome({ ok: true })).toBe("creado");
  });

  it("ok con enrolledExisting NO es una cuenta nueva", () => {
    // Es el caso que hacía prometer una contraseña temporal inexistente.
    expect(classifyImportOutcome({ ok: true, enrolledExisting: true })).toBe(
      "matriculado-existente",
    );
  });

  it("ya existía y ya estaba en todos los cursos: informa, no es error", () => {
    expect(
      classifyImportOutcome({
        ok: false,
        duplicate: true,
        reason: "El usuario ya existe y ya estaba matriculado en el curso.",
      }),
    ).toBe("duplicado");
  });

  it("curso inválido u otro rechazo del edge es error", () => {
    expect(classifyImportOutcome({ ok: false, reason: 'El curso "X" no existe' })).toBe("error");
  });

  it("fila ausente es error (el edge responde 200 aunque la fila falle)", () => {
    expect(classifyImportOutcome(undefined)).toBe("error");
    expect(classifyImportOutcome(null)).toBe("error");
    expect(classifyImportOutcome({})).toBe("error");
  });
});

describe("classifyImportOutcome — el fallo de matrícula no es un aviso", () => {
  it("ya existía y la matrícula FALLÓ es error, aunque venga con duplicate", () => {
    // El edge marca los dos flags en ese caso. Si `duplicate` se evaluara primero,
    // un fallo que el docente tiene que reintentar se pintaría como el aviso
    // tranquilo de "ya estaba matriculado".
    expect(
      classifyImportOutcome({
        ok: false,
        duplicate: true,
        enrollFailed: true,
        reason: "El usuario ya existe y no se pudo matricular al curso: …",
      }),
    ).toBe("error");
  });

  it("ya existía y ya estaba matriculado sigue siendo duplicado", () => {
    expect(classifyImportOutcome({ ok: false, duplicate: true })).toBe("duplicado");
  });
});

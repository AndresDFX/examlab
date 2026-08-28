import { describe, expect, it } from "vitest";
import {
  construirPizarraNueva,
  esPropia,
  partirPizarras,
  type PizarraVisible,
} from "./student-whiteboards";

const YO = "11111111-1111-4111-8111-111111111111";
const OTRO = "22222222-2222-4222-8222-222222222222";
const CURSO = "aaaaaaaa-0000-4000-8000-000000000001";

function wb(over: Partial<PizarraVisible> = {}): PizarraVisible {
  return {
    id: over.id ?? "wb-1",
    owner_id: OTRO,
    course_id: CURSO,
    is_shared_with_course: true,
    status: null,
    ...over,
  };
}

describe("esPropia", () => {
  it("es propia cuando el dueño es el usuario", () => {
    expect(esPropia(wb({ owner_id: YO }), YO)).toBe(true);
  });

  it("no es propia cuando el dueño es otro", () => {
    expect(esPropia(wb({ owner_id: OTRO }), YO)).toBe(false);
  });

  it("sin dueño no es propia (no se cae ni la reclama)", () => {
    // Defensivo: owner_id es NOT NULL en la base, pero el select podría no
    // traerlo y `undefined === undefined` daría true, reclamando pizarras ajenas.
    expect(esPropia(wb({ owner_id: null }), YO)).toBe(false);
  });
});

describe("partirPizarras", () => {
  it("separa las propias de las compartidas", () => {
    const r = partirPizarras(
      [
        wb({ id: "mia", owner_id: YO, is_shared_with_course: false }),
        wb({ id: "del-docente", owner_id: OTRO }),
      ],
      YO,
    );
    expect(r.propias.map((x) => x.id)).toEqual(["mia"]);
    expect(r.compartidas.map((x) => x.id)).toEqual(["del-docente"]);
  });

  it("una pizarra propia Y compartida sale UNA vez, en propias", () => {
    // El caso del usuario multi-rol: entra como estudiante y es dueño de las
    // pizarras que creó dictando. Repartir por is_shared_with_course primero la
    // pondría en las dos listas.
    const r = partirPizarras([wb({ id: "x", owner_id: YO, is_shared_with_course: true })], YO);
    expect(r.propias.map((x) => x.id)).toEqual(["x"]);
    expect(r.compartidas).toEqual([]);
  });

  it("a una pizarra PROPIA cerrada por la cascada NO se la esconde", () => {
    // Finalizar el curso cierra sus pizarras. Si el filtro de `closed` se
    // aplicara a lo propio, el estudiante perdería su trabajo el día que el
    // docente cierra el semestre.
    const r = partirPizarras([wb({ id: "mia", owner_id: YO, status: "closed" })], YO);
    expect(r.propias.map((x) => x.id)).toEqual(["mia"]);
  });

  it("a una COMPARTIDA cerrada sí se la esconde", () => {
    const r = partirPizarras([wb({ id: "suya", owner_id: OTRO, status: "closed" })], YO);
    expect(r.compartidas).toEqual([]);
    expect(r.propias).toEqual([]);
  });

  it("esconde las compartidas de un curso en papelera", () => {
    const r = partirPizarras([wb({ id: "suya", owner_id: OTRO })], YO, new Set([CURSO]));
    expect(r.compartidas).toEqual([]);
  });

  it("una pizarra PROPIA de un curso en papelera sigue siendo del estudiante", () => {
    const r = partirPizarras([wb({ id: "mia", owner_id: YO })], YO, new Set([CURSO]));
    expect(r.propias.map((x) => x.id)).toEqual(["mia"]);
  });

  it("sin usuario todavía cargado no reclama nada como propio", () => {
    // Primer render antes de que resuelva la sesión: si `undefined` matcheara,
    // la pantalla mostraría pizarras ajenas como propias (y con botón de borrar).
    const r = partirPizarras([wb({ id: "suya", owner_id: OTRO })], null);
    expect(r.propias).toEqual([]);
    expect(r.compartidas.map((x) => x.id)).toEqual(["suya"]);
  });

  it("preserva el orden que trae la base en cada lista", () => {
    // La pantalla ordena ANTES de partir, así que el reparto no debe reordenar.
    const r = partirPizarras(
      [
        wb({ id: "m1", owner_id: YO }),
        wb({ id: "s1", owner_id: OTRO }),
        wb({ id: "m2", owner_id: YO }),
        wb({ id: "s2", owner_id: OTRO }),
      ],
      YO,
    );
    expect(r.propias.map((x) => x.id)).toEqual(["m1", "m2"]);
    expect(r.compartidas.map((x) => x.id)).toEqual(["s1", "s2"]);
  });

  it("lista vacía devuelve dos listas vacías, no undefined", () => {
    const r = partirPizarras([], YO);
    expect(r).toEqual({ propias: [], compartidas: [] });
  });
});

describe("construirPizarraNueva", () => {
  it("nunca manda is_shared_with_course ni attendance_session_id", () => {
    // El corazón de la función. Si un refactor las agrega, un estudiante estaría
    // pidiéndole a la base publicar a todo el curso, y el único que diría no sería
    // el trigger.
    const p = construirPizarraNueva({ ownerId: "u1", name: "Mi pizarra", courseId: "c1" });
    expect(p).not.toHaveProperty("is_shared_with_course");
    expect(p).not.toHaveProperty("attendance_session_id");
  });

  it("lleva dueño, nombre recortado y descripción", () => {
    const p = construirPizarraNueva({
      ownerId: "u1",
      name: "  Diagrama ER  ",
      description: "  borrador  ",
    });
    expect(p.owner_id).toBe("u1");
    expect(p.name).toBe("Diagrama ER");
    expect(p.description).toBe("borrador");
  });

  it("descripción vacía o de solo espacios va como null, no como cadena vacía", () => {
    expect(
      construirPizarraNueva({ ownerId: "u1", name: "x", description: "   " }).description,
    ).toBeNull();
    expect(construirPizarraNueva({ ownerId: "u1", name: "x" }).description).toBeNull();
  });

  it("sin curso OMITE la columna en vez de mandar null", () => {
    const p = construirPizarraNueva({ ownerId: "u1", name: "x", courseId: null });
    expect(p).not.toHaveProperty("course_id");
  });

  it("con curso la incluye", () => {
    expect(construirPizarraNueva({ ownerId: "u1", name: "x", courseId: "c1" }).course_id).toBe(
      "c1",
    );
  });
});

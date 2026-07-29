import { describe, expect, it } from "vitest";
import { flattenSharedActivities } from "./statistics";

/**
 * `flattenSharedActivities` resuelve, para UN curso, las actividades que le
 * pertenecen según la tabla M:N (`workshop_courses` / `project_courses`).
 *
 * El bug que motiva estos tests: el dashboard leía talleres y proyectos por
 * `workshops.course_id`, que es el curso ANCLA legacy. Un taller compartido
 * entre 3 cursos aparecía solo en UNO; los otros dos calculaban aprobación,
 * distribución de notas y alerta temprana SIN esa actividad, en silencio.
 */

const wc = (
  workshop: Record<string, unknown> | null,
  extra: Record<string, unknown> = {},
) => ({ cut_id: null, weight: null, workshop, ...extra });

describe("flattenSharedActivities", () => {
  it("resuelve el item del embed y le pone el curso pedido", () => {
    const out = flattenSharedActivities(
      [wc({ id: "w1", cut_id: "cutA", max_score: 5, is_external: false, status: "published" })],
      "workshop",
      "cursoB",
    );
    expect(out).toHaveLength(1);
    // El curso es el que se está resolviendo, NO el ancla del taller: es
    // justamente lo que arregla el bug del taller compartido.
    expect(out[0].course_id).toBe("cursoB");
    expect(out[0].id).toBe("w1");
  });

  it("el cut_id del JOIN gana sobre el del taller (corte POR CURSO)", () => {
    // Es la razón de existir de la tabla M:N: el mismo taller puede caer en un
    // corte distinto en cada curso.
    const out = flattenSharedActivities(
      [
        wc(
          { id: "w1", cut_id: "corte-del-taller", max_score: 5, is_external: false, status: "published" },
          { cut_id: "corte-de-este-curso" },
        ),
      ],
      "workshop",
      "c1",
    );
    expect(out[0].cut_id).toBe("corte-de-este-curso");
  });

  it("cae al cut_id del taller cuando el JOIN no lo trae (legacy)", () => {
    const out = flattenSharedActivities(
      [wc({ id: "w1", cut_id: "legacy", max_score: 5, is_external: false, status: "published" })],
      "workshop",
      "c1",
    );
    expect(out[0].cut_id).toBe("legacy");
  });

  it("sin cut_id en ninguna punta → null, no undefined", () => {
    const out = flattenSharedActivities(
      [wc({ id: "w1", max_score: 5, is_external: false, status: "published" })],
      "workshop",
      "c1",
    );
    expect(out[0].cut_id).toBeNull();
  });

  it("descarta borradores", () => {
    const out = flattenSharedActivities(
      [
        wc({ id: "w1", max_score: 5, is_external: false, status: "draft" }),
        wc({ id: "w2", max_score: 5, is_external: false, status: "published" }),
      ],
      "workshop",
      "c1",
    );
    expect(out.map((x) => x.id)).toEqual(["w2"]);
  });

  it("descarta lo que está en la papelera", () => {
    // El filtro va en JS porque PostgREST no filtra cómodo dentro de un embed
    // anidado. Si esto se rompe, un taller borrado reaparece en el % del curso.
    const out = flattenSharedActivities(
      [
        wc({
          id: "w1",
          max_score: 5,
          is_external: false,
          status: "published",
          deleted_at: "2026-01-01T00:00:00Z",
        }),
      ],
      "workshop",
      "c1",
    );
    expect(out).toEqual([]);
  });

  it("descarta filas con el embed vacío (la RLS no devolvió el item)", () => {
    // Contarla inflaría el denominador con algo que el usuario no puede ver.
    const out = flattenSharedActivities([wc(null)], "workshop", "c1");
    expect(out).toEqual([]);
  });

  it("descarta un embed sin id (dato defectuoso, no revienta)", () => {
    const out = flattenSharedActivities(
      [wc({ max_score: 5, is_external: false, status: "published" })],
      "workshop",
      "c1",
    );
    expect(out).toEqual([]);
  });

  it("null / undefined / vacío → lista vacía", () => {
    expect(flattenSharedActivities(null, "workshop", "c1")).toEqual([]);
    expect(flattenSharedActivities(undefined, "workshop", "c1")).toEqual([]);
    expect(flattenSharedActivities([], "workshop", "c1")).toEqual([]);
  });

  it("cerrado SÍ cuenta (fue una actividad real que se cerró)", () => {
    const out = flattenSharedActivities(
      [wc({ id: "w1", max_score: 5, is_external: false, status: "closed" })],
      "workshop",
      "c1",
    );
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe("closed");
  });

  it("preserva el peso POR CURSO del join", () => {
    const out = flattenSharedActivities(
      [
        wc(
          { id: "w1", max_score: 5, is_external: false, status: "published" },
          { weight: 12.5 },
        ),
      ],
      "workshop",
      "c1",
    );
    expect(out[0].weight).toBe(12.5);
  });

  it("funciona igual con la clave 'project'", () => {
    const rows = [
      { cut_id: "c", weight: 3, project: { id: "p1", max_score: 100, is_external: true, status: "published" } },
    ];
    const out = flattenSharedActivities(rows, "project", "c1");
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("p1");
    expect(out[0].is_external).toBe(true);
    expect(out[0].max_score).toBe(100);
  });

  it("varias filas del MISMO curso se resuelven todas", () => {
    const out = flattenSharedActivities(
      [
        wc({ id: "w1", max_score: 5, is_external: false, status: "published" }),
        wc({ id: "w2", max_score: 5, is_external: false, status: "published" }),
        wc({ id: "w3", max_score: 5, is_external: false, status: "closed" }),
      ],
      "workshop",
      "c1",
    );
    expect(out).toHaveLength(3);
  });
});

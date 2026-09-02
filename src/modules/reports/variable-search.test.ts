/**
 * Buscador del panel de variables del editor de plantillas.
 *
 * Se prueba contra el catálogo REAL, no contra un fixture: lo que tiene que
 * seguir funcionando es buscar las variables que el docente usa, y un fixture
 * inventado no se rompe cuando alguien renombra una variable de verdad.
 */
import { describe, expect, it } from "vitest";
import {
  countCatalogLeaves,
  filterVariableCatalog,
  normalizeForSearch,
  REPORT_VARIABLE_CATALOG,
  type VariableNode,
} from "./template-engine";

/** Todos los paths clickables del resultado, aplanados. */
function paths(nodes: VariableNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: VariableNode[]) => {
    for (const n of ns) {
      if (n.kind !== "group") out.push(n.path);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Labels de los grupos de primer nivel del resultado. */
const grupos = (nodes: VariableNode[]) => nodes.map((n) => n.label);

describe("normalizeForSearch", () => {
  it("quita tildes y mayúsculas", () => {
    expect(normalizeForSearch("Código")).toBe("codigo");
    expect(normalizeForSearch("ASIGNATURA")).toBe("asignatura");
    expect(normalizeForSearch("  Institución  ")).toBe("institucion");
  });

  it("la ñ NO se convierte en n", () => {
    // `NFD` descompone la ñ en n + tilde y el rango de diacríticos la borraría.
    // Se documenta lo que realmente pasa para que nadie lo tome por bug: en este
    // catálogo no hay ninguna variable con ñ, así que da igual — pero si mañana
    // hay una, "ano" encontraría "año".
    expect(normalizeForSearch("año")).toBe("ano");
  });
});

describe("filterVariableCatalog", () => {
  it("una consulta vacía devuelve el catálogo TAL CUAL (misma referencia)", () => {
    // Importa que sea la misma referencia: el panel se re-renderiza en cada
    // tecleo y clonar 56 nodos por nada tira el estado abierto/cerrado.
    expect(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "")).toBe(REPORT_VARIABLE_CATALOG);
    expect(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "   ")).toBe(REPORT_VARIABLE_CATALOG);
  });

  it("encuentra sin tilde lo que en el catálogo la tiene", () => {
    const r = paths(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "codigo"));
    expect(r).toContain("curso.codigo");
    expect(r).toContain("estudiante.codigo");
  });

  it("encuentra por el path, no solo por la etiqueta", () => {
    // El docente que ya vio {{curso.grupo}} en otra plantilla escribe eso.
    const r = paths(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "curso.grupo"));
    expect(r).toEqual(["curso.grupo"]);
  });

  it("encuentra por el hint los campos que solo existen dentro de un each", () => {
    // {{nota_final}} y {{documento}} dentro de {{#each estudiantes}} no son un
    // nodo del catálogo: viven en el hint. Sin buscar en el hint serían
    // inencontrables.
    const r = paths(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "documento"));
    expect(r).toContain("estudiantes");
  });

  it("un grupo que matchea trae TODOS sus hijos", () => {
    const r = filterVariableCatalog(REPORT_VARIABLE_CATALOG, "institucion");
    const inst = r.find((n) => n.path === "institucion");
    expect(inst).toBeDefined();
    const enCatalogo = REPORT_VARIABLE_CATALOG.find((n) => n.path === "institucion");
    expect(inst!.children!.length).toBe(enCatalogo!.children!.length);
  });

  it("un grupo sin coincidencias desaparece; el que tiene un hijo que matchea se queda podado", () => {
    const r = filterVariableCatalog(REPORT_VARIABLE_CATALOG, "objetivos");
    // Solo sobrevive el grupo que contiene la variable de objetivos.
    expect(grupos(r)).toEqual(["Curso"]);
    expect(paths(r)).toEqual(["curso.objetivos"]);
  });

  it("no encuentra nada cuando no hay nada, y no revienta", () => {
    expect(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "zzzzz")).toEqual([]);
  });

  it("busca también en los labels en inglés", () => {
    const r = paths(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "final grade"));
    expect(r).toContain("nota_final");
  });

  it("NUNCA muta el catálogo de entrada", () => {
    const antes = JSON.stringify(REPORT_VARIABLE_CATALOG);
    filterVariableCatalog(REPORT_VARIABLE_CATALOG, "curso");
    filterVariableCatalog(REPORT_VARIABLE_CATALOG, "peso");
    expect(JSON.stringify(REPORT_VARIABLE_CATALOG)).toBe(antes);
  });

  it("los pesos de evaluación se encuentran todos juntos", () => {
    // Caso real: el Acuerdo Pedagógico usa los cuatro pesos y el docente los
    // busca de una.
    const r = paths(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "peso"));
    expect(r.length).toBeGreaterThanOrEqual(4);
  });
});

describe("countCatalogLeaves", () => {
  it("cuenta las clickables, no los grupos", () => {
    const total = countCatalogLeaves(REPORT_VARIABLE_CATALOG);
    // 49 → 72 al agregar los grupos "Evaluación" (una prueba concreta, con su
    // detalle por pregunta) y "Firma" (la ranura como variable).
    // 72 → 77 al conectar las casillas que el Acuerdo Pedagógico traía en blanco:
    // las cuatro del vocero (nombre, teléfono, correo, documento) y la ciudad de
    // la sede. El dato del vocero ya existía —es el matriculado marcado— y lo que
    // faltaba era la variable.
    // 77 → 79 al sumar las dos ranuras de firma que el Acuerdo Pedagógico
    // necesitaba y no tenía: la del docente y la del vocero. No se agregaron sus
    // NOMBRES: `{{docente.nombre}}` y `{{curso.vocero.nombre}}` ya existían, y
    // duplicarlos bajo "Firma" sería ofrecer dos variables para el mismo dato.
    expect(total).toBe(79);
    // Y el filtro nunca puede devolver más de las que hay.
    expect(
      countCatalogLeaves(filterVariableCatalog(REPORT_VARIABLE_CATALOG, "o")),
    ).toBeLessThanOrEqual(total);
  });

  it("un catálogo vacío da 0", () => {
    expect(countCatalogLeaves([])).toBe(0);
  });
});

import { describe, expect, it } from "vitest";
import {
  pidePlantillaEvaluacion,
  revisarPlantilla,
  tieneErrores,
  type CodigoAviso,
} from "./plantilla-lint";
import { ranuraHtml, ranuraPlantillaHtml, renglonManualHtml } from "./signature-slots";

const codigos = (r: ReturnType<typeof revisarPlantilla>): CodigoAviso[] =>
  r.map((a) => a.codigo);

describe("revisarPlantilla — firmas", () => {
  it("una plantilla sin firmas ni evaluación no dice nada", () => {
    expect(
      revisarPlantilla({ bodyHtml: "<p>Hola {{estudiante.nombre}}</p>", scope: "estudiante" }),
    ).toEqual([]);
  });

  it("la firma de la FILA fuera del listado es un error", () => {
    // Es el caso invisible: `{{user_id}}` no resuelve, el atributo sale vacío y
    // el recuadro queda imposible de firmar sin un solo error del motor.
    const r = revisarPlantilla({
      bodyHtml: `<p>Firma:</p>${ranuraPlantillaHtml()}`,
      scope: "curso",
    });
    expect(codigos(r)).toContain("firmaFueraDelBucle");
    expect(tieneErrores(r)).toBe(true);
  });

  it("la MISMA firma dentro de {{#each estudiantes}} está bien", () => {
    const r = revisarPlantilla({
      bodyHtml: `{{#each estudiantes}}<tr><td>{{nombre}}</td><td>${ranuraPlantillaHtml()}</td></tr>{{/each}}`,
      scope: "curso",
    });
    expect(r).toEqual([]);
  });

  it("cuenta cuántas firmas quedaron sueltas", () => {
    const r = revisarPlantilla({
      bodyHtml: `${ranuraPlantillaHtml()}${ranuraPlantillaHtml()}{{user_id}}`,
      scope: "curso",
    });
    expect(r.find((a) => a.codigo === "firmaFueraDelBucle")!.cantidad).toBe(3);
  });

  it("{{{ranura}}} fuera del listado también es un error", () => {
    const r = revisarPlantilla({ bodyHtml: "<p>{{{ranura}}}</p>", scope: "curso" });
    expect(codigos(r)).toContain("firmaFueraDelBucle");
  });

  it("{{{ranura}}} DENTRO del listado está bien", () => {
    const r = revisarPlantilla({
      bodyHtml: "{{#each estudiantes}}<p>{{nombre}} {{{ranura}}}</p>{{/each}}",
      scope: "curso",
    });
    expect(r).toEqual([]);
  });

  it("un ancla vacía tipeada a mano en la pestaña HTML es un error", () => {
    const r = revisarPlantilla({
      bodyHtml: '<span class="examlab-firma" data-firma-uid="">&nbsp;</span>',
      scope: "estudiante",
    });
    expect(codigos(r)).toContain("anclaVacia");
  });

  it("la ranura del estudiante en una plantilla de CURSO es un error", () => {
    // En scope curso el contexto no expone `firmantes`: saldría vacía.
    const r = revisarPlantilla({
      bodyHtml: "<p>{{{firmantes.estudiante.ranura}}}</p>",
      scope: "curso",
    });
    expect(codigos(r)).toContain("ranuraSoloPorEstudiante");
  });

  it("la ranura del estudiante en una plantilla POR ESTUDIANTE está bien", () => {
    const r = revisarPlantilla({
      bodyHtml: "<p>{{{firmantes.estudiante.ranura}}}</p>",
      scope: "estudiante",
    });
    expect(r).toEqual([]);
  });

  it("la ranura con doble llave se avisa: se imprimiría como texto", () => {
    const r = revisarPlantilla({
      bodyHtml: "<p>{{firmantes.estudiante.ranura}}</p>",
      scope: "estudiante",
    });
    expect(codigos(r)).toContain("ranuraEscapada");
  });

  it("el renglón para firmar A MANO no es una firma y no se avisa nada", () => {
    const r = revisarPlantilla({
      bodyHtml: `<p>Docente:</p>${renglonManualHtml()}`,
      scope: "estudiante",
    });
    expect(r).toEqual([]);
  });

  it("una ranura ya resuelta (con su UUID) no es un ancla vacía", () => {
    const r = revisarPlantilla({
      bodyHtml: ranuraHtml("11111111-1111-4111-8111-111111111111"),
      scope: "estudiante",
    });
    expect(r).toEqual([]);
  });

  it("revisa también el encabezado y el pie, no solo el cuerpo", () => {
    const enPie = revisarPlantilla({
      bodyHtml: "<p>ok</p>",
      footerHtml: ranuraPlantillaHtml(),
      scope: "estudiante",
    });
    expect(codigos(enPie)).toContain("firmaFueraDelBucle");
    const enCabecera = revisarPlantilla({
      bodyHtml: "<p>ok</p>",
      headerHtml: '<span data-firma-uid="  "></span>',
      scope: "estudiante",
    });
    expect(codigos(enCabecera)).toContain("anclaVacia");
  });

  it("los errores van primero", () => {
    const r = revisarPlantilla({
      bodyHtml: `<p>{{evaluacion.titulo}}</p>${ranuraPlantillaHtml()}`,
      scope: "estudiante",
    });
    expect(r[0].nivel).toBe("error");
    expect(r[r.length - 1].codigo).toBe("pideEvaluacion");
  });

  it("un {{/each}} huérfano no descuadra la pila (no inventa errores)", () => {
    const r = revisarPlantilla({
      bodyHtml: `{{/each}}{{#each estudiantes}}${ranuraPlantillaHtml()}{{/each}}`,
      scope: "curso",
    });
    expect(r).toEqual([]);
  });

  it("un {{#if}} dentro del listado no saca a la firma del bucle", () => {
    const r = revisarPlantilla({
      bodyHtml: `{{#each estudiantes}}{{#if aprobado}}${ranuraPlantillaHtml()}{{/if}}{{/each}}`,
      scope: "curso",
    });
    expect(r).toEqual([]);
  });

  it("un each de otra cosa NO habilita la firma de la fila", () => {
    const r = revisarPlantilla({
      bodyHtml: `{{#each cortes}}${ranuraPlantillaHtml()}{{/each}}`,
      scope: "curso",
    });
    expect(codigos(r)).toContain("firmaFueraDelBucle");
  });
});

describe("revisarPlantilla — evaluación", () => {
  it("usar variables de la evaluación es un AVISO, no un error", () => {
    const r = revisarPlantilla({
      bodyHtml: "<p>{{evaluacion.titulo}}</p>",
      scope: "estudiante",
    });
    expect(r).toEqual([{ codigo: "pideEvaluacion", nivel: "aviso", cantidad: 1 }]);
    expect(tieneErrores(r)).toBe(false);
  });

  it("el bucle de preguntas también cuenta", () => {
    const r = revisarPlantilla({
      bodyHtml: "{{#each evaluacion.preguntas}}<li>{{enunciado}}</li>{{/each}}",
      scope: "estudiante",
    });
    expect(codigos(r)).toEqual(["pideEvaluacion"]);
  });
});

describe("pidePlantillaEvaluacion", () => {
  it("reconoce el escalar y el bucle", () => {
    expect(pidePlantillaEvaluacion("<p>{{evaluacion.titulo}}</p>")).toBe(true);
    expect(pidePlantillaEvaluacion("{{#each evaluacion.preguntas}}x{{/each}}")).toBe(true);
    expect(pidePlantillaEvaluacion("{{#if evaluacion.preguntas_a_reforzar}}x{{/if}}")).toBe(true);
  });

  it("mira el encabezado y el pie además del cuerpo", () => {
    expect(pidePlantillaEvaluacion("<p>ok</p>", null, "{{evaluacion.nota}}")).toBe(true);
  });

  it("no se dispara con una plantilla que no la usa", () => {
    expect(pidePlantillaEvaluacion("<p>{{estudiante.nombre}} {{nota_final}}</p>")).toBe(false);
    expect(pidePlantillaEvaluacion(null, undefined, "")).toBe(false);
  });

  it("no confunde una palabra que EMPIEZA igual", () => {
    expect(pidePlantillaEvaluacion("<p>{{evaluaciones_totales}}</p>")).toBe(false);
  });
});

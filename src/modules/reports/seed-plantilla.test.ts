/**
 * Guardrail del contrato entre la plantilla SEMBRADA y el contexto que la llena.
 *
 * ── Por qué es un test y no una convención escrita ────────────────────
 * El cuerpo de la plantilla global vive en una migración (el SQL no puede leer
 * TypeScript, así que no hay forma de compartir el texto) y las variables que
 * resuelven viven acá. El motor VACÍA en silencio cualquier token que no exista:
 * si alguien renombra una variable del catálogo, la plantilla sembrada empieza a
 * imprimir huecos en blanco en el documento de un estudiante, sin un solo error
 * en ninguna consola.
 *
 * Este test lee la migración del DISCO y valida cada token contra la lista
 * congelada — el mismo patrón que `tutor-default-prompt.test.ts` usa para el
 * prompt del Tutor IA. Es una LECTURA: no escribe nada en `supabase/`.
 *
 * Si el test falla, la respuesta correcta casi nunca es agregar el token a la
 * lista: es que la plantilla usa una variable que el contexto no entrega.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REPORT_VARIABLE_CATALOG,
  buildSampleReportContext,
  flattenCatalogPaths,
  renderTemplate,
} from "./template-engine";
import { revisarPlantilla } from "./plantilla-lint";
import { CLASE_RANURA, renderizarRanuras, tieneRanuras } from "./signature-slots";

const MIGRACION = resolve(
  __dirname,
  "../../../supabase/migrations/20261980000000_informe_evaluacion_template.sql",
);

/** Tokens que la plantilla sembrada PUEDE usar. Contrato congelado. */
const PERMITIDOS = new Set<string>([
  // Ya existentes en el contexto.
  "institucion.nombre",
  "institucion.logo",
  "curso.nombre",
  "curso.codigo",
  "curso.grupo",
  "docente.nombre",
  "periodo",
  "fecha_emision",
  "escala_max",
  "estudiante.nombre",
  "estudiante.codigo",
  "estudiante.programa",
  // Nuevos, de la evaluación elegida al generar.
  "evaluacion.titulo",
  "evaluacion.tipo",
  "evaluacion.fecha_entrega",
  "evaluacion.puntaje_obtenido",
  "evaluacion.puntaje_total",
  "evaluacion.nota",
  "evaluacion.aporte_nota_final",
  "evaluacion.respondidas",
  "evaluacion.comentario_docente",
  "evaluacion.grupo.promedio_curso",
  "evaluacion.total_preguntas",
  "evaluacion.correctas",
  "evaluacion.parciales",
  "evaluacion.incorrectas",
  "evaluacion.sin_responder",
  // Campos DENTRO de un bucle de preguntas.
  "numero",
  "enunciado",
  "respuesta",
  "respuesta_correcta",
  "obtenido",
  "puntos",
  "retroalimentacion",
  "resultado",
  "porcentaje_curso",
  // Bucles y condicionales.
  "#each evaluacion.preguntas",
  "#each evaluacion.preguntas_a_reforzar",
  "#if evaluacion.preguntas_a_reforzar",
  "#if institucion.logo",
  "/each",
  "/if",
  // La firma, la única con triple llave.
  "firmantes.estudiante.ranura",
]);

/** Tokens PROHIBIDOS en la plantilla que se le entrega al estudiante. */
const PROHIBIDOS = [
  // Es la clave de respuestas.
  "criterio_docente",
  // Solo resuelven dentro de {{#each estudiantes}}, que esta plantilla no usa.
  "ranura",
  "user_id",
  "estudiante.user_id",
  "docente.user_id",
];

const hayMigracion = existsSync(MIGRACION);
const sql = hayMigracion ? readFileSync(MIGRACION, "utf8").replace(/\r\n/g, "\n") : "";

/** Contenido de un bloque `$tag$…$tag$` de la migración. */
function bloque(tag: string): string {
  const abre = `$${tag}$`;
  const i = sql.indexOf(abre);
  if (i < 0) return "";
  const j = sql.indexOf(abre, i + abre.length);
  if (j < 0) return "";
  return sql.slice(i + abre.length, j);
}

/** Todos los tokens del texto, con el `{{`/`{{{` ya quitado. */
function tokens(texto: string): string[] {
  const re = /\{\{\{[\s\S]+?\}\}\}|\{\{[\s\S]+?\}\}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const tag = m[0];
    out.push(tag.startsWith("{{{") ? tag.slice(3, -3).trim() : tag.slice(2, -2).trim());
  }
  return out;
}

describe.skipIf(!hayMigracion)("plantilla sembrada «Informe de evaluación»", () => {
  const cuerpo = bloque("body");
  const cabecera = bloque("head");
  const pie = bloque("foot");
  const todo = [cuerpo, cabecera, pie].join("\n");

  it("la migración trae los tres bloques del documento", () => {
    expect(cuerpo.length).toBeGreaterThan(200);
    expect(cabecera.length).toBeGreaterThan(50);
    expect(pie.length).toBeGreaterThan(10);
  });

  it("TODOS los tokens están en la lista congelada", () => {
    const desconocidos = [...new Set(tokens(todo))].filter((t) => !PERMITIDOS.has(t));
    // Si esto falla, la plantilla usa una variable que el contexto NO entrega:
    // el documento la imprimiría VACÍA sin avisar.
    expect(desconocidos).toEqual([]);
  });

  it("no usa nada de lo prohibido en un documento que recibe el estudiante", () => {
    for (const p of PROHIBIDOS) {
      expect(tokens(todo), `token prohibido: ${p}`).not.toContain(p);
    }
  });

  it("la firma del estudiante aparece UNA sola vez, con triple llave", () => {
    const conTriple = (todo.match(/\{\{\{firmantes\.estudiante\.ranura\}\}\}/g) ?? []).length;
    expect(conTriple).toBe(1);
    // Con doble llave el motor la escaparía y el documento mostraría la etiqueta
    // escrita en letras.
    expect(todo).not.toMatch(/\{\{firmantes\.estudiante\.ranura\}\}(?!\})/);
  });

  it("el renglón para firmar a mano NO se llama como la ranura firmable", () => {
    // `tieneRanuras` compara por SUBSTRING: un `examlab-firma-manual` haría que la
    // app ofrezca "enviar a firmar" un documento sin una sola ranura firmable.
    expect(todo).toContain("examlab-renglon");
    expect(todo).not.toContain("examlab-firma-manual");
    // La única clase `examlab-firma` del documento la pone la variable de la
    // ranura al resolverse, no el texto de la plantilla.
    expect(todo).not.toContain('class="examlab-firma"');
  });

  it("el logo va dentro de un condicional (un logo vacío pinta una imagen rota)", () => {
    const img = todo.indexOf("{{institucion.logo}}");
    const cond = todo.indexOf("{{#if institucion.logo}}");
    expect(cond).toBeGreaterThanOrEqual(0);
    expect(cond).toBeLessThan(img);
  });

  it("la revisión de plantillas no encuentra ni un error en la sembrada", () => {
    const avisos = revisarPlantilla({
      bodyHtml: cuerpo,
      headerHtml: cabecera,
      footerHtml: pie,
      scope: "estudiante",
    });
    expect(avisos.filter((a) => a.nivel === "error")).toEqual([]);
    // Sí avisa que al generar hay que elegir la evaluación: es lo que hace que el
    // generador muestre ese selector.
    expect(avisos.map((a) => a.codigo)).toContain("pideEvaluacion");
  });

  it("se renderiza COMPLETA con el contexto: no queda ni un token sin resolver", () => {
    // Es la prueba de que el contrato cierra por los dos lados: la plantilla que
    // vive en el SQL y las variables que vive acá.
    const ctx = buildSampleReportContext();
    const salida = [cabecera, cuerpo, pie].map((p) => renderTemplate(p, ctx)).join("\n");
    expect(salida).not.toContain("{{");
    expect(salida).not.toContain("undefined");
    // Los datos de la evaluación llegaron de verdad.
    expect(salida).toContain("Prueba diagnóstica");
    expect(salida).toContain("¿Cómo se representa una relación de muchos a muchos?");
    // El criterio de corrección (la clave de respuestas) NO sale en el documento.
    expect(salida).not.toContain("Debe mencionar la tabla intermedia");
  });

  it("la firma queda como una ranura REAL, anclada y firmable", () => {
    const ctx = buildSampleReportContext();
    const salida = renderTemplate(cuerpo, ctx);
    // Marcado real, no la etiqueta escrita en letras.
    expect(salida).toContain(`class="${CLASE_RANURA}"`);
    expect(salida).not.toContain("&lt;span");
    expect(tieneRanuras(salida)).toBe(true);
    // Y con un ancla que no está vacía: si lo estuviera, el recuadro se vería
    // igual y nadie podría firmarlo nunca.
    expect(salida).not.toContain('data-firma-uid=""');
    // Quien mira ve el botón en SU ranura.
    const conBoton = renderizarRanuras(salida, {
      firmanteId: "11111111-1111-4111-8111-111111111111",
      etiquetaFirmar: "Firmar aquí",
    });
    expect(conBoton).toContain("Firmar aquí");
    // Y el renglón del docente sigue siendo un renglón, sin botón.
    expect((conBoton.match(/Firmar aquí/g) ?? []).length).toBe(1);
  });

  it("se siembra como plantilla GLOBAL y por estudiante", () => {
    // Global = sin dueño, sin curso y sin base. `report_templates` NO tiene
    // `tenant_id`: la ausencia de esa columna ES el mecanismo de "para todas las
    // instituciones", y asumirla tumbó un deploy.
    expect(sql).toContain("owner_id IS NULL");
    expect(sql).toContain("course_id IS NULL");
    expect(sql).toContain("parent_id IS NULL");
    // Sobre el SQL sin comentarios: la migración SÍ menciona la columna en su
    // encabezado para explicar por qué no existe, y eso no es usarla.
    const sinComentarios = sql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(sinComentarios).not.toContain("tenant_id");
    expect(sql).toContain("Informe de evaluación");
    expect(sql).toContain("'estudiante'");
  });
});

describe("catálogo de variables — paths congelados", () => {
  const paths = new Set(flattenCatalogPaths(REPORT_VARIABLE_CATALOG));

  it("expone la evaluación con los nombres del contrato", () => {
    for (const p of [
      "evaluacion.titulo",
      "evaluacion.tipo",
      "evaluacion.fecha_entrega",
      "evaluacion.estado",
      "evaluacion.puntaje_obtenido",
      "evaluacion.puntaje_total",
      "evaluacion.nota",
      "evaluacion.aporte_nota_final",
      "evaluacion.respondidas",
      "evaluacion.comentario_docente",
      "evaluacion.grupo.promedio_curso",
      "evaluacion.total_preguntas",
      "evaluacion.correctas",
      "evaluacion.parciales",
      "evaluacion.incorrectas",
      "evaluacion.sin_responder",
      "evaluacion.preguntas",
      "evaluacion.preguntas_a_reforzar",
      "evaluacion.preguntas_correctas",
      "criterio_docente",
    ]) {
      expect(paths, `falta en el catálogo: ${p}`).toContain(p);
    }
  });

  it("expone la firma como variable, y las dos ranuras son CRUDAS", () => {
    expect(paths).toContain("firmantes.estudiante.ranura");
    expect(paths).toContain("firmantes.estudiante.nombre");
    expect(paths).toContain("ranura");
    const firma = REPORT_VARIABLE_CATALOG.find((n) => n.path === "firmantes");
    expect(firma).toBeDefined();
    const ranuras = (firma!.children ?? []).filter((n) => n.path.endsWith("ranura"));
    expect(ranuras).toHaveLength(2);
    // Sin `raw`, el editor insertaría `{{…}}` y el marcado saldría escapado como
    // texto visible en el documento.
    for (const r of ranuras) expect(r.raw, `${r.path} debe ser cruda`).toBe(true);
    // El nombre NO es marcado: se escapa como cualquier dato de la base.
    const nombre = (firma!.children ?? []).find((n) => n.path.endsWith("nombre"));
    expect(nombre?.raw).toBeUndefined();
  });

  it("NO expone ningún identificador de usuario como variable clickable", () => {
    // Un UUID a la vista no le sirve a nadie (P6) y es el ancla de la ranura, que
    // ya viaja resuelta dentro del valor.
    expect(paths).not.toContain("estudiante.user_id");
    expect(paths).not.toContain("docente.user_id");
    expect(paths).not.toContain("user_id");
  });
});

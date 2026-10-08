import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Lee las pantallas del disco: lo que se vigila es el ORDEN de las escrituras
// al entregar, que ningún tipo puede expresar. La noche del 5 de octubre de
// 2026 la entrega se marcaba `entregado` primero y seguía de largo cuando una
// respuesta no se guardaba: se calificaba con lo que había en pantalla, se
// mostraba «entregado» y se borraba el borrador local. Se perdieron
// respuestas de varios estudiantes.
const leer = (ruta: string) => readFileSync(resolve(process.cwd(), ruta), "utf8");

const CASOS = [
  {
    nombre: "taller",
    archivo: "src/modules/workshops/WorkshopQuestions.tsx",
    tabla: "workshop_submission_answers",
    errores: "upsertErrors",
  },
  {
    nombre: "proyecto",
    archivo: "src/modules/projects/ProjectFiles.tsx",
    tabla: "project_submission_files",
    errores: "fallosAlGuardar",
  },
];

describe.each(CASOS)("entrega de $nombre: primero las respuestas, después «entregado»", (caso) => {
  const fuente = leer(caso.archivo);
  // El primer UPSERT a la tabla de respuestas (antes hay lecturas, no escrituras).
  const posGuardado = fuente.search(new RegExp(`\\.from\\("${caso.tabla}"\\)\\s*\\.upsert`));
  const marcaEntregado = fuente.indexOf('status: "entregado"');
  const corte = fuente.indexOf(`if (${caso.errores}.length > 0)`);
  const borrarBorrador = fuente.indexOf("borrarBorradorLocal(");

  it("una entrega nueva nace en `en_progreso`, sin `submitted_at`", () => {
    const insert = fuente.match(/\.insert\(\{[^}]*?status: "en_progreso"[^}]*?\}/);
    expect(insert).not.toBeNull();
    // `submitted_at` es lo que leen, por ejemplo, los requisitos de asistencia:
    // en el INSERT, un envío que después falla contaría como cumplido.
    expect(insert![0]).not.toMatch(/submitted_at/);
    // Hay UNA sola escritura de `entregado`: la que va después del guardado.
    expect(fuente.split('status: "entregado"').length - 1).toBe(1);
  });

  it("`entregado` se escribe DESPUÉS de guardar las respuestas", () => {
    expect(posGuardado).toBeGreaterThan(-1);
    expect(marcaEntregado).toBeGreaterThan(posGuardado);
  });

  it("si una respuesta no se guarda, se corta antes de marcar, calificar y borrar el borrador", () => {
    expect(corte).toBeGreaterThan(posGuardado);
    expect(corte).toBeLessThan(marcaEntregado);
    const bloque = fuente.slice(corte, marcaEntregado);
    expect(bloque).toMatch(/return;/);
    expect(bloque).toMatch(/answers_save_failed/);
    expect(borrarBorrador).toBeGreaterThan(marcaEntregado);
  });

  it("si el UPDATE a `entregado` falla (o no toca ninguna fila), también se corta", () => {
    const tramo = fuente.slice(marcaEntregado, borrarBorrador);
    expect(tramo).toMatch(/if \(updErr \|\| !marcadas\?\.length\) \{[^}]*return;/);
  });

  it("nada se manda a calificar antes de quedar `entregado`", () => {
    const desdeGuardado = fuente.slice(posGuardado);
    const primeraCalificacion = desdeGuardado.search(/enqueue_ai_grading|"ai-grade-submission"/);
    expect(primeraCalificacion).toBeGreaterThan(-1);
    expect(posGuardado + primeraCalificacion).toBeGreaterThan(marcaEntregado);
  });
});

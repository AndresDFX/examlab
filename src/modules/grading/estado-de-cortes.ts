/**
 * En qué punto va cada corte, DESDE LAS NOTAS y no desde las fechas: el
 * estudiante piensa «ya me calificaron el corte 1», no «hoy es 3 de octubre».
 *
 * - Un corte TIENE NOTAS si alguna actividad suya (examen, taller, proyecto)
 *   ya tiene nota. La asistencia no cuenta para eso: se calcula sola con las
 *   sesiones que se dieron, así que un corte recién empezado sale con «0,00»
 *   de asistencia sin que se haya calificado nada — y ese 0,00 suelto es justo
 *   lo que hacía creer que el corte ya estaba perdido.
 * - El corte ACTUAL es el último (en orden) que tiene notas. Si ninguno tiene,
 *   es el primero: el semestre arranca ahí.
 */
export type KindDeNota = "exam" | "workshop" | "project" | "attendance";

export interface ItemDeCorte {
  kind: KindDeNota;
  grade: number | null;
}

export type EstadoDeCorte = "actual" | "con_notas" | "sin_notas";

export interface ResumenDeCorte {
  estado: EstadoDeCorte;
  /** Hay al menos una actividad (no asistencia) con nota. */
  conNotas: boolean;
  /** Por tipo: cuántas hay y cuántas tienen nota. Solo los tipos presentes. */
  porTipo: Array<{ kind: KindDeNota; total: number; conNota: number }>;
}

const ORDEN: KindDeNota[] = ["exam", "workshop", "project", "attendance"];

export function resumirCortes(cortes: ReadonlyArray<ReadonlyArray<ItemDeCorte>>): ResumenDeCorte[] {
  const conNotas = cortes.map((items) => items.some((i) => i.kind !== "attendance" && i.grade != null));
  let actual = conNotas.lastIndexOf(true);
  if (actual < 0) actual = 0;
  return cortes.map((items, idx) => ({
    estado: idx === actual ? "actual" : conNotas[idx] ? "con_notas" : "sin_notas",
    conNotas: conNotas[idx],
    porTipo: ORDEN.map((kind) => {
      const deTipo = items.filter((i) => i.kind === kind);
      return { kind, total: deTipo.length, conNota: deTipo.filter((i) => i.grade != null).length };
    }).filter((x) => x.total > 0),
  }));
}

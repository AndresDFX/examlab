/**
 * Helper PURO para el desglose de evaluación POR COHORTE del tablero del
 * estudiante (#33). Agrupa las filas crudas que devuelve el RPC
 * `get_course_cohort_weights` (una por cohorte × actividad asignada a esa
 * cohorte) en un objeto por cohorte con sus actividades y el total de %.
 *
 * Sin React, sin Date.now/Math.random → testeable.
 */

/** Fila cruda del RPC get_course_cohort_weights. */
export type CohortWeightRow = {
  cohorte: string;
  kind: string; // 'exam' | 'workshop' | 'project'
  item_id: string;
  title: string;
  weight: number | string | null;
  cut_name: string | null;
  cut_position: number | null;
};

export type CohortWeightItem = {
  kind: string;
  itemId: string;
  title: string;
  weight: number;
  cutName: string | null;
};

export type CohortWeightGroup = {
  cohorte: string;
  items: CohortWeightItem[];
  /** Suma de los pesos de las actividades de la cohorte (redondeado a 2). */
  totalWeight: number;
};

const num = (v: number | string | null | undefined): number => {
  const n = typeof v === "string" ? parseFloat(v) : (v ?? 0);
  return Number.isFinite(n) ? Number(n) : 0;
};

/**
 * Agrupa las filas por cohorte. Cohortes ordenadas es-CO (numérico); dentro de
 * cada cohorte se preserva el orden del RPC (por corte/posición y título).
 * Deduplica por (cohorte,item) por si el RPC repitiera. totalWeight = suma de
 * pesos de las actividades distintas de la cohorte.
 */
export function groupCohortWeights(rows: CohortWeightRow[]): CohortWeightGroup[] {
  const byCohort = new Map<string, Map<string, CohortWeightItem>>();
  for (const r of rows) {
    const cohorte = (r.cohorte ?? "").trim();
    if (!cohorte) continue;
    let items = byCohort.get(cohorte);
    if (!items) {
      items = new Map();
      byCohort.set(cohorte, items);
    }
    const key = `${r.kind}::${r.item_id}`;
    if (!items.has(key)) {
      items.set(key, {
        kind: r.kind,
        itemId: r.item_id,
        title: r.title,
        weight: num(r.weight),
        cutName: r.cut_name,
      });
    }
  }

  return [...byCohort.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "es-CO", { numeric: true, sensitivity: "base" }))
    .map(([cohorte, itemsMap]) => {
      const items = [...itemsMap.values()];
      const totalWeight = Math.round(items.reduce((acc, it) => acc + it.weight, 0) * 100) / 100;
      return { cohorte, items, totalWeight };
    });
}

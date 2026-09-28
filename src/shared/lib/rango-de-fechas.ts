/**
 * Filtrar una lista por una fecha exacta o por un rango.
 *
 * Lo usan los grids del docente y las listas del estudiante a través de
 * `ListFilters`, así que la regla vive en UN lugar: repetida por pantalla,
 * cada una resolvería distinto los tres casos borde de abajo y el mismo taller
 * entraría en el filtro de una pantalla y no en el de la otra.
 *
 * ── Una fecha exacta NO es un modo aparte ─────────────────────────────
 *
 * Es el rango con los dos extremos iguales. Un selector «exacta / rango» sería
 * un control más que decidir antes de poder filtrar, para algo que el propio
 * rango ya expresa: poner la misma fecha en los dos campos ES pedir ese día.
 *
 * ── Los dos extremos son INCLUSIVOS ───────────────────────────────────
 *
 * «Del 1 al 5» incluye el 5. Excluirlo es el error de uno en el que cae medio
 * mundo al comparar contra medianoche, y el usuario no lo lee como un error de
 * borde: lo lee como que el filtro no sirve.
 *
 * ── Se compara por DÍA, nunca por instante ────────────────────────────
 *
 * Las columnas son de dos clases y hay que tratarlas igual:
 *  - `DATE` (`session_date`, `due_date` en algunas tablas) llega como
 *    `"2026-10-01"`, sin hora ni zona.
 *  - `timestamptz` (`start_time`, `created_at`) llega como instante.
 *
 * Un `timestamptz` hay que bajarlo al día **local** antes de comparar. En
 * UTC-5, `2026-10-02T04:59:00Z` es el 1 de octubre a las 23:59 — compararlo
 * como instante contra «hasta el 1 de octubre» lo dejaría afuera. Es el mismo
 * error que ya justifican `formatDateOnly` y `estadoDeCorte`.
 *
 * ── Una fila SIN fecha se OCULTA mientras el filtro esté puesto ───────
 *
 * Es la misma regla que ya aplica el filtro de periodo a un item sin curso: no
 * se le puede atribuir una fecha, así que no se puede afirmar que cae dentro.
 * Dejarla pasar haría que «del 1 al 5 de octubre» devolviera cosas sin fecha, y
 * el usuario no tendría cómo explicárselo.
 */

/** Rango elegido. `null` en un extremo = abierto por ese lado. */
export interface RangoFechas {
  /** `yyyy-MM-dd` o `null`. */
  desde: string | null;
  /** `yyyy-MM-dd` o `null`. */
  hasta: string | null;
}

export const RANGO_VACIO: RangoFechas = { desde: null, hasta: null };

/** ¿No hay ningún extremo puesto? Entonces el filtro no filtra. */
export function rangoVacio(r: RangoFechas | null | undefined): boolean {
  return !r || (!r.desde && !r.hasta);
}

/**
 * El día local de un valor de fecha, como `yyyy-MM-dd`.
 *
 * Un `yyyy-MM-dd` se devuelve tal cual: ya ES un día, y pasarlo por `Date` lo
 * interpretaría como medianoche UTC y en UTC-5 retrocedería al día anterior.
 */
export function diaDe(valor: string | Date | null | undefined): string | null {
  if (!valor) return null;
  if (typeof valor === "string") {
    const soloFecha = /^(\d{4}-\d{2}-\d{2})$/.exec(valor.trim());
    if (soloFecha) return soloFecha[1];
  }
  const d = valor instanceof Date ? valor : new Date(valor);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Normaliza el rango: si los extremos vienen al revés, se dan vuelta.
 *
 * Alguien que elige «desde el 5 hasta el 1» quiso decir del 1 al 5. Devolver
 * vacío sería literalmente correcto y completamente inútil: la tabla queda en
 * blanco y no hay nada en pantalla que explique por qué.
 */
export function normalizarRango(r: RangoFechas): RangoFechas {
  const { desde, hasta } = r;
  if (desde && hasta && desde > hasta) return { desde: hasta, hasta: desde };
  return r;
}

/**
 * ¿Este valor cae dentro del rango?
 *
 * Con el rango vacío devuelve `true` para todo: «sin filtro» no puede esconder
 * nada. Con filtro puesto, un valor sin fecha queda afuera (ver el encabezado).
 */
export function enRangoDeFechas(
  valor: string | Date | null | undefined,
  rango: RangoFechas | null | undefined,
): boolean {
  if (rangoVacio(rango)) return true;
  const { desde, hasta } = normalizarRango(rango as RangoFechas);
  const dia = diaDe(valor);
  if (!dia) return false;
  if (desde && dia < desde) return false;
  if (hasta && dia > hasta) return false;
  return true;
}

/**
 * ¿Cae dentro mirando VARIAS fechas de la misma fila?
 *
 * Un taller tiene inicio y entrega: el docente que filtra «esta semana» espera
 * ver el que empezó antes y vence dentro, no solo los que empiezan dentro. Basta
 * con que UNA de las fechas caiga en el rango.
 */
export function algunaEnRango(
  valores: ReadonlyArray<string | Date | null | undefined>,
  rango: RangoFechas | null | undefined,
): boolean {
  if (rangoVacio(rango)) return true;
  return valores.some((v) => enRangoDeFechas(v, rango));
}

/** Parte del `resetKey` de la paginación: al cambiar el rango se vuelve a la 1. */
export function claveDeRango(r: RangoFechas | null | undefined): string {
  return `${r?.desde ?? ""}~${r?.hasta ?? ""}`;
}

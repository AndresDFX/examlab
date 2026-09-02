/**
 * Buscador y selección masiva del diálogo "Enviar a firmar". PURO: sin React, sin
 * base.
 *
 * ── Por qué no `useMultiSelect` ───────────────────────────────────────────
 * El hook de multi-selección del repo modela "filas marcadas de una grid para
 * aplicarles una acción": el set arranca vacío, `toggleAll` reemplaza la selección
 * por lo visible, y al terminar la acción se limpia. Acá la semántica es otra: el
 * set NO es una selección de trabajo, es **el estado deseado de a quién se le pide
 * la firma**, y arranca precargado con lo que ya está pedido en la base. Guardar
 * calcula un DIFF contra ese estado (`nuevos` y `retirados`), no ejecuta una acción
 * sobre lo marcado.
 *
 * ── La trampa que este módulo existe para cerrar ──────────────────────────
 * Como los que quedan FUERA del set se interpretan como "retirar la solicitud",
 * un `toggleAll` que reemplace la selección por lo VISIBLE **borra las solicitudes
 * de todos los que el buscador dejó fuera**. Con 96 matriculados, escribir tres
 * letras y pulsar "marcar todos" mataría 90 solicitudes pendientes y sus enlaces
 * personales ya repartidos, sin una sola advertencia.
 *
 * Por eso `alternarVisibles` **parte del set actual** y solo agrega o quita los
 * ids visibles: lo que está fuera del filtro no se toca. Es una propiedad de
 * corrección, no una comodidad, y por eso vive en un módulo con tests en vez de
 * inline en el `onClick`.
 *
 * ── Y una firma puesta nunca se toca ──────────────────────────────────────
 * Quien ya firmó queda fuera de la acción masiva en las dos direcciones. Marcarlo
 * no hace nada (la RPC lo omite por el UNIQUE) y desmarcarlo lo pondría en
 * `retirados`, donde el DELETE tiene `.is("signed_at", null)` y lo ignoraría: el
 * docente vería la casilla saltar sola. Mejor no ofrecer el clic.
 */

import { normalizeForSearch } from "./template-engine";

/** Lo mínimo que este módulo necesita saber de un firmante. */
export interface FilaFirma {
  id: string;
  nombre: string;
  email?: string | null;
}

/**
 * Filtra por nombre o correo, sin distinguir tildes ni mayúsculas.
 *
 * Con `q` vacío devuelve **el mismo arreglo** (no una copia): la lista se
 * re-renderiza en cada tecleo y clonar 96 filas por nada es trabajo tirado.
 */
export function filtrarFirmantes<T extends FilaFirma>(filas: readonly T[], q: string): readonly T[] {
  const n = normalizeForSearch(q ?? "");
  if (n === "") return filas;
  return filas.filter(
    (f) =>
      normalizeForSearch(f.nombre ?? "").includes(n) ||
      normalizeForSearch(f.email ?? "").includes(n),
  );
}

/**
 * Marca o desmarca SOLO los visibles, preservando el resto de la selección.
 *
 * `firmoYa` decide a quién no tocar. Devuelve un Set nuevo (el estado de React no
 * se muta) y nunca pierde ids que no estén en `visibles`.
 */
export function alternarVisibles(
  elegidos: ReadonlySet<string>,
  visibles: readonly FilaFirma[],
  firmoYa: (id: string) => boolean,
  marcar: boolean,
): Set<string> {
  const s = new Set(elegidos);
  for (const v of visibles) {
    if (firmoYa(v.id)) continue;
    if (marcar) s.add(v.id);
    else s.delete(v.id);
  }
  return s;
}

/** Los visibles sobre los que la acción masiva puede operar. */
export function seleccionables<T extends FilaFirma>(
  visibles: readonly T[],
  firmoYa: (id: string) => boolean,
): T[] {
  return visibles.filter((v) => !firmoYa(v.id));
}

/** ¿Ya están marcados todos los visibles que se pueden marcar? */
export function todosVisiblesMarcados(
  elegidos: ReadonlySet<string>,
  visibles: readonly FilaFirma[],
  firmoYa: (id: string) => boolean,
): boolean {
  const posibles = seleccionables(visibles, firmoYa);
  return posibles.length > 0 && posibles.every((v) => elegidos.has(v.id));
}

/** Lo que hace falta saber de una solicitud para calcular el diff. */
export interface EstadoSolicitud {
  firmada: boolean;
}

/**
 * Qué va a pasar al guardar: a quién se le pide y a quién se le retira.
 *
 * **Se calcula sobre la lista COMPLETA, nunca sobre la filtrada.** Con la filtrada,
 * los pendientes que el buscador esconde caerían en `retirados` y se borrarían sus
 * solicitudes. Ese es exactamente el accidente que este módulo evita, así que la
 * firma pide `todos` y no acepta un subconjunto.
 */
export function calcularDiff(
  todos: readonly FilaFirma[],
  elegidos: ReadonlySet<string>,
  solicitudDe: (id: string) => EstadoSolicitud | undefined,
): { nuevos: string[]; retirados: string[] } {
  const nuevos: string[] = [];
  const retirados: string[] = [];
  for (const id of elegidos) {
    if (!solicitudDe(id)) nuevos.push(id);
  }
  for (const a of todos) {
    const s = solicitudDe(a.id);
    if (s && !s.firmada && !elegidos.has(a.id)) retirados.push(a.id);
  }
  return { nuevos, retirados };
}

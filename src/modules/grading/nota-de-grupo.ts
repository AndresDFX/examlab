/**
 * Calificar a un GRUPO con una sola nota.
 *
 * Hay dos formas de que una nota sea «del grupo», y no se califican igual:
 *
 *  - Actividad EN LÍNEA: el grupo entrega UNA fila (`*_submissions.group_id`)
 *    que comparten todos sus integrantes. Calificar esa entrega ya califica al
 *    grupo entero; lo que faltaba era que se viera. En el libro de notas cada
 *    integrante tiene su celda, pero todas apuntan a la MISMA entrega
 *    (`integrantesPorEntrega`): editar una es editarlas todas, y guardar dos
 *    veces la misma fila es inútil (`unaVezPorEntrega`).
 *
 *  - Actividad EXTERNA (exposición, sustentación presencial): no hay entrega
 *    del estudiante; la nota la escribe el docente en «Notas externas», una
 *    fila por integrante. Por eso calificar al grupo ahí es escribir la misma
 *    nota en cada fila (`planDeNotaDeGrupo`), y cada integrante se puede seguir
 *    ajustando después (el que no se presentó, por ejemplo).
 *
 * PURO: sin React ni Supabase, para poder testearlo.
 */

/** Lo mínimo de una fila de «Notas externas» que miran estas reglas. */
export interface FilaDeNotaConGrupo {
  userId: string;
  fullName: string;
  grupoId: string | null;
  grupoNombre: string | null;
  /** Lo que se ve en la fila ahora (puede estar sin guardar). */
  grade: number | null;
  feedback: string;
  /** Lo que está guardado. */
  originalGrade: number | null;
  originalFeedback: string;
}

export interface SeccionDeGrupo<F> {
  grupoId: string;
  nombre: string;
  filas: F[];
}

const porNombre = (a: string, b: string) => a.localeCompare(b, "es", { numeric: true });

/**
 * Las filas, separadas por grupo: «Grupo 2» antes que «Grupo 10», y dentro de
 * cada grupo los integrantes por nombre. Los que no tienen grupo, aparte.
 */
export function seccionesPorGrupo<F extends FilaDeNotaConGrupo>(
  filas: readonly F[],
): { grupos: SeccionDeGrupo<F>[]; sinGrupo: F[] } {
  const grupos = new Map<string, SeccionDeGrupo<F>>();
  const sinGrupo: F[] = [];
  for (const f of filas) {
    if (!f.grupoId) {
      sinGrupo.push(f);
      continue;
    }
    let s = grupos.get(f.grupoId);
    if (!s) {
      s = { grupoId: f.grupoId, nombre: f.grupoNombre ?? "", filas: [] };
      grupos.set(f.grupoId, s);
    }
    s.filas.push(f);
  }
  const lista = [...grupos.values()].sort((a, b) => porNombre(a.nombre, b.nombre));
  for (const s of lista) s.filas.sort((a, b) => porNombre(a.fullName, b.fullName));
  sinGrupo.sort((a, b) => porNombre(a.fullName, b.fullName));
  return { grupos: lista, sinGrupo };
}

/** El valor que comparten todos, o `null` si difieren (o no hay ninguno). */
export function valorComun<T>(valores: readonly T[]): T | null {
  if (valores.length === 0) return null;
  const [primero, ...resto] = valores;
  return resto.every((v) => v === primero) ? primero : null;
}

export interface ResumenDeGrupo {
  total: number;
  /** Integrantes con nota GUARDADA. */
  conNota: number;
  /** Hay notas guardadas distintas dentro del grupo (alguien se ajustó a mano). */
  distintas: boolean;
}

export function resumenDeGrupo(filas: readonly FilaDeNotaConGrupo[]): ResumenDeGrupo {
  const guardadas = filas.map((f) => f.originalGrade).filter((n): n is number => n != null);
  return {
    total: filas.length,
    conNota: guardadas.length,
    distintas: new Set(guardadas).size > 1,
  };
}

/**
 * Con qué arranca la fila del grupo: la nota y la observación que ya comparten
 * TODOS sus integrantes. Si difieren, vacío — proponer la de uno solo sería
 * inventarle la nota al resto.
 */
export function borradorInicialDeGrupo(filas: readonly FilaDeNotaConGrupo[]): {
  grade: number | null;
  feedback: string;
} {
  return {
    grade: valorComun(filas.map((f) => f.originalGrade)),
    feedback: valorComun(filas.map((f) => (f.originalFeedback ?? "").trim())) ?? "",
  };
}

/**
 * Integrantes que YA tienen otra nota (guardada o escrita sin guardar) y que
 * calificar al grupo con `nota` les reemplazaría. Es lo que se le pregunta al
 * docente antes de escribir: un ajuste individual hecho a propósito (el que no
 * se presentó) no se puede perder sin que lo sepa.
 */
export function conflictosAlCalificarGrupo<F extends FilaDeNotaConGrupo>(
  filas: readonly F[],
  nota: number,
): { fila: F; nota: number }[] {
  const out: { fila: F; nota: number }[] = [];
  for (const f of filas) {
    // Lo que se VE en la fila manda; si está vacía, lo guardado.
    const actual = f.grade ?? f.originalGrade;
    if (actual != null && actual !== nota) out.push({ fila: f, nota: actual });
  }
  return out;
}

/**
 * Qué se guarda en cada integrante al calificar al grupo: la MISMA nota para
 * todos y, si se escribió, la misma observación. Una observación de grupo en
 * blanco NO borra la de cada integrante: el docente pudo haber dejado un
 * comentario individual, y vaciarlo sin pedirlo es perder trabajo.
 *
 * Sin nota no hay plan: guardar «sin nota» al grupo borraría las notas que ya
 * tienen sus integrantes.
 */
export function planDeNotaDeGrupo<F extends FilaDeNotaConGrupo>(
  filas: readonly F[],
  borrador: { grade: number | null; feedback: string },
): { fila: F; grade: number; feedback: string }[] {
  if (borrador.grade == null || Number.isNaN(borrador.grade)) return [];
  const comun = borrador.feedback.trim();
  return filas.map((f) => ({
    fila: f,
    grade: borrador.grade as number,
    feedback: comun ? borrador.feedback : f.feedback,
  }));
}

/** Los nombres de los integrantes, en orden alfabético, para mostrarlos. */
export function nombresDeIntegrantes(
  integrantes: readonly string[],
  perfiles: ReadonlyMap<string, { full_name?: string | null }>,
): string[] {
  const conNombre: string[] = [];
  let sinNombre = 0;
  for (const id of integrantes) {
    const n = perfiles.get(id)?.full_name?.trim();
    if (n) conNombre.push(n);
    else sinNombre += 1;
  }
  // Sin perfil al final: la raya ordena antes que las letras.
  return [...conNombre.sort((a, b) => a.localeCompare(b, "es")), ...Array(sinNombre).fill("—")];
}

// ── Libro de notas: entregas compartidas por un grupo ───────────────────

/**
 * Para cada entrega de GRUPO, qué estudiantes de la lista la comparten (los
 * integrantes de ese grupo). Una entrega individual no aparece: su celda es
 * solo de su dueño.
 */
export function integrantesPorEntrega(
  entregas: readonly { id: string; group_id: string | null }[],
  gruposPorUsuario: ReadonlyMap<string, ReadonlySet<string>>,
  estudiantes: readonly string[],
): Map<string, string[]> {
  const porGrupo = new Map<string, string[]>();
  for (const sid of estudiantes) {
    for (const gid of gruposPorUsuario.get(sid) ?? []) {
      (porGrupo.get(gid) ?? porGrupo.set(gid, []).get(gid)!).push(sid);
    }
  }
  const out = new Map<string, string[]>();
  for (const e of entregas) {
    if (!e.group_id) continue;
    const ids = porGrupo.get(e.group_id);
    if (ids && ids.length > 0) out.set(e.id, [...ids]);
  }
  return out;
}

/**
 * Las ediciones que apuntan a la misma entrega se guardan UNA vez (la última).
 * Las de entrega desconocida (`null`) pasan todas: quien las guarda decide qué
 * hacer con ellas, como antes.
 */
export function unaVezPorEntrega<E>(
  entradas: readonly E[],
  claveDeEntrega: (e: E) => string | null,
): E[] {
  const ultima = new Map<string, number>();
  entradas.forEach((e, i) => {
    const k = claveDeEntrega(e);
    if (k != null) ultima.set(k, i);
  });
  return entradas.filter((e, i) => {
    const k = claveDeEntrega(e);
    return k == null || ultima.get(k) === i;
  });
}

/**
 * A qué CORTE pertenece una actividad y cuánto vale de la nota final.
 *
 * El docente ya veía las dos cosas en su grilla; el estudiante no veía ninguna.
 * Sin ellas su lista es una fila de tareas sin jerarquía: no puede saber si el
 * taller del jueves pesa lo mismo que el parcial, ni a qué corte va a parar la
 * nota. Es la información con la que decide a qué dedicarle la semana.
 *
 * ── El número es % de la nota FINAL, no del corte ─────────────────────
 *
 * `exam.weight` / `workshop.weight` / `project.weight` son porcentaje **de la
 * nota final del curso**, no relativo dentro del bucket de su corte (ver el
 * modelo de pesos en CLAUDE.md). Por eso la etiqueta lo dice completo: un
 * «10%» a secas se lee como «10% del corte», que sería otro número y llevaría
 * al estudiante a cuentas equivocadas justo antes de un parcial.
 *
 * ── Cuándo NO se muestra, y por qué falla CERRADO ─────────────────────
 *
 * Se muestra solo cuando la actividad tiene corte Y ese corte está entre los
 * que se cargaron. Un peso sin corte no significa nada —el presupuesto vive en
 * el corte— y un corte que no se pudo resolver casi siempre es de OTRO curso:
 * mostrar su peso sería atribuirle al estudiante un porcentaje que no es el
 * suyo. Ante la duda no se muestra nada, que es lo único que no puede estar
 * mal.
 *
 * ── Un 0% SÍ se muestra ───────────────────────────────────────────────
 *
 * Es la diferencia entre «no cuenta para la nota» y «todavía no sé cuánto
 * vale», y la primera es justamente lo que el estudiante quiere saber de un
 * quiz de práctica. Callarlo lo deja suponiendo que pesa.
 *
 * ── Talleres y proyectos son M:N ──────────────────────────────────────
 *
 * Su corte y su peso NO salen de la fila del taller: salen de
 * `workshop_courses` / `project_courses`, que es donde vive el valor **para
 * ESTE curso**. Un taller compartido a dos cursos puede pesar distinto en cada
 * uno, así que leer `workshops.weight` le mostraría al estudiante el peso que
 * ese taller tiene en el curso de otro. Los exámenes sí lo llevan en su propia
 * fila (`exam_assignments` es examen↔estudiante, no examen↔curso).
 */

/** Lo que la tarjeta necesita pintar. `null` = no mostrar nada. */
export interface CorteYPeso {
  /** Nombre del corte, tal como lo configuró la institución. */
  corte: string;
  /** Porcentaje de la nota FINAL del curso. Puede ser 0. */
  porcentaje: number;
}

/**
 * Resuelve el corte y el peso de una actividad para el estudiante.
 *
 * `nombreDeCorte` mapea `cut_id` → nombre, y su ausencia es la señal de
 * «no lo puedo atribuir»: ver el encabezado.
 */
export function resolverCorteYPeso(
  cutId: string | null | undefined,
  peso: number | null | undefined,
  nombreDeCorte: ReadonlyMap<string, string>,
): CorteYPeso | null {
  if (!cutId) return null;
  const corte = nombreDeCorte.get(cutId);
  if (!corte) return null;
  if (peso == null) return null;
  const porcentaje = Number(peso);
  if (!Number.isFinite(porcentaje) || porcentaje < 0) return null;
  return { corte, porcentaje };
}

/**
 * Índice `cut_id` → nombre a partir de las filas de `grade_cuts`.
 *
 * Acepta filas de varios cursos a la vez: la lista del estudiante mezcla
 * actividades de todos sus cursos, y los `cut_id` son únicos entre cursos.
 */
export function indiceDeCortes(
  filas: ReadonlyArray<{ id: string; name: string | null } | null | undefined>,
): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of filas) {
    if (!f?.id) continue;
    const nombre = (f.name ?? "").trim();
    // Un corte sin nombre no se puede mostrar, y dejarlo entrar haría que
    // `resolverCorteYPeso` devolviera una etiqueta vacía con su porcentaje al
    // lado — peor que no mostrarlo.
    if (!nombre) continue;
    m.set(f.id, nombre);
  }
  return m;
}

/**
 * Qué fila manda cuando hay dos: la del CURSO (M:N) o la de la actividad.
 *
 * Medido en producción el 2026-09-26 sobre las 7 asignaturas en curso: **57 de
 * los 66 talleres publicados NO tienen fila en `workshop_courses`** para su
 * curso, y todos ellos sí tienen `cut_id` y peso en su propia fila. Con solo la
 * tabla de unión, el 86 % de las tarjetas del estudiante saldría sin corte y
 * sin porcentaje — o sea, la funcionalidad no existiría para casi nadie.
 *
 * Cuando las DOS existen gana la de unión, y no es una preferencia: es la que
 * usan el gradebook del docente y la pantalla de notas del estudiante para
 * calcular. En producción hay 3 talleres donde difieren —«Taller Corte 1
 * (Clases 1 a 4)» dice 10 % en su fila y 2,5 % en la de unión— y mostrarle al
 * alumno el 10 % sería contradecir su propia nota. Ojo con el detalle: la
 * grilla del DOCENTE lee la fila de la actividad, así que en esos 3 casos
 * docente y estudiante ven números distintos. Eso es un defecto de la grilla
 * del docente, no de acá.
 */
export function filaQueManda<T extends { cut_id: string | null; weight: number | null }>(
  deUnion: T | undefined | null,
  dePropia: { cut_id?: string | null; weight?: number | null } | undefined | null,
): { cut_id: string | null | undefined; weight: number | null | undefined } {
  // Una fila de unión SIN corte no se toma como respuesta: significa que nunca
  // se le asignó corte en ese curso, y la de la actividad puede tenerlo.
  if (deUnion && deUnion.cut_id) return deUnion;
  return { cut_id: dePropia?.cut_id, weight: dePropia?.weight };
}

/**
 * Índice de las filas M:N (`workshop_courses` / `project_courses`) por id de
 * actividad, quedándose con la del curso en el que el estudiante está.
 *
 * Si el estudiante estuviera en los DOS cursos a los que se compartió un
 * taller, gana la primera fila: el taller es uno solo y su tarjeta también,
 * así que hay que elegir. Es un caso que hoy no se da (un estudiante no cursa
 * la misma asignatura dos veces) y elegir en silencio es preferible a mostrar
 * dos porcentajes contradictorios sobre la misma tarjeta.
 */
export function indicePorActividad<T extends { cut_id: string | null; weight: number | null }>(
  filas: ReadonlyArray<(T & { actividadId: string | null | undefined }) | null | undefined>,
): Map<string, T> {
  const m = new Map<string, T>();
  for (const f of filas) {
    if (!f?.actividadId) continue;
    if (m.has(f.actividadId)) continue;
    m.set(f.actividadId, f);
  }
  return m;
}

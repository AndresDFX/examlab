/**
 * La nota es RELATIVA a lo que ya se dio: una sesión que no se dictó, un
 * taller que todavía está abierto o un parcial que nadie ha calificado no
 * pueden bajarle la nota a nadie. Es la regla ÚNICA del libro de
 * calificaciones del docente, de «Mis notas» del estudiante y del boletín; su
 * espejo en SQL es el acta (`public.generate_course_acta`, mig 20262670000000).
 *
 * Antes, la nota de un corte contaba TODO lo que el corte tenía programado:
 * las sesiones futuras como faltas de todo el curso y los talleres sin vencer
 * como un 0. Medido en UNIAJ el 2026-09-30, la nota final le sumaba al curso
 * entero las faltas de las sesiones de los cortes 2 y 3 que todavía no
 * existían, y en el corte 1 le ponía 0 en el taller a quien tenía hasta el 5
 * de octubre para entregarlo.
 *
 * ── Qué es «ya se dio» ─────────────────────────────────────────────────
 *
 * - **Una sesión** se dio si ALGUIEN tiene marca de asistencia en ella (la
 *   lista se tomó). Sin ninguna marca no se sabe si hubo clase, así que no
 *   entra. Es el mismo criterio que ya usan la Alerta temprana y los
 *   pendientes por estudiante; con otro, el curso entero aparece con una
 *   falta cada vez que el docente no pasa lista.
 * - **Una actividad en línea** se dio cuando cerró: pasó su plazo o el docente
 *   la cerró. Si el estudiante tiene asignada una recuperación publicada, cuando
 *   cerró también: a quien le falta la nota puede estar esperando el supletorio.
 *   Una recuperación de OTROS no lo hace esperar: no la puede presentar.
 * - **Una actividad externa** (la nota la carga el docente) se dio cuando hay
 *   al menos UNA nota cargada: ahí la evaluación ya ocurrió. Antes de eso el
 *   estudiante no tiene cómo haberla presentado. Mismo criterio para una en
 *   línea sin plazo.
 *
 * ── Qué aporta cada estudiante ─────────────────────────────────────────
 *
 * Con nota, su nota (aunque la actividad siga abierta: ya se evaluó). Sin
 * nota en una actividad que ya se dio: si la entregó y falta calificarla, NO
 * cuenta —la espera es del docente, no del estudiante—; si no la entregó, es
 * nota perdida y cuenta como 0, salvo que no se le haya asignado (no la podía
 * ver). Sin nota en una que no se dio: no cuenta.
 *
 * Una actividad que no pertenece a ningún corte del curso NO entra en la
 * nota final: el peso es un pedazo del corte («un peso sin corte no significa
 * nada», ver corte-y-peso.ts), y sin corte ese 1 % que el formulario deja por
 * defecto terminaba sumando 101 %.
 */
import { computeWeightedGrade, countsAsPresent, scaleAttendance, type GradedItem } from "./grade";

// ── Asistencia ─────────────────────────────────────────────────────────

/** Las sesiones que se dieron: las que tienen al menos una marca de asistencia. */
export function sesionesDadas(registros: Iterable<{ session_id: string }>): Set<string> {
  const dadas = new Set<string>();
  for (const r of registros) if (r.session_id) dadas.add(r.session_id);
  return dadas;
}

export interface AsistenciaDelCorte {
  presentes: number;
  /** Sesiones del corte que se dieron: el denominador. */
  dadas: number;
  /** En la escala del curso; null si el corte todavía no tiene sesiones dadas. */
  nota: number | null;
}

/**
 * La asistencia de un estudiante en un corte, sobre las sesiones que se dieron.
 * `sesionesDelCorte` ya viene sin las que están en la papelera.
 */
export function asistenciaDelCorte(
  sesionesDelCorte: readonly { id: string }[],
  dadas: ReadonlySet<string>,
  estadoDelEstudiante: (sessionId: string) => string | null | undefined,
  escala: { min: number; max: number },
): AsistenciaDelCorte {
  let total = 0;
  let presentes = 0;
  for (const s of sesionesDelCorte) {
    if (!dadas.has(s.id)) continue;
    total++;
    if (countsAsPresent(estadoDelEstudiante(s.id))) presentes++;
  }
  return {
    presentes,
    dadas: total,
    nota: total > 0 ? scaleAttendance(presentes / total, escala.min, escala.max) : null,
  };
}

// ── Actividades ────────────────────────────────────────────────────────

export interface EstadoDeActividad {
  /** Externa: la nota la carga el docente, el estudiante no entrega nada. */
  externa: boolean;
  /** `status` de la fila (`closed` = el docente la cerró). */
  estado?: string | null;
  /** Plazo: `end_time` de un examen, `due_date` de un taller o proyecto. */
  cierre?: string | null;
  /** ¿Algún estudiante del curso tiene nota en ella? */
  alguienConNota: boolean;
}

/** ¿Una actividad (sin contar sus recuperaciones) ya se dio? */
export function actividadSeDio(a: EstadoDeActividad, ahora: number): boolean {
  if (a.externa) return a.alguienConNota;
  if (a.estado === "closed") return true;
  const t = a.cierre ? Date.parse(a.cierre) : Number.NaN;
  if (Number.isFinite(t)) return t <= ahora;
  return a.alguienConNota;
}

/**
 * La actividad CON sus recuperaciones publicadas: en línea, se dio cuando
 * cerraron todas; externa, cuando alguna ya tiene notas.
 */
export function actividadConRecuperacionesSeDio(
  original: EstadoDeActividad,
  recuperaciones: readonly EstadoDeActividad[],
  ahora: number,
): boolean {
  if (original.externa) {
    return original.alguienConNota || recuperaciones.some((r) => r.alguienConNota);
  }
  return actividadSeDio(original, ahora) && recuperaciones.every((r) => actividadSeDio(r, ahora));
}

/**
 * Si la actividad entra en la nota de ESTE estudiante. `nota` es la que
 * resolvió la regla de recuperaciones; `entrego`, si presentó algo (el original
 * o una recuperación) — solo importa cuando no hay nota.
 *
 * `asignada`: una actividad en línea que NO se le asignó no la pudo ver (la RLS
 * le muestra al estudiante solo lo asignado), así que sin entrega no le cuenta
 * como 0 — no la debe. Medido en UNIAJ el 2026-09-30: un taller del corte 1
 * cerró asignado a 1 de 19 estudiantes, y los otros 18 cargaban un 0 por algo
 * que nunca vieron. Sin el dato (undefined) se asume asignada, que es como se
 * calculaba antes. En una externa no aplica: la nota la carga el docente.
 */
export function actividadCuenta(args: {
  nota: number | null;
  seDio: boolean;
  externa: boolean;
  entrego: boolean;
  asignada?: boolean;
}): boolean {
  if (args.nota != null) return true;
  if (!args.seDio) return false;
  if (args.externa) return true;
  if (args.entrego) return false;
  return args.asignada ?? true;
}

// ── Corte y peso en ESTE curso ─────────────────────────────────────────

/** Sin peso no mueve la nota: un peso vacío es 0 (igual que el acta en SQL). */
export function pesoEfectivo(peso: number | string | null | undefined): number {
  const n = Number(peso);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Corte y peso de un taller o proyecto EN ESTE CURSO, para calcular la nota.
 *
 * Manda la fila del curso (`workshop_courses` / `project_courses`) cuando tiene
 * corte; si no existe o no tiene corte, la de la actividad — pero solo si es
 * de ESTE curso, porque en un curso secundario el corte de la actividad es del
 * primario. Es la misma resolución que `filaQueManda` usa para las tarjetas
 * del estudiante: si el cálculo usara otra, el alumno vería «Corte 3 · 20 %»
 * en su lista y su nota lo contaría como una actividad suelta al 1 %.
 *
 * Con la fila del curso sin peso vale el de la actividad, que es lo que la
 * columna documenta (`NULL = se usa el valor de workshops.weight`).
 */
export function corteYPesoEnCurso(
  deUnion: { cut_id?: string | null; weight?: number | null } | null | undefined,
  propia: { course_id?: string | null; cut_id?: string | null; weight?: number | null },
  courseId: string,
): { cutId: string | null; weight: number } {
  if (deUnion?.cut_id) {
    return { cutId: deUnion.cut_id, weight: pesoEfectivo(deUnion.weight ?? propia.weight) };
  }
  if (propia.course_id === courseId && propia.cut_id) {
    return { cutId: propia.cut_id, weight: pesoEfectivo(propia.weight) };
  }
  return { cutId: null, weight: 0 };
}

// ── La nota del estudiante ─────────────────────────────────────────────

export interface ItemDeNota {
  cutId: string | null;
  weight: number;
  /** En la escala del curso; null = cuenta como 0 (si `cuenta`). */
  score: number | null;
  /** Resultado de `actividadCuenta`. */
  cuenta: boolean;
}

export interface CorteParaNota {
  id: string;
  attendance_weight?: number | null;
  /** DATE: mientras no termine, la nota del curso es parcial. */
  end_date?: string | null;
}

export interface NotaDelEstudiante {
  cutGrades: Array<{ cutId: string; grade: number | null }>;
  finalGrade: number | null;
  /** Asistencia de cada corte en la escala del curso; null = sin sesiones dadas. */
  attByCut: Array<{ cutId: string; score: number | null }>;
}

/**
 * Nota de cada corte y nota final: promedio ponderado de lo que cuenta. La
 * final pondera TODOS los ítems de todos los cortes juntos (no las notas de
 * los cortes), para no redondear dos veces.
 */
export function notaDelEstudiante(
  cortes: readonly CorteParaNota[],
  items: readonly ItemDeNota[],
  asistencia: ReadonlyMap<string, AsistenciaDelCorte>,
): NotaDelEstudiante {
  // Solo entra lo que cae en un corte de ESTE curso: un ítem sin corte, o con
  // el corte de otro curso, no suma ni al corte ni a la final.
  const todos: GradedItem[] = [];
  const cutGrades = cortes.map((cut) => {
    const delCorte: GradedItem[] = items
      .filter((i) => i.cuenta && i.cutId === cut.id)
      .map((i) => ({ score: i.score, weight: i.weight }));
    const att = asistencia.get(cut.id);
    const pesoAsistencia = pesoEfectivo(cut.attendance_weight);
    if (att?.nota != null && pesoAsistencia > 0) {
      delCorte.push({ score: att.nota, weight: pesoAsistencia });
    }
    todos.push(...delCorte);
    return { cutId: cut.id, grade: computeWeightedGrade(delCorte) };
  });
  return {
    cutGrades,
    finalGrade: computeWeightedGrade(todos),
    attByCut: cortes.map((cut) => ({
      cutId: cut.id,
      score:
        pesoEfectivo(cut.attendance_weight) > 0 ? (asistencia.get(cut.id)?.nota ?? null) : null,
    })),
  };
}

/**
 * La nota de un examen cuando tiene exámenes de RECUPERACIÓN colgados
 * (`exams.parent_exam_id`) — una sola regla para el gradebook, las notas del
 * estudiante y los informes, y su espejo en SQL para el acta
 * (`public.exam_effective_raw_grade`, mig 20262650000000).
 *
 * Hay dos clases de recuperación y NO son intercambiables
 * (`exams.makeup_kind`):
 *
 *  - **Supletorio**: para quien NO presentó el original. Su nota solo llena
 *    una ausencia: si el estudiante presentó el original, el supletorio no
 *    cuenta aunque también lo haya presentado. Es el comportamiento que el
 *    repo tenía antes de que existieran los recuperatorios, y no cambia.
 *  - **Recuperatorio**: para quien presentó el original y quiere (o necesita)
 *    mejorar la nota. Cuenta AUNQUE haya presentado el original, y cómo
 *    combina lo decide `exams.recovery_rule`:
 *      · `mayor` (default): cuenta la nota más alta de las dos. Presentar el
 *        recuperatorio nunca le baja la nota a nadie.
 *      · `reemplaza`: la nota del recuperatorio sustituye a la del original,
 *        sea mayor o menor.
 *
 * Por qué no se podía reusar el supletorio para esto: su regla es «solo si no
 * presentó», así que la nota de quien perdió el parcial y presentó el
 * recuperatorio se ignoraba en todas las pantallas y en el acta.
 *
 * Las recuperaciones se aplican en orden de CREACIÓN (un pliegue): la primera
 * que el estudiante presentó llena la ausencia del original si la hay, y cada
 * recuperatorio posterior combina con lo acumulado según su regla. Un
 * recuperatorio presentado que todavía no tiene nota (la calificación con IA
 * va en cola) no cambia nada hasta que la tenga.
 *
 * «Presentó» = al menos un intento FINALIZADO (`completado` / `sospechoso`),
 * la misma definición que usa `computeAttemptGrade`: un intento en curso no es
 * haber presentado.
 */
import {
  computeAttemptGrade,
  esIntentoFinalizado,
  type AttemptForGrade,
  type RetryMode,
} from "@/modules/exams/exam-attempts";

export const TIPOS_RECUPERACION = ["supletorio", "recuperatorio"] as const;
export type TipoRecuperacion = (typeof TIPOS_RECUPERACION)[number];

export const REGLAS_RECUPERATORIO = ["mayor", "reemplaza"] as const;
export type ReglaRecuperatorio = (typeof REGLAS_RECUPERATORIO)[number];

/** De dónde salió la nota que cuenta. */
export type FuenteDeNota = "original" | TipoRecuperacion;

export interface ExamenConIntentos {
  id: string;
  retryMode: RetryMode;
  intentos: AttemptForGrade[];
}

export interface Recuperacion extends ExamenConIntentos {
  tipo: TipoRecuperacion;
  regla: ReglaRecuperatorio;
  /** Para aplicarlas en el orden en que se crearon (ver el encabezado). */
  creadoEn: string;
}

export interface NotaResuelta {
  /** Cruda, en la escala del examen (0..grade_scale_max). null = sin nota. */
  nota: number | null;
  fuente: FuenteDeNota | null;
  /** El examen de donde salió: sirve para enlazar a la revisión correcta. */
  examIdFuente: string | null;
}

/** Normaliza lo que viene de la base: un valor desconocido cae al default. */
export function tipoDeRecuperacion(valor: unknown): TipoRecuperacion {
  return valor === "recuperatorio" ? "recuperatorio" : "supletorio";
}

export function reglaDeRecuperatorio(valor: unknown): ReglaRecuperatorio {
  return valor === "reemplaza" ? "reemplaza" : "mayor";
}

export function presento(intentos: readonly AttemptForGrade[]): boolean {
  return intentos.some(esIntentoFinalizado);
}

// ── Núcleo GENÉRICO (examen o taller) ──────────────────────────────────
//
// El pliegue de recuperaciones es el mismo para exámenes y talleres; lo único
// que cambia es CÓMO se resuelve el «presentó» y la «nota» de cada ítem (un
// examen combina intentos por `retry_mode`; un taller usa una sola entrega vía
// `notaEfectivaDeTaller`). Por eso el núcleo recibe los ítems con su nota YA
// resuelta y no sabe de intentos ni de entregas: los wrappers de examen y de
// taller le dan de comer `ItemResuelto`.

/** Un examen/taller ya reducido a «¿presentó?» y «¿qué nota?». */
export interface ItemResuelto {
  id: string;
  presento: boolean;
  /** Nota cruda en la escala del ítem. null = presentó pero todavía sin nota. */
  nota: number | null;
}

export interface RecuperacionResuelta extends ItemResuelto {
  tipo: TipoRecuperacion;
  regla: ReglaRecuperatorio;
  /** Para aplicarlas en el orden en que se crearon (ver el encabezado). */
  creadoEn: string;
}

/**
 * Nota resuelta de forma genérica. `idFuente` es el id del examen/taller de
 * donde salió la nota (enlace a la revisión / entrega correctas).
 */
export interface NotaResueltaGenerica {
  nota: number | null;
  fuente: FuenteDeNota | null;
  idFuente: string | null;
}

/**
 * El pliegue en orden de creación (ver el encabezado del módulo). La primera
 * recuperación presentada llena la ausencia del original; cada recuperatorio
 * posterior combina con lo acumulado según su regla. Es la regla que espeja el
 * SQL de las actas (`exam_effective_raw_grade` / `workshop_effective_raw_grade`).
 */
export function plegarRecuperaciones(
  original: ItemResuelto,
  recuperaciones: readonly RecuperacionResuelta[],
): NotaResueltaGenerica {
  let base: NotaResueltaGenerica | null = original.presento
    ? { nota: original.nota, fuente: "original", idFuente: original.id }
    : null;

  const enOrden = [...recuperaciones].sort(
    (a, b) => a.creadoEn.localeCompare(b.creadoEn) || a.id.localeCompare(b.id),
  );
  for (const r of enOrden) {
    if (!r.presento) continue;
    if (base === null) {
      // No presentó el original: la primera recuperación presentada llena la
      // ausencia, sea supletorio o recuperatorio.
      base = { nota: r.nota, fuente: r.tipo, idFuente: r.id };
      continue;
    }
    // Con una nota de base ya puesta, el supletorio no tiene nada que llenar.
    if (r.tipo !== "recuperatorio" || r.nota == null) continue;
    if (r.regla === "reemplaza" || base.nota == null || r.nota > base.nota) {
      base = { nota: r.nota, fuente: "recuperatorio", idFuente: r.id };
    }
  }
  return base ?? { nota: null, fuente: null, idFuente: null };
}

export function resolverNotaConRecuperacion(
  original: ExamenConIntentos,
  recuperaciones: readonly Recuperacion[],
): NotaResuelta {
  const r = plegarRecuperaciones(
    {
      id: original.id,
      presento: presento(original.intentos),
      nota: computeAttemptGrade(original.intentos, original.retryMode),
    },
    recuperaciones.map((rec) => ({
      id: rec.id,
      presento: presento(rec.intentos),
      nota: computeAttemptGrade(rec.intentos, rec.retryMode),
      tipo: rec.tipo,
      regla: rec.regla,
      creadoEn: rec.creadoEn,
    })),
  );
  return { nota: r.nota, fuente: r.fuente, examIdFuente: r.idFuente };
}

/**
 * Lo que cada pantalla arma igual: el examen original y sus recuperaciones a
 * partir de las filas que ya cargó. Existe para que ninguna tenga que volver a
 * escribir el filtro por `parent_exam_id`, el orden ni los defaults.
 */
export interface FilaDeExamen {
  id: string;
  parent_exam_id?: string | null;
  retry_mode?: string | null;
  makeup_kind?: string | null;
  recovery_rule?: string | null;
  created_at?: string | null;
  status?: string | null;
  deleted_at?: string | null;
}

/**
 * Una recuperación en borrador o en la papelera no cuenta — igual que en el
 * acta, que ya excluye los ítems en borrador. Un examen publicado, presentado
 * y devuelto a borrador es el único caso donde esto cambia algo.
 */
const recuperacionVigente = (e: FilaDeExamen) => e.status !== "draft" && !e.deleted_at;

export function notaDeExamenParaEstudiante<I extends AttemptForGrade & { exam_id: string }>(
  examen: FilaDeExamen,
  todosLosExamenes: readonly FilaDeExamen[],
  intentosDelEstudiante: readonly I[],
): NotaResuelta {
  const intentosDe = (examId: string) => intentosDelEstudiante.filter((s) => s.exam_id === examId);
  return resolverNotaConRecuperacion(
    {
      id: examen.id,
      retryMode: (examen.retry_mode as RetryMode) ?? "last",
      intentos: intentosDe(examen.id),
    },
    todosLosExamenes
      .filter((e) => e.parent_exam_id === examen.id && recuperacionVigente(e))
      .map((e) => ({
        id: e.id,
        retryMode: (e.retry_mode as RetryMode) ?? "last",
        intentos: intentosDe(e.id),
        tipo: tipoDeRecuperacion(e.makeup_kind),
        regla: reglaDeRecuperatorio(e.recovery_rule),
        creadoEn: e.created_at ?? "",
      })),
  );
}

/**
 * Para las pantallas que cuentan ENTREGAS y no notas (Estadísticas, la Alerta
 * temprana, «qué falta del corte»): de todas las entregas de exámenes de un
 * curso, las que DECIDEN la nota de cada (examen original, estudiante),
 * atribuidas al original.
 *
 * Sin esto una recuperación se contaba como una actividad más del corte: un
 * recuperatorio de 4 estudiantes quedaba «sin empezar» para los otros 25, y
 * en la Alerta temprana les sumaba una «no entregada» — una acusación falsa
 * que alcanza, junto con cualquier otra señal, para ponerlos en rojo. Y a
 * quien perdió el parcial y el recuperatorio se le contaban dos reprobadas
 * por la misma evaluación.
 *
 * Se quedan las entregas del examen de donde salió la nota
 * (`examIdFuente`). Si el estudiante no terminó ningún intento en ninguno, se
 * quedan todas (así un intento en curso sigue contando como «en curso»). Una
 * recuperación cuyo original no está en `examenes` (en borrador o en la
 * papelera) se descarta: tampoco cuenta en el libro de notas.
 */
export function entregasQueDecidenLaNota<
  E extends AttemptForGrade & { exam_id: string; user_id: string },
>(
  examenes: readonly FilaDeExamen[],
  entregas: readonly E[],
): Array<{ examenOriginal: string; entrega: E }> {
  const porId = new Map(examenes.map((e) => [e.id, e]));
  const grupos = new Map<string, { original: FilaDeExamen; filas: E[] }>();
  for (const s of entregas) {
    const examen = porId.get(s.exam_id);
    if (!examen) continue;
    const original = examen.parent_exam_id ? porId.get(examen.parent_exam_id) : examen;
    if (!original) continue;
    const clave = `${original.id}::${s.user_id}`;
    const g = grupos.get(clave);
    if (g) g.filas.push(s);
    else grupos.set(clave, { original, filas: [s] });
  }
  const out: Array<{ examenOriginal: string; entrega: E }> = [];
  for (const { original, filas } of grupos.values()) {
    const fuente = notaDeExamenParaEstudiante(original, examenes, filas).examIdFuente;
    for (const entrega of fuente ? filas.filter((f) => f.exam_id === fuente) : filas) {
      out.push({ examenOriginal: original.id, entrega });
    }
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════
// TALLERES con recuperaciones (`workshops.parent_workshop_id`).
//
// Mismo modelo que los exámenes, con dos diferencias que vienen del taller:
//  - Un taller tiene UNA entrega (individual o de grupo), no varios intentos:
//    la nota sale de `notaEfectivaDeTaller` (respeta la sustentación) y
//    «presentó» sale de `entregaHecha`. Por eso el llamador resuelve cada
//    (taller, estudiante) a un `ItemResuelto` y este módulo solo pliega.
//  - Talleres son M:N (`workshop_courses` lleva peso/corte POR CURSO). La
//    recuperación toma el peso/corte del ORIGINAL en ese curso y se EXCLUYE de
//    las sumas de bucket; su nota ocupa el lugar de la del original.
//
// Espejo SQL: `public.workshop_effective_raw_grade` (mig 20262660000000).
// ══════════════════════════════════════════════════════════════════════

export interface FilaDeTaller {
  id: string;
  parent_workshop_id?: string | null;
  makeup_kind?: string | null;
  recovery_rule?: string | null;
  created_at?: string | null;
  status?: string | null;
  deleted_at?: string | null;
}

const recuperacionDeTallerVigente = (w: FilaDeTaller) => w.status !== "draft" && !w.deleted_at;

/**
 * La nota de un taller con sus recuperaciones. El llamador pasa `notaDe`, que
 * dado un id de taller devuelve su `ItemResuelto` (presentó + nota YA en la
 * escala en la que se comparan las notas — típicamente la del curso, para que
 * la regla «mayor» compare peras con peras aunque los `max_score` difieran).
 *
 * `idFuente` es el taller de donde salió la nota: sirve para el enlace de
 * revisión y para atribuir la entrega al original en Estadísticas.
 */
export function notaDeTallerConRecuperaciones(
  taller: FilaDeTaller,
  todosLosTalleres: readonly FilaDeTaller[],
  notaDe: (tallerId: string) => ItemResuelto,
): NotaResueltaGenerica {
  const recuperaciones = todosLosTalleres
    .filter((w) => w.parent_workshop_id === taller.id && recuperacionDeTallerVigente(w))
    .map((w) => {
      const r = notaDe(w.id);
      return {
        id: w.id,
        presento: r.presento,
        nota: r.nota,
        tipo: tipoDeRecuperacion(w.makeup_kind),
        regla: reglaDeRecuperatorio(w.recovery_rule),
        creadoEn: w.created_at ?? "",
      };
    });
  return plegarRecuperaciones(notaDe(taller.id), recuperaciones);
}

/**
 * Para las pantallas que cuentan ENTREGAS de talleres y no notas (Estadísticas,
 * Alerta temprana, «qué falta del corte»): de todas las entregas de talleres de
 * un curso, las que DECIDEN la nota de cada (taller original, estudiante),
 * atribuidas al original. Espejo de `entregasQueDecidenLaNota` de exámenes.
 *
 * `notaDe(tallerId, userId)` resuelve el `ItemResuelto` de esa celda.
 */
export function entregasDeTallerQueDecidenLaNota<
  E extends { workshop_id: string; user_id: string },
>(
  talleres: readonly FilaDeTaller[],
  entregas: readonly E[],
  notaDe: (tallerId: string, userId: string) => ItemResuelto,
): Array<{ tallerOriginal: string; entrega: E }> {
  const porId = new Map(talleres.map((w) => [w.id, w]));
  const grupos = new Map<string, { original: FilaDeTaller; filas: E[] }>();
  for (const s of entregas) {
    const taller = porId.get(s.workshop_id);
    if (!taller) continue;
    const original = taller.parent_workshop_id ? porId.get(taller.parent_workshop_id) : taller;
    if (!original) continue;
    const clave = `${original.id}::${s.user_id}`;
    const g = grupos.get(clave);
    if (g) g.filas.push(s);
    else grupos.set(clave, { original, filas: [s] });
  }
  const out: Array<{ tallerOriginal: string; entrega: E }> = [];
  for (const { original, filas } of grupos.values()) {
    const userId = filas[0].user_id;
    const fuente = notaDeTallerConRecuperaciones(original, talleres, (id) =>
      notaDe(id, userId),
    ).idFuente;
    for (const entrega of fuente ? filas.filter((f) => f.workshop_id === fuente) : filas) {
      out.push({ tallerOriginal: original.id, entrega });
    }
  }
  return out;
}

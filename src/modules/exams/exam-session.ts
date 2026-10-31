import { eventoSumoStrike } from "./proctoring";
/**
 * Utilidades puras para el ciclo de vida de una sesión de examen estudiantil.
 * Extraídas del componente TakeExam para que sean testeables sin renderizar.
 */

type TimerControl = {
  action: string;
  extra_seconds: number | null;
  target_user_id: string | null;
};

/**
 * Suma los segundos extra concedidos a un estudiante desde exam_timer_controls.
 * Solo cuenta filas con action="add_time". Las filas de pausa/reanudación se ignoran.
 */
export function computeExtraSeconds(controls: TimerControl[]): number {
  return controls
    .filter((c) => c.action === "add_time")
    .reduce((sum, c) => sum + (Number(c.extra_seconds) || 0), 0);
}

/**
 * Extiende un ISO end_time por extraSeconds segundos.
 * Si extraSeconds <= 0, devuelve el endTime original sin modificar.
 */
export function applyExtraTime(endTime: string, extraSeconds: number): string {
  if (extraSeconds <= 0) return endTime;
  return new Date(new Date(endTime).getTime() + extraSeconds * 1000).toISOString();
}

/**
 * Devuelve el índice de pregunta persistido en answers.__current_idx,
 * o 0 si no existe, no es número, o es negativo.
 *
 * `questionCount` (opcional) acota el índice a [0, questionCount-1]: si el
 * docente eliminó preguntas entre dos sesiones del alumno, un índice persistido
 * fuera de rango dejaría la pantalla sin pregunta visible (y en modo secuencial,
 * sin forma de volver atrás). Pasarlo siempre que se conozca el total.
 */
export function restoreQuestionIndex(
  answers: Record<string, unknown>,
  questionCount?: number,
): number {
  const idx = answers.__current_idx;
  if (typeof idx !== "number" || idx < 0) return 0;
  if (typeof questionCount === "number" && questionCount > 0) {
    return Math.min(idx, questionCount - 1);
  }
  return idx;
}

/** Copia local de las respuestas, con la forma que guarda `offline-sync.ts`. */
export interface CopiaLocalDeRespuestas {
  submissionId: string;
  answers: Record<string, unknown>;
}

/** Modos de guardado del examen (`app_settings.exam_autosave_mode`). Espejo del
 *  CHECK de la migración `20262750000000`; un test compara las dos listas. */
export const MODOS_GUARDADO_EXAMEN = ["al_cambiar_pregunta", "continuo"] as const;

/** Las claves que empiezan con `__` son metadatos del intento (sesión, pregunta
 *  visible, advertencias, desglose de la nota…), no respuestas. */
const esMetadato = (clave: string) => clave.startsWith("__");

/**
 * Firma del CONTENIDO de unas respuestas: todo menos `__saved_at`, que es el
 * sello de cuándo se guardaron. Dos guardados con la misma firma no tienen nada
 * nuevo, y re-sellar sin cambios hace que la copia local parezca más nueva que
 * el servidor sin serlo (ver `combinarCopiaConServidor`).
 */
export function firmaDeRespuestas(answers: Record<string, unknown>): string {
  return JSON.stringify(answers, (k, v) => (k === "__saved_at" ? undefined : v));
}

/**
 * Firma del CONTENIDO que amerita una escritura en la base: las respuestas, la
 * sesión (`__session_id`) y las advertencias (`__warning_events`). Excluye
 * `__saved_at` (sello de tiempo) Y, a diferencia de `firmaDeRespuestas`, también
 * `__current_idx` — la pregunta que el alumno está MIRANDO.
 *
 * ── Por qué el índice NO cuenta como contenido ─────────────────────────
 * Navegar entre preguntas cambia el índice pero no lo que el alumno respondió.
 * Reescribir la fila ENTERA de `answers` (TOAST de ~6 KB de mediana) solo para
 * mover ese número es exactamente la escritura que, al "dar siguiente sin haber
 * cambiado nada", saturaba la E/S de la instancia con 120+ alumnos a la vez. El
 * índice es una comodidad del monitor del docente ("Pregunta X de Y"): viaja
 * GRATIS cuando una escritura de contenido ocurre, pero no justifica una por sí
 * solo. Si dos firmas de contenido coinciden, la base ya tiene lo que importa y
 * el guardado se puede saltar; el bloqueo de sesión lo sostiene el latido
 * (`updated_at`), no esta fila.
 */
export function firmaDeContenido(answers: Record<string, unknown>): string {
  return JSON.stringify(answers, (k, v) =>
    k === "__saved_at" || k === "__current_idx" ? undefined : v,
  );
}

/**
 * Qué escribir al combinar la copia local del dispositivo con la entrega del
 * servidor. Es la regla ÚNICA para los dos momentos en que se combinan: al
 * reanudar el intento (qué mostrar) y al sincronizar la copia pendiente (qué
 * subir).
 *
 * Desde que el examen guarda en la base solo al cambiar de pregunta, la copia
 * local es el respaldo de lo que el alumno escribió en la pregunta en curso. La
 * copia gana solo si:
 *  - es de ESTE intento;
 *  - es de la misma sesión (si otro dispositivo tomó el intento, el servidor es
 *    el vigente);
 *  - es más nueva por `__saved_at` (si alguno no tiene sello, se acepta: es el
 *    comportamiento que ya tenía la sincronización con copias viejas);
 *  - y tiene respuestas DISTINTAS. Sin esto, una copia re-sellada sin cambios
 *    «ganaba» y, al subirla, revertía lo que el servidor cambió después — por
 *    ejemplo una advertencia que el docente perdonó.
 *
 * Cuando gana, se toman de la copia SOLO las respuestas, la pregunta visible y
 * el sello. Todos los metadatos del servidor se conservan: las advertencias los
 * registra el proctoring en el servidor al instante y el docente puede
 * perdonarlas, y el desglose de la nota no es del alumno.
 *
 * Cuando NO gana por respuestas pero es de este intento, de esta sesión y más
 * nueva, igual aporta la pregunta visible (`__current_idx`): navegar sin cambiar
 * nada ya no escribe en la base (`firmaDeContenido`), así que el índice del
 * servidor puede estar atrasado y reanudar llevaría al alumno a una pregunta
 * anterior. `usoLocal` sigue en false: no hay nada que subir ni que avisar.
 */
export function combinarCopiaConServidor(
  servidor: Record<string, unknown>,
  local: CopiaLocalDeRespuestas | null | undefined,
  submissionId: string,
): { answers: Record<string, unknown>; usoLocal: boolean } {
  const sinCambios = { answers: servidor, usoLocal: false };
  if (!local || local.submissionId !== submissionId || !local.answers) return sinCambios;
  const copia = local.answers;
  const sesionServidor = servidor.__session_id;
  const sesionLocal = copia.__session_id;
  if (sesionServidor && sesionLocal && sesionServidor !== sesionLocal) return sinCambios;
  const guardadoServidor = Number(servidor.__saved_at ?? 0);
  const guardadoLocal = Number(copia.__saved_at ?? 0);
  if (guardadoServidor > 0 && guardadoLocal > 0 && guardadoLocal <= guardadoServidor) return sinCambios;
  const respuestas = Object.keys(copia).filter((k) => !esMetadato(k));
  const distinta = respuestas.some((k) => JSON.stringify(copia[k]) !== JSON.stringify(servidor[k]));
  if (!distinta) {
    return copia.__current_idx !== undefined && copia.__current_idx !== servidor.__current_idx
      ? { answers: { ...servidor, __current_idx: copia.__current_idx }, usoLocal: false }
      : sinCambios;
  }
  const answers: Record<string, unknown> = { ...servidor };
  for (const k of respuestas) answers[k] = copia[k];
  if (copia.__current_idx !== undefined) answers.__current_idx = copia.__current_idx;
  if (copia.__saved_at !== undefined) answers.__saved_at = copia.__saved_at;
  return { answers, usoLocal: true };
}

/** Lo que muestra la pantalla al reanudar: la misma regla que la sincronización. */
export const respuestasAlReanudar = combinarCopiaConServidor;

/**
 * Subida periódica: en el modo por defecto la base recibe las respuestas al
 * cambiar de pregunta, y además el latido las lleva si hay cambios que la base
 * no tiene y el último guardado fue hace más de esto. Acota lo que se pierde si
 * el dispositivo se apaga y el intento vence (el cierre automático usa lo que
 * tiene la base), y deja que el monitor del docente vea el avance de una
 * pregunta larga. Con 60 alumnos es a lo sumo una escritura pesada por segundo.
 */
export const MS_SUBIDA_PERIODICA = 60_000;

export function debeSubirRespuestas(
  firmaActual: string,
  firmaEnServidor: string,
  msDesdeUltimoGuardado: number,
): boolean {
  return firmaActual !== firmaEnServidor && msDesdeUltimoGuardado >= MS_SUBIDA_PERIODICA;
}

// ─────────────────────────────────────────────────────────────────────────────
// Latido del bloqueo de sesión
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ventana de DISPERSIÓN de la auto-entrega al vencerse el tiempo.
 *
 * Todos los relojes del examen llegan a cero en el MISMO segundo de pared
 * (comparten `end_time`), así que sin esto 200 alumnos entregan a la vez: 200
 * escrituras de la fila entera + 200 encolados de IA + notificaciones en uno o
 * dos segundos — el "pico de cierre" que el dueño pidió aplanar. Cada cliente
 * espera un retraso ALEATORIO dentro de esta ventana antes de entregar, con lo
 * que el pico se reparte (con 8 s, ~25 entregas/s en vez de ~200 de golpe).
 *
 * Es seguro que la ventana sea holgada: `close_expired_exam_attempts` corre por
 * cron cada minuto y cierra lo que haya quedado `en_progreso`, así que el retraso
 * jamás deja una entrega sin registrar. Y las respuestas se CONGELAN al llegar a
 * cero (ver `tiempoAgotadoRef` en la pantalla), de modo que el retraso no le da
 * ni un segundo extra de edición a nadie.
 */
export const MS_DISPERSION_ENTREGA_AUTOMATICA = 8_000;

/** Retraso aleatorio (ms) para dispersar la auto-entrega. `rnd` ∈ [0,1) — se
 *  inyecta para poder testear sin `Math.random`. */
export function retrasoDeEntregaAutomatica(rnd: number): number {
  const acotado = Math.max(0, Math.min(1, Number(rnd) || 0));
  return Math.floor(acotado * MS_DISPERSION_ENTREGA_AUTOMATICA);
}

/** Ventana del bloqueo: si `submissions.updated_at` tiene MENOS de esto, se
 *  considera que otro dispositivo sigue vivo en el intento y no se le puede
 *  robar. Está replicada en la pantalla de toma, que es quien la compara.
 *  Pasar a otro dispositivo cuesta, como mucho, esperar esto. */
export const MS_BLOQUEO_SESION = 60_000;

/**
 * Cada cuánto late la pantalla de examen para refrescar `updated_at`.
 *
 * 30 s y no 5 s, medido: el latido es la escritura MÁS frecuente del examen y lo
 * que agota la instancia son las escrituras (su E/S). En la prueba de carga del
 * 2026-10-30 (`scripts/exam-load-test.mjs`, instancia de producción) con latido
 * de 5 s, 150 alumnos simultáneos daban p95 de 0,8 s y 200 colapsaban: latidos
 * de 26 s y guardados de hasta 42 s. A 200 alumnos eran ~35 de las ~44 escrituras
 * por segundo. Con 20 s eran ~10 (p95 de 7,6 s con 200) y con 30 s son ~7. El costo es el bloqueo: `MS_BLOQUEO_SESION` tiene
 * que crecer con el latido (ver `latidoEsRedundante`), así que pasar a otro
 * dispositivo espera hasta 60 s en vez de 10.
 */
export const MS_ENTRE_LATIDOS = 30_000;

/** Si un guardado en la base ocurrió hace menos de esto, el latido se SALTA. */
export const MS_GUARDADO_RECIENTE = 3_000;

/**
 * ¿El latido de este tick es redundante?
 *
 * ── Qué ahorra ────────────────────────────────────────────────────────
 * Un guardado en la base y el latido escriben la MISMA fila, y el guardado ya
 * refresca `updated_at` — que es lo único que el bloqueo mira —, así que el
 * latido de ese tick no aporta nada. Desde que el examen guarda en la base solo
 * al cambiar de pregunta (y no tras cada cambio), esto se salta pocas veces: el
 * latido es la escritura más frecuente del examen.
 *
 * ── El margen, que es lo que hay que no romper ────────────────────────
 * Saltarse un tick retrasa el refresco como máximo `MS_GUARDADO_RECIENTE +
 * MS_ENTRE_LATIDOS`: el peor caso es que el guardado ocurra justo antes de un
 * tick (se salta) y no haya más actividad, así que el siguiente tick escribe un
 * ciclo después. Ese total tiene que quedar POR DEBAJO de `MS_BLOQUEO_SESION`,
 * o el intento se declararía abandonado y otro dispositivo podría reclamarlo —
 * al propio alumno, en mitad del examen. Hay un test que lo vigila.
 */
export function latidoEsRedundante(msDesdeUltimoGuardado: number): boolean {
  return msDesdeUltimoGuardado < MS_GUARDADO_RECIENTE;
}

// ─────────────────────────────────────────────────────────────────────────────
// Borrado de advertencias (usado por el monitor docente). Cuando se borra una
// advertencia y el conteo cae bajo el umbral, restauramos la submission a
// "en_progreso" + submitted_at=null para que el estudiante pueda reingresar.
// ─────────────────────────────────────────────────────────────────────────────

export type WarningEventLike = {
  type?: string;
  at?: string | number;
  ts?: number;
  questionIdx?: number | null;
  questionId?: string | null;
  /** ¿Sumó strike? Lo escribe quien registró el evento. Ver `eventoSumoStrike`. */
  suma?: boolean;
};

export interface ClearWarningInput {
  status: string;
  focusWarnings: number;
  events: WarningEventLike[];
  examMaxWarnings: number;
  /**
   * Si el examen sigue abierto (now ∈ [start_time, end_time]).
   * - true:  sospechoso bajo el umbral → en_progreso (estudiante puede reingresar)
   * - false: sospechoso bajo el umbral → completado (la ventana cerró, no hay reingreso)
   */
  examIsOpen: boolean;
}

export interface ClearWarningResult {
  status: string;
  focusWarnings: number;
  events: WarningEventLike[];
  /** Si pasa a true, hay que limpiar `submitted_at` en la DB para reanudar. */
  clearSubmittedAt: boolean;
  /** True si la submission pasó de "sospechoso" → "en_progreso" en esta operación. */
  restoredToInProgress: boolean;
  /** True si la submission pasó de "sospechoso" → "completado" (examen ya cerró). */
  closedAsCompletado: boolean;
}

/**
 * Resultado de borrar UNA advertencia puntual del array (índice idx).
 * No muta el input; devuelve el nuevo estado a persistir.
 */
export function applyClearOneWarning(
  input: ClearWarningInput,
  idx: number,
): ClearWarningResult {
  const safe = clampWarningInput(input);
  if (idx < 0 || idx >= safe.events.length) {
    return {
      status: safe.status,
      focusWarnings: safe.focusWarnings,
      events: safe.events,
      clearSubmittedAt: false,
      restoredToInProgress: false,
      closedAsCompletado: false,
    };
  }
  const nextEvents = safe.events.filter((_, i) => i !== idx);
  // El contador baja SOLO si el evento borrado había sumado un strike. El array
  // mezcla los strikes reales con señales blandas (`copiar`, `pegar`, `cortar`,
  // `screenshot_attempt`) que se registran para que el docente las vea pero no
  // suman — ver `eventoSumoStrike`. Antes se decrementaba para cualquier índice,
  // así que perdonar un "Intento de copiar" regalaba un strike inexistente y,
  // si eso cruzaba el umbral hacia abajo, DES-SUSPENDÍA al alumno.
  //
  // Se pregunta por el EVENTO y no por su tipo: desde que pegar puede sumar o no
  // según la pregunta, el tipo dejó de alcanzar. El servidor ya decide así
  // (`_exam_warning_event_is_strike`); si acá se decidiera distinto, el docente
  // vería un aviso que no coincide con lo que la fila hizo de verdad.
  const borrado = safe.events[idx];
  const nextWarnings = borrado && eventoSumoStrike(borrado)
    ? Math.max(0, safe.focusWarnings - 1)
    : safe.focusWarnings;
  const belowThreshold = safe.status === "sospechoso" && nextWarnings < safe.examMaxWarnings;
  return finalizeResult(safe, belowThreshold, nextWarnings, nextEvents);
}

/**
 * Resultado de borrar TODAS las advertencias.
 */
export function applyClearAllWarnings(input: ClearWarningInput): ClearWarningResult {
  const safe = clampWarningInput(input);
  const wasSospechoso = safe.status === "sospechoso";
  return finalizeResult(safe, wasSospechoso, 0, []);
}

function finalizeResult(
  safe: ClearWarningInput,
  shouldRestore: boolean,
  nextWarnings: number,
  nextEvents: WarningEventLike[],
): ClearWarningResult {
  if (!shouldRestore) {
    return {
      status: safe.status,
      focusWarnings: nextWarnings,
      events: nextEvents,
      clearSubmittedAt: false,
      restoredToInProgress: false,
      closedAsCompletado: false,
    };
  }
  if (safe.examIsOpen) {
    return {
      status: "en_progreso",
      focusWarnings: nextWarnings,
      events: nextEvents,
      clearSubmittedAt: true,
      restoredToInProgress: true,
      closedAsCompletado: false,
    };
  }
  // Ventana cerrada: no podemos reabrir el examen, dejamos como completado limpio.
  return {
    status: "completado",
    focusWarnings: nextWarnings,
    events: nextEvents,
    clearSubmittedAt: false,
    restoredToInProgress: false,
    closedAsCompletado: true,
  };
}

function clampWarningInput(input: ClearWarningInput): ClearWarningInput {
  return {
    status: input.status,
    focusWarnings: Math.max(0, Number(input.focusWarnings) || 0),
    events: Array.isArray(input.events) ? input.events : [],
    examMaxWarnings: Math.max(1, Number(input.examMaxWarnings) || 3),
    examIsOpen: Boolean(input.examIsOpen),
  };
}

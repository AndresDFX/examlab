/**
 * Helper de calificación con IA (sync vs async batch).
 *
 * Política:
 *   - `ai_model_settings.processing_mode = 'async'` (default): los jobs
 *     IA se encolan en `ai_grading_queue` y el worker hourly los drena.
 *     La fila destino se inserta/actualiza con `ai_grade=NULL` y
 *     `ai_feedback='Pendiente IA…'` ANTES de encolar.
 *   - `processing_mode = 'sync'`: la llamada IA se hace inmediatamente
 *     (comportamiento legacy).
 *   - Override de código: si el usuario activó un código admin via RPC
 *     `activate_ai_override`, queda guardado en localStorage con
 *     expiración. Mientras esté vigente, las llamadas IA se hacen
 *     sync aunque el modo global sea async.
 *
 * El helper expone `aiGradeOrEnqueue(opts)` que decide en runtime cuál
 * camino tomar. El caller pasa:
 *   - `target`: tabla + row id donde escribir el resultado IA.
 *   - `invokeBody`: el body que mandaría hoy a `supabase.functions.invoke
 *     ('ai-grade-submission', { body })`. Se reusa idéntico en ambos
 *     caminos.
 *
 * El caller pre-existente (que ya hace la llamada sync directo) sigue
 * funcionando — este helper SE OPTA-IN: cuando lo invocas, gana las
 * decisiones; sino, todo pasa sync como antes.
 */
import { supabase } from "@/integrations/supabase/client";
import { extractEdgeError } from "@/shared/lib/edge-error";

const OVERRIDE_LOCAL_KEY = "examlab_ai_override";

interface OverrideState {
  expiresAt: string;
}

export function readOverrideExpiry(): Date | null {
  try {
    const raw = localStorage.getItem(OVERRIDE_LOCAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as OverrideState;
    const exp = new Date(parsed.expiresAt);
    if (Number.isNaN(exp.getTime()) || exp.getTime() <= Date.now()) {
      localStorage.removeItem(OVERRIDE_LOCAL_KEY);
      return null;
    }
    return exp;
  } catch {
    return null;
  }
}

export function writeOverrideExpiry(expiresAtIso: string): void {
  localStorage.setItem(OVERRIDE_LOCAL_KEY, JSON.stringify({ expiresAt: expiresAtIso }));
}

export function clearOverrideExpiry(): void {
  localStorage.removeItem(OVERRIDE_LOCAL_KEY);
}

/** Resuelve el `processing_mode` global (sync/async). Cacheado por sesión. */
let cachedMode: "sync" | "async" | null = null;
let cachedModeAt = 0;
const MODE_CACHE_MS = 30_000;

export async function getProcessingMode(): Promise<"sync" | "async"> {
  const now = Date.now();
  if (cachedMode && now - cachedModeAt < MODE_CACHE_MS) return cachedMode;
  try {
    // Multi-tenant: hay UNA fila `is_active` POR TENANT + la fila
    // platform-default (`tenant_id IS NULL`). El `.maybeSingle()` viejo
    // ROMPÍA (>1 fila → data null) y caía a "async", IGNORANDO el modo del
    // tenant (ej. un tenant en `sync` quedaba forzado a la cola). Resolvemos
    // como el edge `getActiveAiModel`: preferimos la fila del PROPIO tenant
    // sobre la platform-default. La RLS ya acota a (filas del tenant del
    // usuario + la platform-default), así que ordenar por `tenant_id` con los
    // NULL al final pone la fila del tenant primero; `limit(1)` la elige.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("ai_model_settings")
      .select("processing_mode, tenant_id")
      .eq("is_active", true)
      .order("tenant_id", { ascending: false, nullsFirst: false })
      .limit(1);
    const row = Array.isArray(data) ? data[0] : data;
    const mode = row?.processing_mode === "sync" ? "sync" : "async";
    cachedMode = mode;
    cachedModeAt = now;
    return mode;
  } catch {
    // Fallback conservador: async (encolar). Mejor un retraso que
    // saturar la cuenta IA si algo está roto.
    return "async";
  }
}

/** Limpia el cache local — útil si admin acaba de cambiar el modo. */
export function invalidateModeCache(): void {
  cachedMode = null;
}

/** Resultado puro de la decisión del gate de IA (generación). */
export type AiGateOutcome = "proceed-sync" | "proceed-async" | "dialog";

/**
 * Decide el camino del gate de IA para GENERACIÓN, sin tocar React/DB
 * (testeable). Invariante clave: en modo BATCH (`async`) SIEMPRE se respeta
 * la cola — nadie corre inline salvo (a) modo global `sync`, o (b) un código
 * "IA inmediata" vigente.
 *
 *   - `sync`            → inline (`proceed-sync`).
 *   - override vigente  → inline (`proceed-sync`) — el cap real lo enforza
 *                         `claim_ai_override_message` server-side.
 *   - `async` sin override:
 *       · Admin/SuperAdmin: NO se les muestra el dialog (sería ruido), pero
 *         tampoco se les deja saltar la cola: se ENCOLA (`proceed-async`) si
 *         el flujo soporta cola; si no, cae al dialog. Antes los admins
 *         devolvían `proceed-sync` y corrían inline aunque el modo fuera
 *         batch — eso violaba "respetar la cola en batch".
 *       · Docente: dialog (cancelar / encolar / activar código).
 */
export function resolveAiGateDecision(args: {
  isAdmin: boolean;
  mode: "sync" | "async";
  hasOverride: boolean;
  allowQueue: boolean;
}): AiGateOutcome {
  if (args.mode === "sync") return "proceed-sync";
  if (args.hasOverride) return "proceed-sync";
  if (args.isAdmin) return args.allowQueue ? "proceed-async" : "dialog";
  return "dialog";
}

export interface AiGradeTarget {
  /** Tabla destino para escribir el resultado IA. Ej. `submissions`,
   *  `workshop_answers`, `project_submission_files`. */
  table: string;
  /** PK del registro destino. */
  rowId: string;
  /** Nombre de la columna donde escribir la nota numérica. */
  fieldGrade?: string;
  /** Nombre de la columna donde escribir el feedback texto. */
  fieldFeedback?: string;
  /** Nombre de la columna donde escribir el ai_likelihood (0..1). */
  fieldLikelihood?: string;
  /** Nombre de la columna donde escribir las razones IA. */
  fieldReasons?: string;
  /** Para filtros de dashboard (qué curso pertenece este job). */
  courseId?: string | null;
}

export interface AiGradeRequest {
  /** Etiqueta del tipo de job — útil para logs/dashboard. */
  kind: string;
  /** Edge function destino. Default `ai-grade-submission`. */
  invokeTarget?: string;
  /** Body que se mandaría con `supabase.functions.invoke(target, { body })`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: Record<string, any>;
  /** Dónde persistir el resultado (sólo para modo async). */
  target: AiGradeTarget;
}

export interface AiGradeResult {
  /** true si el job se ejecutó sync y `aiData` contiene la respuesta IA. */
  ranSync: boolean;
  /** Cuando `ranSync=true`, la respuesta del edge function. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aiData?: Record<string, any>;
  /** id del job encolado cuando `ranSync=false`. */
  jobId?: string;
  /** Mensaje de error si la llamada sync falló o el enqueue falló. */
  error?: string;
}

/**
 * Decide entre sync/async según processing_mode + override activo.
 *
 * Modo SYNC (override activo O processing_mode='sync'):
 *   Llama directo a `supabase.functions.invoke(invokeTarget, { body })`
 *   y devuelve la respuesta. El caller persiste como hoy.
 *
 * Modo ASYNC:
 *   Encola via RPC `enqueue_ai_grading` y devuelve {ranSync: false,
 *   jobId}. El caller DEBE haber insertado el row destino antes con
 *   `ai_grade=NULL` y `ai_feedback='Pendiente IA…'` para que el alumno
 *   vea el estado en la UI.
 */
export async function aiGradeOrEnqueue(
  req: AiGradeRequest,
  opts?: {
    /** Cuando true, IGNORA el override "IA inmediata" y respeta ESTRICTAMENTE
     *  el `processing_mode` global: async → encola, sync → ejecuta inline.
     *  Lo usa la calificación en lote ("Calificar todos"): el override está
     *  pensado para calificaciones puntuales on-demand, no para forzar sync
     *  un batch que debe ir a la cola. El único flujo siempre-sync es el
     *  Tutor IA (que no pasa por acá). */
    ignoreOverride?: boolean;
  },
): Promise<AiGradeResult> {
  const invokeTarget = req.invokeTarget ?? "ai-grade-submission";
  const overrideExp = opts?.ignoreOverride ? null : readOverrideExpiry();
  const mode = await getProcessingMode();

  // Path SYNC explícito (admin puso processing_mode='sync'): bypass del
  // sistema de override + cap, todo va sync sin gastar cupos. Esto
  // existe para entornos de prueba o instituciones que prefieren
  // pagar IA siempre on-demand.
  if (mode === "sync") {
    const { data, error } = await supabase.functions.invoke(invokeTarget, {
      body: req.body,
    });
    if (error || data?.error) {
      const detail = await extractEdgeError(error, data);
      return { ranSync: true, error: detail || "Error IA" };
    }
    return { ranSync: true, aiData: data };
  }

  // Path OVERRIDE (mode=async pero el docente tiene una activación
  // vigente). Antes de cada llamada sync, intentamos claim 1 mensaje
  // de la activación — atómico server-side, respeta el cap. Si el
  // claim falla porque agotó el cap O la activación expiró por
  // tiempo, caemos al path async (encolar) — no le devolvemos error
  // al docente, queda transparente.
  if (overrideExp) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: claimData } = await (supabase as any).rpc("claim_ai_override_message");
    const claimed = (claimData as { ok?: boolean; reason?: string } | null)?.ok === true;
    if (claimed) {
      const { data, error } = await supabase.functions.invoke(invokeTarget, {
        body: req.body,
      });
      if (error || data?.error) {
        const detail = await extractEdgeError(error, data);
        return { ranSync: true, error: detail || "Error IA" };
      }
      return { ranSync: true, aiData: data };
    }
    // Si el claim falló por cap_reached o expiración, limpiamos el
    // localStorage para que el resto de la UI deje de mostrar el
    // badge "IA inmediata activa".
    if (
      (claimData as { reason?: string } | null)?.reason === "cap_reached" ||
      (claimData as { reason?: string } | null)?.reason === "no_active_override"
    ) {
      clearOverrideExpiry();
    }
    // Cae al path async abajo.
  }

  // Async: encolar.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc("enqueue_ai_grading", {
    _kind: req.kind,
    _invoke_target: invokeTarget,
    _body: req.body,
    _target_table: req.target.table,
    _target_row_id: req.target.rowId,
    _field_grade: req.target.fieldGrade ?? "ai_grade",
    _field_feedback: req.target.fieldFeedback ?? "ai_feedback",
    _field_likelihood: req.target.fieldLikelihood ?? null,
    _field_reasons: req.target.fieldReasons ?? null,
    _course_id: req.target.courseId ?? null,
  });
  if (error) {
    return { ranSync: false, error: error.message };
  }
  // Audit log fire-and-forget: deja trazo de cada job encolado. El
  // ciclo de vida posterior (claim/complete/fail/cancel) se loguea
  // desde el worker y desde el módulo Cron — así el admin puede armar
  // un timeline completo del job en `audit_logs`.
  const jobId = data as string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  void (supabase as any)
    .rpc("log_audit_event", {
      p_action: "ai_grading.job_enqueued",
      p_category: "grading",
      p_severity: "info",
      p_entity_type: "ai_grading_queue",
      p_entity_id: jobId,
      p_entity_name: req.kind,
      p_course_id: req.target.courseId ?? null,
      p_metadata: {
        kind: req.kind,
        invoke_target: invokeTarget,
        target_table: req.target.table,
        target_row_id: req.target.rowId,
      },
    })
    .then(() => {})
    .catch(() => {});
  return { ranSync: false, jobId };
}

/**
 * Cancela los jobs de IA pendientes/processing encolados para una entrega
 * cuando el docente la califica/gestiona MANUALMENTE — así la IA no la
 * vuelve a procesar (gasta cupo, pisa estado). Cubre la entrega + sus hijos
 * (answers de taller / files de proyecto) vía la RPC genérica.
 *
 * Fire-and-forget seguro: si falla, el peor caso es que el worker procese un
 * job stale (escribe `ai_grade`, NO `final_grade`), así que la nota manual
 * del docente NO se pierde — solo loggeamos el warning.
 *
 * @param table  'submissions' | 'workshop_submissions' | 'project_submissions'
 * @param rowId  id de la entrega
 * @param reason mensaje opcional para el `last_error` del job cancelado
 * @returns número de jobs cancelados (0 si no había nada en cola)
 */
export async function cancelPendingAiJobsForTarget(
  table: "submissions" | "workshop_submissions" | "project_submissions",
  rowId: string,
  reason?: string,
): Promise<number> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("cancel_pending_ai_jobs_by_target", {
      _target_table: table,
      _target_row_id: rowId,
      _reason: reason ?? null,
    });
    if (error) {
      console.warn("[ai-grading] cancel_pending_ai_jobs_by_target falló", error.message);
      return 0;
    }
    return Number(data ?? 0);
  } catch (e) {
    console.warn("[ai-grading] cancel_pending_ai_jobs_by_target excepción", e);
    return 0;
  }
}

/** Mensaje placeholder visible al estudiante mientras la IA está encolada. */
export const PENDING_AI_FEEDBACK = "Pendiente IA — la calificación llegará al procesar la cola.";

/**
 * ¿La calificación del estudiante quedó pendiente de IA?
 * Heurística usada en banners + listados del estudiante:
 *   - ai_grade no asignada (null / undefined)
 *   - Y/O ai_feedback es el placeholder `PENDING_AI_FEEDBACK`
 * Cualquiera de las dos basta. NO usar para flujos donde la nota
 * legítima puede ser 0 sin feedback (caso unrelated).
 */
export function isAiGradePending(opts: {
  ai_grade?: number | null;
  ai_feedback?: string | null;
}): boolean {
  const hasFeedbackPlaceholder = (opts.ai_feedback ?? "").trim() === PENDING_AI_FEEDBACK;
  const noGrade = opts.ai_grade == null;
  return hasFeedbackPlaceholder || noGrade;
}

/**
 * Texto estándar que mostramos al estudiante cuando su entrega
 * queda encolada. Decidimos un copy mínimo ("Por calificar") porque
 * el estudiante no necesita conocer el detalle del flow async/cola/
 * worker — solo saber que la nota todavía no está. Más conciso →
 * menos ruido en las vistas y menos confusión.
 */
export const QUEUED_STUDENT_TITLE = "Por calificar";
/** Body opcional. Vacío por default: el banner y el toast solo muestran
 *  el title. Mantengo el export por si en el futuro queremos un mensaje
 *  expandido (e.g. para un tooltip más detallado). */
export const QUEUED_STUDENT_BODY = "";

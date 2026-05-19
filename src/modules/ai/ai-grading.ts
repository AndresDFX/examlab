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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (supabase as any)
      .from("ai_model_settings")
      .select("processing_mode")
      .eq("is_active", true)
      .maybeSingle();
    const mode = data?.processing_mode === "sync" ? "sync" : "async";
    cachedMode = mode;
    cachedModeAt = now;
    return mode;
  } catch {
    // Fallback conservador: async (encolar). Mejor un retraso de 1h que
    // saturar la cuenta IA si algo está roto.
    return "async";
  }
}

/** Limpia el cache local — útil si admin acaba de cambiar el modo. */
export function invalidateModeCache(): void {
  cachedMode = null;
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
export async function aiGradeOrEnqueue(req: AiGradeRequest): Promise<AiGradeResult> {
  const invokeTarget = req.invokeTarget ?? "ai-grade-submission";
  const overrideExp = readOverrideExpiry();
  const mode = await getProcessingMode();
  const shouldRunSync = !!overrideExp || mode === "sync";

  if (shouldRunSync) {
    const { data, error } = await supabase.functions.invoke(invokeTarget, {
      body: req.body,
    });
    if (error || data?.error) {
      const detail = await extractEdgeError(error, data);
      return { ranSync: true, error: detail || "Error IA" };
    }
    return { ranSync: true, aiData: data };
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
  return { ranSync: false, jobId: data as string };
}

/** Mensaje placeholder visible al estudiante mientras la IA está encolada. */
export const PENDING_AI_FEEDBACK = "Pendiente IA — la calificación llegará al procesar la cola.";

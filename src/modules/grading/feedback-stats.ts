/**
 * Helpers para el card "Comentarios pendientes por respuesta" del
 * dashboard del docente y para el filtro del OpenFeedbackModal.
 *
 * Definición ROL-BASED (no por user_id): un thread está pendiente de
 * respuesta del docente cuando está abierto (`closed=false`) y el
 * ÚLTIMO comentario lo escribió alguien con `author_role !== 'teacher'`
 * (típicamente un estudiante). Si CUALQUIER docente del curso ya
 * respondió, el thread NO cuenta como pendiente — la pelota está en la
 * cancha del estudiante hasta que él vuelva a escribir.
 *
 * Razón: cuando hay dos docentes en el mismo curso, basta con que uno
 * conteste para que el otro vea que el asunto está atendido. Si lo
 * filtráramos por "no fue mi user_id", el segundo docente vería el
 * thread como pendiente aunque ya esté respondido.
 *
 * Esta lógica vive como helper puro para ser testeable sin Supabase.
 * Los callers (dashboard + modal) traen los comentarios via PostgREST
 * incluyendo `author_role` y los pasan a estas funciones.
 */

export interface CommentLite {
  /** ID del thread al que pertenece el comentario. */
  thread_id: string;
  /** 'teacher' | 'student' (también acepta NULL para comments viejos
   *  pre-migración del campo author_role — se tratan como 'student'). */
  author_role: string | null | undefined;
  /** Timestamp ISO. Se usa para identificar EL último (el más reciente). */
  created_at: string;
}

/** Considera un comment como "respuesta del docente" cuando el rol es
 *  exactamente 'teacher'. Cualquier otro valor (student, admin, null) NO
 *  cuenta como respuesta — el thread queda pendiente. */
export function isTeacherComment(c: { author_role: string | null | undefined }): boolean {
  return c.author_role === "teacher";
}

/**
 * Devuelve un Map `thread_id → último comment` quedándose con el comment
 * más reciente por thread (mayor `created_at`). Acepta los comentarios
 * en cualquier orden — internamente compara timestamps.
 */
export function lastCommentByThread(
  comments: readonly CommentLite[],
): Map<string, CommentLite> {
  const out = new Map<string, CommentLite>();
  for (const c of comments) {
    const prev = out.get(c.thread_id);
    if (!prev || c.created_at > prev.created_at) {
      out.set(c.thread_id, c);
    }
  }
  return out;
}

/**
 * Cuenta los threads cuyo ÚLTIMO comentario NO es de un docente.
 * Los threads que existen pero no tienen comentarios todavía NO cuentan
 * — no hay nada pendiente de "respuesta" si no hay primer comentario.
 *
 * @param threadIds - IDs de threads abiertos a considerar.
 * @param comments - Comentarios (cualquier orden) de esos threads.
 */
export function pendingResponsesCount(
  threadIds: readonly string[],
  comments: readonly CommentLite[],
): number {
  if (threadIds.length === 0) return 0;
  const idSet = new Set(threadIds);
  const last = lastCommentByThread(comments.filter((c) => idSet.has(c.thread_id)));
  let n = 0;
  for (const [, c] of last) {
    if (!isTeacherComment(c)) n += 1;
  }
  return n;
}

/**
 * Filtra los IDs de thread cuyo último comentario NO es de un docente.
 * El modal lo usa para recortar la lista de threads renderizados cuando
 * filterMode es "needsMyResponse".
 */
export function threadsPendingTeacherResponse(
  threadIds: readonly string[],
  comments: readonly CommentLite[],
): Set<string> {
  const idSet = new Set(threadIds);
  const last = lastCommentByThread(comments.filter((c) => idSet.has(c.thread_id)));
  const out = new Set<string>();
  for (const [tid, c] of last) {
    if (!isTeacherComment(c)) out.add(tid);
  }
  return out;
}

/**
 * Inversa de pendingResponsesCount — para el dashboard del ESTUDIANTE.
 * Cuenta los threads abiertos cuyo último comentario SÍ es de un
 * docente. Es decir: el docente respondió y la pelota está en la cancha
 * del estudiante. Mismo predicado role-based (cualquier teacher cuenta).
 */
export function studentPendingResponseCount(
  threadIds: readonly string[],
  comments: readonly CommentLite[],
): number {
  if (threadIds.length === 0) return 0;
  const idSet = new Set(threadIds);
  const last = lastCommentByThread(comments.filter((c) => idSet.has(c.thread_id)));
  let n = 0;
  for (const [, c] of last) {
    if (isTeacherComment(c)) n += 1;
  }
  return n;
}

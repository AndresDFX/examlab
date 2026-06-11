/**
 * Estado de apertura de un foro Q&A — helper compartido.
 *
 * INVARIANTE: la lógica debe coincidir con la función SQL
 * `public.is_forum_open(_forum_id)` (migración 20260603105000) y con
 * `computeForumState` en [app.forum.$courseId.tsx]. La RLS server-side
 * (`forum_threads_insert` / `forum_replies_insert`) usa la SQL para decidir
 * si un estudiante puede postear; este helper hace lo mismo en cliente para
 * reflejar el estado en UI sin un round-trip. Si cambias una, actualiza las
 * otras (un INSERT que pasa el gate del cliente puede ser rechazado por RLS
 * si divergen — y viceversa, un CTA escondido que la RLS sí permitiría).
 *
 * Consumido por la lista de hilos ([app.forum.$courseId.$forumId.tsx]) y por
 * el detalle de un hilo ([app.forum.$courseId.$forumId.$threadId.tsx], que
 * gatea el composer "Responder").
 */
export type ForumOpenState = {
  opens_at: string | null;
  closes_at: string | null;
  manually_closed_at: string | null;
};

export function isForumOpen(f: ForumOpenState): boolean {
  if (f.manually_closed_at) return false;
  const now = Date.now();
  if (f.opens_at && new Date(f.opens_at).getTime() > now) return false;
  if (f.closes_at && new Date(f.closes_at).getTime() <= now) return false;
  return true;
}

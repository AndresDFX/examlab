/**
 * Marcado de material consumido — fire-and-forget.
 *
 * Es TELEMETRÍA, no una acción del usuario: nunca bloquea la apertura del
 * visor y nunca muestra un error. Si el RPC falla, el alumno ve su archivo
 * igual y lo único que se pierde es una fila de progreso.
 *
 * Toda la validación (matrícula, vínculo al curso, publicación, papelera,
 * ventana de liberación, existencia del archivo) vive server-side en
 * `mark_content_file_viewed`. Acá no se valida nada: la tabla no tiene policy
 * de INSERT/UPDATE, así que el RPC es el único camino y no hay forma de
 * fabricar un `opened_at` desde el cliente.
 */

import { supabase } from "@/integrations/supabase/client";
import { progressKey } from "./content-progress";

export type ConsumeAction = "open" | "download";

/**
 * Dedupe a nivel de MÓDULO (no por componente): el mismo archivo se renderiza
 * en varias sesiones y el chip puede remontarse al re-filtrar, así que un Set
 * local no alcanzaría. Mismo patrón que usa el hook de notificaciones para
 * deduplicar entre instancias.
 *
 * La clave incluye la ACCIÓN a propósito. Con solo (contenido, archivo) se
 * descartaría el segundo evento sobre el mismo archivo — que es justamente la
 * transición abrir → descargar que las columnas `opened_at`/`downloaded_at`
 * separadas existen para poder registrar.
 */
const sent = new Set<string>();

export function markContentFileViewed(args: {
  courseId: string;
  contentId: string;
  filePath: string;
  action: ConsumeAction;
  sessionId?: string | null;
}): void {
  const { courseId, contentId, filePath, action, sessionId } = args;
  if (!courseId || !contentId || !filePath) return;

  const key = `${courseId}|${progressKey(contentId, filePath)}|${action}`;
  if (sent.has(key)) return;
  sent.add(key);

  // Sin await en el caller: el visor abre primero. El error se traga a
  // propósito — un fallo de telemetría no debe generar un toast ni ensuciar la
  // consola del alumno.
  //
  // `supabase as any`: `types.ts` se genera desde la DB y no conoce este RPC
  // hasta que la migración se publique. Mismo patrón que ya usa el tablero
  // (`const db = supabase as any`) por esta misma razón.
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error } = await (supabase as any).rpc("mark_content_file_viewed", {
        _course: courseId,
        _content: contentId,
        _file_path: filePath,
        _action: action,
        _session: sessionId ?? null,
      });
      // Si el RPC rechazó, se libera la clave para que un reintento posterior
      // (por ejemplo tras publicarse el material) pueda registrar el evento.
      if (error) sent.delete(key);
    } catch {
      sent.delete(key);
    }
  })();
}

/** Solo para tests: limpia el dedupe de módulo. */
export function __resetSentForTests(): void {
  sent.clear();
}

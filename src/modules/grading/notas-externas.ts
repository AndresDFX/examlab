import { supabase } from "@/integrations/supabase/client";
import { friendlyError } from "@/shared/lib/db-errors";

/**
 * Escritura de la nota de una actividad EXTERNA (la que ya ocurrió fuera de la
 * plataforma y solo se registra). Vive aparte porque la escriben dos pantallas:
 * «Notas externas» y la ventana de grupos, que deja calificar a cada grupo
 * mientras se arma. Si cada una escribiera por su cuenta, la misma nota
 * quedaría guardada con un estado distinto según dónde se tecleó.
 *
 * Una fila por estudiante: UPDATE si ya tiene la suya, INSERT si no. La nota va
 * en la ESCALA DEL CURSO (ver `ExternalGradesEditor`).
 */
export type TipoDeActividadExterna = "exam" | "workshop" | "project";

export interface NotaExternaAEscribir {
  userId: string;
  /** La fila que ya tiene, o `null` para crearla. */
  submissionId: string | null;
  grade: number | null;
  feedback: string;
}

const TABLA = {
  exam: "submissions",
  workshop: "workshop_submissions",
  project: "project_submissions",
} as const;
const FK = { exam: "exam_id", workshop: "workshop_id", project: "project_id" } as const;

/** Lo que se escribe; exportado para poder verificarlo sin red. */
export function filaDeNotaExterna(
  tipo: TipoDeActividadExterna,
  refId: string,
  nota: NotaExternaAEscribir,
  ahora: string,
): { update: Record<string, unknown>; insert: Record<string, unknown> } {
  const comun =
    tipo === "exam"
      ? {
          final_override_grade: nota.grade,
          teacher_feedback: nota.feedback || null,
          status: "completado",
        }
      : { final_grade: nota.grade, teacher_feedback: nota.feedback || null, status: "calificado" };
  return {
    update: { ...comun, submitted_at: ahora },
    insert: {
      [FK[tipo]]: refId,
      user_id: nota.userId,
      ...comun,
      submitted_at: ahora,
      // El intento de un examen necesita su inicio y un objeto de respuestas.
      ...(tipo === "exam" ? { started_at: ahora, answers: {} } : {}),
    },
  };
}

/** Devuelve el id de la fila escrita, o el motivo (ya traducido) si falló. */
export async function escribirNotaExterna(
  tipo: TipoDeActividadExterna,
  refId: string,
  nota: NotaExternaAEscribir,
): Promise<{ ok: true; submissionId: string | null } | { ok: false; error: string }> {
  const fila = filaDeNotaExterna(tipo, refId, nota, new Date().toISOString());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any;
  if (nota.submissionId) {
    const { error } = await db.from(TABLA[tipo]).update(fila.update).eq("id", nota.submissionId);
    if (error) return { ok: false, error: friendlyError(error) };
    return { ok: true, submissionId: nota.submissionId };
  }
  const { data, error } = await db.from(TABLA[tipo]).insert(fila.insert).select("id").single();
  if (error) return { ok: false, error: friendlyError(error) };
  return { ok: true, submissionId: (data as { id?: string } | null)?.id ?? null };
}

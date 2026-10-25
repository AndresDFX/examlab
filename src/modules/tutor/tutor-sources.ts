/**
 * Resolución de las FUENTES del Tutor IA (Fase 1, sin embeddings).
 *
 * Decide QUÉ fuentes entran al contexto del tutor, combinando:
 *   override del curso  >  default de la asignatura  >  default del sistema
 *
 * Precedencia por FILA COMPLETA (no por campo): si existe la fila de override
 * del curso, manda ella entera; si no, la de la asignatura; si no, los
 * defaults. "Volver al de la asignatura" = borrar la fila de override.
 *
 * Invariante cross-file: este archivo tiene una COPIA en
 * `supabase/functions/tutor-chat/tutor-sources.ts` (Deno no importa de src/).
 * Si cambia la forma o los defaults, sincronizar ambos. Lo verifica
 * `tutor-sources.test.ts`.
 */

export interface TutorSourcesConfig {
  /** Material de la asignatura (presentaciones que persisten entre semestres). */
  subjectMaterial: boolean;
  /** Material propio del curso (contenidos del semestre). */
  courseMaterial: boolean;
  /** Transcripciones de ESTE curso (solo voz del docente). */
  courseTranscripts: boolean;
  /**
   * Transcripciones de OTROS grupos de la MISMA asignatura y el MISMO periodo
   * (solo teacher_text, nunca content_text). Semestres anteriores NO entran.
   */
  siblingTranscripts: boolean;
}

/** De dónde salió la config efectiva. */
export type TutorSourcesOrigin = "course" | "subject" | "default";

export interface TutorSourcesEffective extends TutorSourcesConfig {
  origin: TutorSourcesOrigin;
}

/** Defaults del sistema: sin configuración, comportamiento actual + off para hermanos. */
export const TUTOR_SOURCES_DEFAULT: TutorSourcesConfig = {
  subjectMaterial: true,
  courseMaterial: true,
  courseTranscripts: true,
  siblingTranscripts: false,
};

/** Forma de fila de `tutor_ai_sources` (columnas booleanas). */
export interface TutorAiSourceRow {
  src_subject_material?: boolean | null;
  src_course_material?: boolean | null;
  src_course_transcripts?: boolean | null;
  src_sibling_transcripts?: boolean | null;
}

function rowToConfig(row: TutorAiSourceRow): TutorSourcesConfig {
  return {
    subjectMaterial: row.src_subject_material ?? TUTOR_SOURCES_DEFAULT.subjectMaterial,
    courseMaterial: row.src_course_material ?? TUTOR_SOURCES_DEFAULT.courseMaterial,
    courseTranscripts: row.src_course_transcripts ?? TUTOR_SOURCES_DEFAULT.courseTranscripts,
    siblingTranscripts: row.src_sibling_transcripts ?? TUTOR_SOURCES_DEFAULT.siblingTranscripts,
  };
}

/** Config efectiva: override del curso > fila de la asignatura > default. */
export function resolveTutorSources(
  courseOverride: TutorAiSourceRow | null | undefined,
  subjectDefault: TutorAiSourceRow | null | undefined,
): TutorSourcesEffective {
  if (courseOverride) return { ...rowToConfig(courseOverride), origin: "course" };
  if (subjectDefault) return { ...rowToConfig(subjectDefault), origin: "subject" };
  return { ...TUTOR_SOURCES_DEFAULT, origin: "default" };
}

/** Payload de columnas para persistir una config (INSERT/UPDATE). */
export function configToRow(cfg: TutorSourcesConfig): Required<TutorAiSourceRow> {
  return {
    src_subject_material: cfg.subjectMaterial,
    src_course_material: cfg.courseMaterial,
    src_course_transcripts: cfg.courseTranscripts,
    src_sibling_transcripts: cfg.siblingTranscripts,
  };
}

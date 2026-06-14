/**
 * Encolar (o calificar sync) UNA entrega con IA, por tipo de actividad.
 *
 * Centraliza la "lógica ya existente" que vivía dispersa en los módulos
 * (monitor de examen, taller, proyecto + submit del estudiante) para que
 * otros flujos — ej. "Calificar todos" del Diagnóstico del curso — la
 * reusen sin reimplementar el armado del body por tipo.
 *
 * Reusa `aiGradeOrEnqueue` (que decide sync/async según processing_mode +
 * override) y replica EXACTAMENTE el contrato del edge `ai-grade-submission`
 * por tipo:
 *   - exam      → body { submissionId } (el edge resuelve preguntas server-side).
 *   - workshop  → body { workshopFullGrading, submissionId, items }.
 *   - project   → body { projectFullGrading, submissionId, items } para las
 *                 preguntas no-ZIP + un job projectCodeZipGrading por cada
 *                 archivo `codigo_zip`.
 *
 * Las funciones de armado de `items` son PURAS (sin DB) para poder testearlas
 * sin mocks; `enqueueAiGradeForSubmission` hace las queries y delega en ellas.
 */
import { supabase } from "@/integrations/supabase/client";
import { aiGradeOrEnqueue, PENDING_AI_FEEDBACK } from "@/modules/ai/ai-grading";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export type GradeKind = "exam" | "workshop" | "project";

export interface GradeBatchItem {
  qid: string;
  type?: string;
  content: string;
  rubric: string;
  userAnswer: string;
  maxPoints: number;
  language?: string | null;
}

// ─────────────────────── Builders puros ───────────────────────

export interface WorkshopQuestionRow {
  id: string;
  type: string;
  content: string;
  points: number;
  expected_rubric: string | null;
  language: string | null;
  starter_code: string | null;
}
export interface WorkshopAnswerRow {
  question_id: string;
  answer_text: string | null;
  selected_option: string | null;
  code_content: string | null;
  diagram_code: string | null;
}

/**
 * Arma los `items` para `workshopFullGrading` a partir de las preguntas del
 * taller + las respuestas de la entrega. Mirror EXACTO del re-grade del
 * docente (app.teacher.workshops.tsx): salta cerradas (scoring local) y
 * respuestas vacías (o iguales al starter). Sin items → IA no se invoca.
 */
export function buildWorkshopItems(
  questions: WorkshopQuestionRow[],
  answers: WorkshopAnswerRow[],
): GradeBatchItem[] {
  const byQid = new Map(answers.map((a) => [a.question_id, a]));
  const items: GradeBatchItem[] = [];
  for (const q of questions) {
    if (q.type === "cerrada" || q.type === "cerrada_multi") continue;
    const a = byQid.get(q.id);
    const raw = a?.code_content ?? a?.diagram_code ?? a?.answer_text ?? "";
    const trimmed = String(raw).trim();
    const starter = String(q.starter_code ?? "").trim();
    const isEmpty = !trimmed || (starter !== "" && trimmed === starter);
    if (isEmpty) continue;
    items.push({
      qid: q.id,
      type: q.type,
      content: q.content,
      rubric: q.expected_rubric ?? "",
      userAnswer: trimmed,
      maxPoints: Number(q.points) || 0,
      language: q.type === "java_gui" ? "java" : q.type === "python_gui" ? "python" : q.language,
    });
  }
  return items;
}

export interface ProjectFileRow {
  id: string;
  title: string;
  description: string | null;
  type: string;
  expected_rubric: string | null;
  points: number;
}
export interface ProjectSubFileRow {
  file_id: string;
  content: string | null;
  code_paths: string[] | null;
  zip_path: string | null;
}
export interface ProjectZipJob {
  fileId: string;
  body: Record<string, unknown>;
}
export interface ProjectJobs {
  /** items para el job batch projectFullGrading (no-ZIP, no-cerrada_multi). */
  batchItems: GradeBatchItem[];
  /** un job projectCodeZipGrading por archivo `codigo_zip` con entrega. */
  zipJobs: ProjectZipJob[];
}

/**
 * Arma los jobs IA para una entrega de proyecto. Mirror del submit del
 * estudiante + el re-grade del docente:
 *   - `codigo_zip` con code_paths/zip_path → job projectCodeZipGrading.
 *   - `cerrada` / `cerrada_multi` → scoring local, NO van a IA → se saltan.
 *   - resto (abierta/diagrama/etc.) con contenido → batch projectFullGrading.
 */
export function buildProjectJobs(
  files: ProjectFileRow[],
  subFiles: ProjectSubFileRow[],
  projectDescription: string | null,
  courseLanguage: "es" | "en",
  courseId: string | null,
): ProjectJobs {
  const byFileId = new Map(subFiles.map((s) => [s.file_id, s]));
  const batchItems: GradeBatchItem[] = [];
  const zipJobs: ProjectZipJob[] = [];
  for (const f of files) {
    const ans = byFileId.get(f.id);
    if (f.type === "codigo_zip") {
      const codePaths =
        ans && Array.isArray(ans.code_paths) && ans.code_paths.length > 0
          ? ans.code_paths
          : undefined;
      const zipPath = ans?.zip_path ?? undefined;
      if (!codePaths && !zipPath) continue; // sin entrega de código → nada que calificar
      zipJobs.push({
        fileId: f.id,
        body: {
          projectCodeZipGrading: true,
          codePaths,
          zipPath,
          noMinify: true,
          fileTitle: f.title,
          fileDescription: f.description ?? null,
          expectedRubric: f.expected_rubric ?? null,
          maxPoints: f.points,
          courseLanguage,
          courseId: courseId ?? undefined,
          projectDescription,
        },
      });
      continue;
    }
    if (f.type === "cerrada" || f.type === "cerrada_multi") continue; // scoring local, sin IA
    const userAnswer = String(ans?.content ?? "").trim();
    if (!userAnswer) continue; // vacío → no gastar IA
    batchItems.push({
      qid: f.id,
      type: f.type,
      content: f.title,
      rubric: f.expected_rubric ?? "",
      userAnswer,
      maxPoints: Number(f.points) || 0,
    });
  }
  return { batchItems, zipJobs };
}

// ─────────────────────── Enqueue (con DB) ───────────────────────

export interface EnqueueGradeResult {
  ok: boolean;
  /** Cuántos jobs IA se encolaron/ejecutaron para esta entrega. */
  enqueued: number;
  error?: string;
}

/**
 * Encola (o ejecuta sync) la calificación IA de UNA entrega.
 * No lanza: devuelve `{ ok, enqueued, error }` para que el caller
 * (bulk "Calificar todos") agregue resultados y muestre el primer error.
 */
export async function enqueueAiGradeForSubmission(opts: {
  kind: GradeKind;
  submissionId: string;
  itemId: string;
  courseId: string | null;
  courseLanguage: "es" | "en";
}): Promise<EnqueueGradeResult> {
  const { kind, submissionId, itemId, courseId, courseLanguage } = opts;
  try {
    if (kind === "exam") {
      await db
        .from("submissions")
        .update({ ai_feedback: PENDING_AI_FEEDBACK, ai_grade: null })
        .eq("id", submissionId);
      const r = await aiGradeOrEnqueue({
        kind: "exam_full",
        body: { submissionId },
        target: {
          table: "submissions",
          rowId: submissionId,
          fieldGrade: "ai_grade",
          fieldFeedback: "ai_feedback",
          courseId,
        },
      });
      if (r.error) return { ok: false, enqueued: 0, error: r.error };
      return { ok: true, enqueued: 1 };
    }

    if (kind === "workshop") {
      const [{ data: qs }, { data: ans }] = await Promise.all([
        db
          .from("workshop_questions")
          .select("id, type, content, points, expected_rubric, language, starter_code")
          .eq("workshop_id", itemId)
          .order("position"),
        db
          .from("workshop_submission_answers")
          .select("question_id, answer_text, selected_option, code_content, diagram_code")
          .eq("submission_id", submissionId),
      ]);
      const items = buildWorkshopItems(
        (qs ?? []) as WorkshopQuestionRow[],
        (ans ?? []) as WorkshopAnswerRow[],
      );
      if (items.length === 0) return { ok: true, enqueued: 0 };
      const r = await aiGradeOrEnqueue({
        kind: "workshop_full",
        body: { workshopFullGrading: true, submissionId, items, courseLanguage, courseId: courseId ?? undefined },
        target: { table: "workshop_submissions", rowId: submissionId, courseId },
      });
      if (r.error) return { ok: false, enqueued: 0, error: r.error };
      return { ok: true, enqueued: 1 };
    }

    // project
    const [{ data: pf }, { data: psf }, { data: proj }] = await Promise.all([
      db
        .from("project_files")
        .select("id, title, description, type, expected_rubric, points")
        .eq("project_id", itemId)
        .order("position"),
      db
        .from("project_submission_files")
        .select("file_id, content, code_paths, zip_path")
        .eq("submission_id", submissionId),
      db.from("projects").select("description").eq("id", itemId).maybeSingle(),
    ]);
    const { batchItems, zipJobs } = buildProjectJobs(
      (pf ?? []) as ProjectFileRow[],
      (psf ?? []) as ProjectSubFileRow[],
      (proj?.description ?? null) as string | null,
      courseLanguage,
      courseId,
    );
    let enqueued = 0;
    let firstError: string | undefined;
    // Batch no-ZIP.
    if (batchItems.length > 0) {
      const r = await aiGradeOrEnqueue({
        kind: "project_full",
        body: {
          projectFullGrading: true,
          submissionId,
          items: batchItems.map((it) => ({
            qid: it.qid,
            content: it.content,
            rubric: it.rubric,
            userAnswer: it.userAnswer,
            maxPoints: it.maxPoints,
          })),
          courseLanguage,
          courseId: courseId ?? undefined,
          projectDescription: (proj?.description ?? null) as string | null,
        },
        target: { table: "project_submissions", rowId: submissionId, courseId },
      });
      if (r.error) firstError ??= r.error;
      else enqueued += 1;
    }
    // Un job por archivo codigo_zip — el target es la fila del archivo.
    for (const zj of zipJobs) {
      // El target del job ZIP es la fila project_submission_files de ese
      // archivo. Necesitamos su id real para que el worker escriba ahí.
      const { data: rowId } = await db
        .from("project_submission_files")
        .select("id")
        .eq("submission_id", submissionId)
        .eq("file_id", zj.fileId)
        .maybeSingle();
      if (!rowId?.id) continue;
      const r = await aiGradeOrEnqueue({
        kind: "project_codigo_zip",
        body: zj.body,
        target: {
          table: "project_submission_files",
          rowId: rowId.id,
          fieldGrade: "ai_grade",
          fieldFeedback: "ai_feedback",
          fieldLikelihood: "ai_likelihood",
          fieldReasons: "ai_reasons",
          courseId,
        },
      });
      if (r.error) firstError ??= r.error;
      else enqueued += 1;
    }
    if (enqueued === 0 && firstError) return { ok: false, enqueued: 0, error: firstError };
    return { ok: true, enqueued };
  } catch (e) {
    return { ok: false, enqueued: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Helpers PUROS para el bulk import de sustentaciones de proyectos.
 *
 * Se mantienen fuera de la ruta `app.teacher.projects.tsx` para poder
 * testearlos sin montar el componente. La ruta importa estos helpers
 * y compone la aplicación con efectos de DB (`supabase.update`, lookup
 * de profiles por email, resolución de submission por user/group).
 *
 * Shape del CSV:
 *
 *   student_email,defense_factor,defense_notes,defense_video_url
 *
 * - `student_email`     OBLIGATORIO. Cualquier formato email básico
 *                       (matcheamos contra `profiles.institutional_email`
 *                       en el caller; el parser solo valida shape).
 * - `defense_factor`    OBLIGATORIO. Número 0..1 (inclusive). El separador
 *                       decimal DEBE ser PUNTO (`0.8`) — la coma es el
 *                       delimitador de columnas del CSV, así que `0,8` partiría
 *                       la fila en 2 columnas y desalinearía todo.
 * - `defense_notes`     OPCIONAL. <= 2000 chars. Si excede → error
 *                       (no truncamos en silencio para que el docente
 *                       sepa que su nota fue cortada).
 * - `defense_video_url` OPCIONAL. Si viene, debe empezar por `http(s)://`.
 *
 * INVARIANTES (mantener al cambiar):
 *   - Filas con cualquier campo OBLIGATORIO inválido NO entran a `rows`
 *     — caen a `errors[]` con número de línea Excel-style (header = 1,
 *     primera fila = 2). El caller debe mostrar los errores al docente
 *     ANTES de pegarle a la DB.
 *   - El parser no decide qué hacer con los emails: solo valida shape.
 *     El caller resuelve email → profile.id → submission.
 *   - El separador decimal del CSV es PUNTO. La coma es el delimitador de
 *     columnas — `0,8` rompería la fila. El guard de conteo de columnas del
 *     caller rechaza filas desalineadas (ej. si alguien pega "0,8" desde Excel-es).
 */

/** Header + filas demo del template descargable. */
export const DEFENSES_TEMPLATE = `student_email,defense_factor,defense_notes,defense_video_url
alumno1@correo.edu.co,0.8,Defendió bien la arquitectura y respondió todas las preguntas,https://drive.google.com/file/d/xxxx/view
alumno2@correo.edu.co,1,Sustentación impecable,
alumno3@correo.edu.co,0.5,Confundió algunos conceptos clave,`;

/** Orden estable de columnas. */
export const DEFENSES_CSV_COLUMNS = [
  "student_email",
  "defense_factor",
  "defense_notes",
  "defense_video_url",
] as const;

/** Tope para `defense_notes` (alineado con UX — el textarea del
 *  DefensePanel no impone límite hard, pero 2000 chars es lo que
 *  cabe sin overflow visual en el dialog). */
export const DEFENSE_NOTES_MAX_CHARS = 2000;

/** Payload normalizado de UNA fila lista para aplicarse via UPDATE
 *  en `project_submissions`. El caller resuelve el `user_id` desde
 *  `student_email` y la submission/grupo correspondiente. */
export interface ParsedDefenseRow {
  /** Línea Excel-style del CSV (header = 1, primera fila = 2). Útil para
   *  reportar errores DESPUÉS del parseo (ej. "fila 5: alumno no
   *  matriculado"). */
  line: number;
  student_email: string;
  defense_factor: number;
  defense_notes: string | null;
  defense_video_url: string | null;
}

/** Error de campo OBLIGATORIO en una fila. */
export interface DefenseCsvError {
  /** Línea Excel-style (header = 1). */
  line: number;
  /** Mensaje en español, listo para mostrar al docente. */
  message: string;
}

export interface ParseDefenseCsvResult {
  rows: ParsedDefenseRow[];
  errors: DefenseCsvError[];
}

/** Email shape básico — no chequea DNS ni que el dominio sea válido,
 *  solo "algo@algo.algo". Match contra `profiles.institutional_email`
 *  pasa por la DB. */
const EMAIL_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** Parsea `defense_factor` aceptando coma O punto decimal.
 *  Retorna número en [0,1] o null si inválido. */
function parseFactor(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Coma decimal (es-CO) → punto antes de parseFloat.
  const normalized = trimmed.replace(",", ".");
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num)) return null;
  if (num < 0 || num > 1) return null;
  return num;
}

/** Valida URL básica: debe empezar con http:// o https://. */
function isValidUrl(raw: string): boolean {
  return /^https?:\/\/\S+$/i.test(raw.trim());
}

/**
 * Parsea las filas crudas del CSV (ya pasadas por `parseCSV` que
 * devuelve `Record<string, string>` por fila) a payloads normalizados.
 *
 * NO lanza — devuelve `errors[]` para que el caller muestre TODOS los
 * problemas a la vez (vs. fail-fast). Las filas OK siguen en `rows[]`,
 * así el docente puede aplicar parcialmente si conviene.
 */
export function parseDefenseCsv(
  rows: Array<Record<string, string>>,
): ParseDefenseCsvResult {
  const out: ParsedDefenseRow[] = [];
  const errors: DefenseCsvError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lineNo = i + 2;

    const rawEmail = (r.student_email || "").trim();
    if (!rawEmail) {
      errors.push({
        line: lineNo,
        message: `Fila ${lineNo}: student_email es obligatorio.`,
      });
      continue;
    }
    if (!EMAIL_RE.test(rawEmail)) {
      errors.push({
        line: lineNo,
        message: `Fila ${lineNo}: student_email "${rawEmail}" no tiene formato de email válido.`,
      });
      continue;
    }

    const rawFactor = (r.defense_factor || "").trim();
    if (!rawFactor) {
      errors.push({
        line: lineNo,
        message: `Fila ${lineNo}: defense_factor es obligatorio (0..1).`,
      });
      continue;
    }
    const factor = parseFactor(rawFactor);
    if (factor == null) {
      errors.push({
        line: lineNo,
        message: `Fila ${lineNo}: defense_factor "${rawFactor}" no es un número entre 0 y 1.`,
      });
      continue;
    }

    const rawNotes = r.defense_notes ?? "";
    if (rawNotes.length > DEFENSE_NOTES_MAX_CHARS) {
      errors.push({
        line: lineNo,
        message: `Fila ${lineNo}: defense_notes excede ${DEFENSE_NOTES_MAX_CHARS} caracteres (${rawNotes.length}).`,
      });
      continue;
    }
    const notes = rawNotes.trim() || null;

    const rawUrl = (r.defense_video_url || "").trim();
    let videoUrl: string | null = null;
    if (rawUrl) {
      if (!isValidUrl(rawUrl)) {
        errors.push({
          line: lineNo,
          message: `Fila ${lineNo}: defense_video_url "${rawUrl}" debe empezar por http:// o https://.`,
        });
        continue;
      }
      videoUrl = rawUrl;
    }

    out.push({
      line: lineNo,
      student_email: rawEmail.toLowerCase(),
      defense_factor: factor,
      defense_notes: notes,
      defense_video_url: videoUrl,
    });
  }

  return { rows: out, errors };
}

/**
 * Deduplica filas que apunten a la misma submission (típicamente porque
 * múltiples miembros de un mismo grupo aparecen en el CSV).
 *
 * El caller resuelve `student_email → submissionId` (vía profile lookup
 * + buscar `project_submissions.group_id` cuando aplica) y pasa el
 * mapping aquí. La primera fila gana — orden del CSV.
 *
 * Función PURA: no toca DB. Solo conserva las filas únicas por submission.
 */
export function dedupeBySubmission(
  parsed: ParsedDefenseRow[],
  submissionIdByEmail: Map<string, string>,
): {
  toApply: Array<ParsedDefenseRow & { submission_id: string }>;
  skippedNoSubmission: ParsedDefenseRow[];
  skippedDuplicateGroup: ParsedDefenseRow[];
} {
  const toApply: Array<ParsedDefenseRow & { submission_id: string }> = [];
  const skippedNoSubmission: ParsedDefenseRow[] = [];
  const skippedDuplicateGroup: ParsedDefenseRow[] = [];
  const seenSubmissions = new Set<string>();

  for (const row of parsed) {
    const subId = submissionIdByEmail.get(row.student_email);
    if (!subId) {
      skippedNoSubmission.push(row);
      continue;
    }
    if (seenSubmissions.has(subId)) {
      // Mismo grupo aparece dos veces (varios miembros en el CSV) — la
      // primera ya quedó en `toApply`, descartamos las siguientes.
      skippedDuplicateGroup.push(row);
      continue;
    }
    seenSubmissions.add(subId);
    toApply.push({ ...row, submission_id: subId });
  }

  return { toApply, skippedNoSubmission, skippedDuplicateGroup };
}

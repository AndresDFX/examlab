import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveTutorSources,
  configToRow,
  TUTOR_SOURCES_DEFAULT,
  type TutorAiSourceRow,
} from "./tutor-sources";

const SUBJECT_ROW: TutorAiSourceRow = {
  src_subject_material: true,
  src_course_material: false,
  src_course_transcripts: true,
  src_sibling_transcripts: true,
};

const COURSE_ROW: TutorAiSourceRow = {
  src_subject_material: false,
  src_course_material: true,
  src_course_transcripts: false,
  src_sibling_transcripts: false,
};

describe("resolveTutorSources", () => {
  it("sin ninguna fila → defaults del sistema (comportamiento actual, hermanos off)", () => {
    const r = resolveTutorSources(null, null);
    expect(r.origin).toBe("default");
    expect(r.subjectMaterial).toBe(true);
    expect(r.courseMaterial).toBe(true);
    expect(r.courseTranscripts).toBe(true);
    expect(r.siblingTranscripts).toBe(false);
  });

  it("solo fila de asignatura → usa la asignatura", () => {
    const r = resolveTutorSources(null, SUBJECT_ROW);
    expect(r.origin).toBe("subject");
    expect(r.courseMaterial).toBe(false);
    expect(r.siblingTranscripts).toBe(true);
  });

  it("override del curso manda sobre la asignatura, FILA COMPLETA", () => {
    const r = resolveTutorSources(COURSE_ROW, SUBJECT_ROW);
    expect(r.origin).toBe("course");
    expect(r.subjectMaterial).toBe(false);
    expect(r.courseMaterial).toBe(true);
    expect(r.courseTranscripts).toBe(false);
    expect(r.siblingTranscripts).toBe(false);
  });

  it("override del curso sin asignatura también manda", () => {
    const r = resolveTutorSources(COURSE_ROW, null);
    expect(r.origin).toBe("course");
    expect(r.courseMaterial).toBe(true);
  });

  it("columna null en la fila cae al default de ese campo", () => {
    const r = resolveTutorSources(null, { src_course_material: null });
    expect(r.origin).toBe("subject");
    expect(r.courseMaterial).toBe(true); // default
  });
});

describe("configToRow", () => {
  it("round-trip con los defaults", () => {
    const row = configToRow(TUTOR_SOURCES_DEFAULT);
    expect(row).toEqual({
      src_subject_material: true,
      src_course_material: true,
      src_course_transcripts: true,
      src_sibling_transcripts: false,
    });
    const back = resolveTutorSources(row, null);
    expect(back.subjectMaterial).toBe(true);
    expect(back.siblingTranscripts).toBe(false);
  });
});

describe("copia Deno en sync", () => {
  it("el edge replica los defaults y las claves de columna", () => {
    const denoSrc = readFileSync(
      resolve(__dirname, "../../../supabase/functions/tutor-chat/tutor-sources.ts"),
      "utf8",
    );
    for (const key of [
      "src_subject_material",
      "src_course_material",
      "src_course_transcripts",
      "src_sibling_transcripts",
    ]) {
      expect(denoSrc).toContain(key);
    }
    expect(denoSrc).toContain("siblingTranscripts: false");
  });
});

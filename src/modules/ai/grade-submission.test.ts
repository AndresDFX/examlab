/**
 * Tests de los builders PUROS de armado de jobs IA por entrega.
 * (La parte que toca DB — enqueueAiGradeForSubmission — no se testea acá
 *  porque requiere mockear Supabase; estos builders concentran la lógica.)
 */
import { describe, expect, it } from "vitest";
import {
  buildWorkshopItems,
  buildProjectJobs,
  type WorkshopQuestionRow,
  type WorkshopAnswerRow,
  type ProjectFileRow,
  type ProjectSubFileRow,
} from "./grade-submission";
import { serializeV86Answer } from "@/modules/serverconsole/v86-answer";

function wq(p: Partial<WorkshopQuestionRow> & { id: string }): WorkshopQuestionRow {
  return {
    type: "abierta",
    content: "Pregunta",
    points: 10,
    expected_rubric: "rúbrica",
    language: null,
    starter_code: null,
    ...p,
  };
}
function wa(p: Partial<WorkshopAnswerRow> & { question_id: string }): WorkshopAnswerRow {
  return {
    answer_text: null,
    selected_option: null,
    code_content: null,
    diagram_code: null,
    ...p,
  };
}

describe("buildWorkshopItems", () => {
  it("incluye preguntas abiertas con respuesta", () => {
    const items = buildWorkshopItems(
      [wq({ id: "q1" })],
      [wa({ question_id: "q1", answer_text: "mi respuesta" })],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ qid: "q1", userAnswer: "mi respuesta", maxPoints: 10, rubric: "rúbrica" });
  });

  it("salta preguntas cerradas (scoring local, no IA)", () => {
    const items = buildWorkshopItems(
      [wq({ id: "q1", type: "cerrada" }), wq({ id: "q2", type: "cerrada_multi" })],
      [wa({ question_id: "q1", selected_option: "0" })],
    );
    expect(items).toHaveLength(0);
  });

  it("salta respuestas vacías o sin entrega", () => {
    const items = buildWorkshopItems(
      [wq({ id: "q1" }), wq({ id: "q2" })],
      [wa({ question_id: "q1", answer_text: "   " })], // solo espacios
    );
    expect(items).toHaveLength(0);
  });

  it("salta respuesta igual al starter_code (el alumno no la tocó)", () => {
    const items = buildWorkshopItems(
      [wq({ id: "q1", type: "codigo", starter_code: "int main(){}" })],
      [wa({ question_id: "q1", code_content: "int main(){}" })],
    );
    expect(items).toHaveLength(0);
  });

  it("prioriza code_content > diagram_code > answer_text", () => {
    const items = buildWorkshopItems(
      [wq({ id: "q1" })],
      [wa({ question_id: "q1", answer_text: "txt", diagram_code: "dia", code_content: "code" })],
    );
    expect(items[0].userAnswer).toBe("code");
  });

  it("mapea language de java_gui/python_gui", () => {
    const items = buildWorkshopItems(
      [
        wq({ id: "q1", type: "java_gui" }),
        wq({ id: "q2", type: "python_gui" }),
        wq({ id: "q3", type: "codigo", language: "javascript" }),
      ],
      [
        wa({ question_id: "q1", code_content: "class X{}" }),
        wa({ question_id: "q2", code_content: "print(1)" }),
        wa({ question_id: "q3", code_content: "console.log(1)" }),
      ],
    );
    expect(items.find((i) => i.qid === "q1")?.language).toBe("java");
    expect(items.find((i) => i.qid === "q2")?.language).toBe("python");
    expect(items.find((i) => i.qid === "q3")?.language).toBe("javascript");
  });

  it("so_consola: desempaqueta el transcript v86 (comandos como respuesta + salida)", () => {
    const answer = serializeV86Answer({
      transcript: "$ ls\nfile.txt\n$ whoami\nalumno\n",
      commands: ["ls", "whoami"],
    });
    const items = buildWorkshopItems(
      [wq({ id: "q1", type: "so_consola" })],
      [wa({ question_id: "q1", answer_text: answer })],
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ qid: "q1", type: "so_consola", userAnswer: "ls\nwhoami" });
    expect(items[0].executionOutput).toContain("file.txt");
  });

  it("so_consola sin interacción (sin comandos ni salida) → se salta", () => {
    const answer = serializeV86Answer({ transcript: "   ", commands: [] });
    const items = buildWorkshopItems(
      [wq({ id: "q1", type: "so_consola" })],
      [wa({ question_id: "q1", answer_text: answer })],
    );
    expect(items).toHaveLength(0);
  });

  it("so_consola con answer_text que no es v86 (basura) → se salta", () => {
    const items = buildWorkshopItems(
      [wq({ id: "q1", type: "so_consola" })],
      [wa({ question_id: "q1", answer_text: "esto no es json v86" })],
    );
    expect(items).toHaveLength(0);
  });
});

function pf(p: Partial<ProjectFileRow> & { id: string }): ProjectFileRow {
  return { title: "Archivo", description: null, type: "abierta", expected_rubric: "r", points: 20, ...p };
}
function psf(p: Partial<ProjectSubFileRow> & { file_id: string }): ProjectSubFileRow {
  return { content: null, code_paths: null, zip_path: null, ...p };
}

describe("buildProjectJobs", () => {
  it("codigo_zip con code_paths → zipJob (codePaths set, zipPath undefined)", () => {
    const { batchItems, zipJobs } = buildProjectJobs(
      [pf({ id: "f1", type: "codigo_zip" })],
      [psf({ file_id: "f1", code_paths: ["a.java", "b.java"] })],
      "Proyecto X",
      "es",
      "c1",
    );
    expect(batchItems).toHaveLength(0);
    expect(zipJobs).toHaveLength(1);
    expect(zipJobs[0].fileId).toBe("f1");
    expect(zipJobs[0].body.projectCodeZipGrading).toBe(true);
    expect(zipJobs[0].body.codePaths).toEqual(["a.java", "b.java"]);
    expect(zipJobs[0].body.zipPath).toBeUndefined();
    expect(zipJobs[0].body.noMinify).toBe(true);
  });

  it("codigo_zip con zip_path (legacy single zip) → zipJob con zipPath", () => {
    const { zipJobs } = buildProjectJobs(
      [pf({ id: "f1", type: "codigo_zip" })],
      [psf({ file_id: "f1", zip_path: "u/sub/f1.zip" })],
      null,
      "en",
      null,
    );
    expect(zipJobs).toHaveLength(1);
    expect(zipJobs[0].body.zipPath).toBe("u/sub/f1.zip");
    expect(zipJobs[0].body.courseLanguage).toBe("en");
  });

  it("codigo_zip SIN entrega de código → se salta", () => {
    const { zipJobs, batchItems } = buildProjectJobs(
      [pf({ id: "f1", type: "codigo_zip" })],
      [psf({ file_id: "f1" })],
      null,
      "es",
      null,
    );
    expect(zipJobs).toHaveLength(0);
    expect(batchItems).toHaveLength(0);
  });

  it("cerrada / cerrada_multi → no van a IA", () => {
    const { batchItems, zipJobs } = buildProjectJobs(
      [pf({ id: "f1", type: "cerrada" }), pf({ id: "f2", type: "cerrada_multi" })],
      [psf({ file_id: "f1", content: "[0]" }), psf({ file_id: "f2", content: "[1,2]" })],
      null,
      "es",
      null,
    );
    expect(batchItems).toHaveLength(0);
    expect(zipJobs).toHaveLength(0);
  });

  it("abierta con contenido → batchItem; vacía → se salta", () => {
    const { batchItems } = buildProjectJobs(
      [pf({ id: "f1", type: "abierta", points: 15 }), pf({ id: "f2", type: "diagrama" })],
      [psf({ file_id: "f1", content: "respuesta" }), psf({ file_id: "f2", content: "  " })],
      "Proyecto",
      "es",
      "c1",
    );
    expect(batchItems).toHaveLength(1);
    expect(batchItems[0]).toMatchObject({ qid: "f1", userAnswer: "respuesta", maxPoints: 15 });
  });

  it("mezcla: batch + zip en la misma entrega", () => {
    const { batchItems, zipJobs } = buildProjectJobs(
      [
        pf({ id: "f1", type: "abierta" }),
        pf({ id: "f2", type: "codigo_zip" }),
        pf({ id: "f3", type: "cerrada" }),
      ],
      [
        psf({ file_id: "f1", content: "texto" }),
        psf({ file_id: "f2", code_paths: ["m.py"] }),
        psf({ file_id: "f3", content: "[0]" }),
      ],
      "Desc",
      "es",
      "c1",
    );
    expect(batchItems.map((b) => b.qid)).toEqual(["f1"]);
    expect(zipJobs.map((z) => z.fileId)).toEqual(["f2"]);
  });
});

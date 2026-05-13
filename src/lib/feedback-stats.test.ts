import { describe, expect, it } from "vitest";
import {
  isTeacherComment,
  lastCommentByThread,
  pendingResponsesCount,
  threadsPendingTeacherResponse,
  type CommentLite,
} from "./feedback-stats";

describe("isTeacherComment", () => {
  it("true cuando author_role='teacher'", () => {
    expect(isTeacherComment({ author_role: "teacher" })).toBe(true);
  });

  it("false cuando author_role='student'", () => {
    expect(isTeacherComment({ author_role: "student" })).toBe(false);
  });

  it("false cuando author_role es null (comments pre-migración)", () => {
    expect(isTeacherComment({ author_role: null })).toBe(false);
  });

  it("false cuando author_role es undefined", () => {
    expect(isTeacherComment({ author_role: undefined })).toBe(false);
  });

  it("false para roles desconocidos como 'admin' (criterio: solo 'teacher' responde)", () => {
    expect(isTeacherComment({ author_role: "admin" })).toBe(false);
  });
});

describe("lastCommentByThread", () => {
  it("Map vacío cuando no hay comments", () => {
    expect(lastCommentByThread([]).size).toBe(0);
  });

  it("se queda con el comment más reciente por thread", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t1", author_role: "teacher", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t1", author_role: "student", created_at: "2026-01-01T15:00:00Z" },
    ];
    const last = lastCommentByThread(comments);
    expect(last.size).toBe(1);
    expect(last.get("t1")?.author_role).toBe("teacher");
  });

  it("acepta comments en cualquier orden", () => {
    const ordered: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t1", author_role: "teacher", created_at: "2026-01-05T10:00:00Z" },
    ];
    const reversed = [...ordered].reverse();
    expect(lastCommentByThread(ordered).get("t1")?.author_role).toBe("teacher");
    expect(lastCommentByThread(reversed).get("t1")?.author_role).toBe("teacher");
  });

  it("último comment por cada thread distinto", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t2", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t2", author_role: "teacher", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t3", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
    ];
    const last = lastCommentByThread(comments);
    expect(last.size).toBe(3);
    expect(last.get("t1")?.author_role).toBe("student");
    expect(last.get("t2")?.author_role).toBe("teacher");
    expect(last.get("t3")?.author_role).toBe("student");
  });
});

describe("pendingResponsesCount — rol-based", () => {
  it("retorna 0 cuando no hay threads", () => {
    expect(pendingResponsesCount([], [])).toBe(0);
  });

  it("cuenta thread cuyo último es del estudiante", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "teacher", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t1", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(pendingResponsesCount(["t1"], comments)).toBe(1);
  });

  it("NO cuenta thread cuyo último es de cualquier docente", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t1", author_role: "teacher", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(pendingResponsesCount(["t1"], comments)).toBe(0);
  });

  it("NO cuenta cuando OTRO docente respondió (el cambio rol-based)", () => {
    // En la versión anterior, "no soy yo" → contaba. Ahora "cualquier
    // teacher cuenta como respondido" → NO cuenta.
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t1", author_role: "teacher", created_at: "2026-01-02T10:00:00Z" },
    ];
    // Da igual quién hace la consulta — solo importa que el último es teacher.
    expect(pendingResponsesCount(["t1"], comments)).toBe(0);
  });

  it("solo cuenta los threads cuyo ID está en la lista", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "tX", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(pendingResponsesCount(["t1"], comments)).toBe(1);
  });

  it("threads sin ningún comment NO cuentan", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(pendingResponsesCount(["t1", "t2"], comments)).toBe(1);
  });

  it("cuenta varios threads pendientes a la vez", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t2", author_role: "teacher", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t3", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t4", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(pendingResponsesCount(["t1", "t2", "t3", "t4"], comments)).toBe(3);
  });

  it("último teacher gana aunque haya muchos student antes", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-01T10:00:00Z" },
      { thread_id: "t1", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t1", author_role: "student", created_at: "2026-01-03T10:00:00Z" },
      { thread_id: "t1", author_role: "teacher", created_at: "2026-01-04T10:00:00Z" },
    ];
    expect(pendingResponsesCount(["t1"], comments)).toBe(0);
  });

  it("comments con author_role null cuentan como 'student' (fallback seguro)", () => {
    // Comentarios viejos pre-migración del campo. Asumimos que son del
    // estudiante porque el escenario común es: alumno escribió → docente
    // aún no respondió.
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: null, created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(pendingResponsesCount(["t1"], comments)).toBe(1);
  });
});

describe("threadsPendingTeacherResponse", () => {
  it("incluye solo los IDs de threads pendientes", () => {
    const comments: CommentLite[] = [
      { thread_id: "t1", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t2", author_role: "teacher", created_at: "2026-01-02T10:00:00Z" },
      { thread_id: "t3", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
    ];
    const result = threadsPendingTeacherResponse(["t1", "t2", "t3"], comments);
    expect(result.size).toBe(2);
    expect(result.has("t1")).toBe(true);
    expect(result.has("t2")).toBe(false);
    expect(result.has("t3")).toBe(true);
  });

  it("threads sin comments no entran al Set", () => {
    const result = threadsPendingTeacherResponse(["t1"], []);
    expect(result.size).toBe(0);
  });

  it("ignora threads cuyo id no está en la lista", () => {
    const comments: CommentLite[] = [
      { thread_id: "tOTHER", author_role: "student", created_at: "2026-01-02T10:00:00Z" },
    ];
    expect(threadsPendingTeacherResponse(["t1"], comments).size).toBe(0);
  });
});

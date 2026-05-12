import { describe, expect, it } from "vitest";
import { friendlyUniqueViolation } from "./db-errors";

describe("friendlyUniqueViolation", () => {
  it("retorna null si el error es null/undefined", () => {
    expect(friendlyUniqueViolation(null)).toBeNull();
    expect(friendlyUniqueViolation(undefined)).toBeNull();
  });

  it("retorna null si el code NO es 23505", () => {
    expect(friendlyUniqueViolation({ code: "23502", message: "x" })).toBeNull();
    expect(friendlyUniqueViolation({ code: "42P01", message: "x" })).toBeNull();
  });

  it("retorna null si no hay code", () => {
    expect(friendlyUniqueViolation({ message: "duplicate" })).toBeNull();
  });

  it("matchea index de emails institucionales", () => {
    const err = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "profiles_institutional_email_lower_idx"',
      details: "Key (lower(institutional_email))=(juan@uni.edu) already exists.",
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un usuario con ese correo institucional.");
  });

  it("matchea index de emails personales", () => {
    const err = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "profiles_personal_email_lower_idx"',
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un usuario con ese correo personal.");
  });

  it("matchea index de titulos por curso — examenes", () => {
    const err = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "exams_course_title_lower_uidx"',
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un examen con ese título en este curso.");
  });

  it("matchea index de titulos por curso — talleres", () => {
    const err = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "workshops_course_title_lower_uidx"',
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un taller con ese título en este curso.");
  });

  it("matchea index de titulos por curso — proyectos", () => {
    const err = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "projects_course_title_lower_uidx"',
    };
    expect(friendlyUniqueViolation(err)).toBe(
      "Ya existe un proyecto con ese título en este curso.",
    );
  });

  it("matchea cortes por curso", () => {
    const err = {
      code: "23505",
      message:
        'duplicate key value violates unique constraint "grade_cuts_course_name_lower_uidx"',
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un corte con ese nombre en este curso.");
  });

  it("matchea sesiones — nombre legacy", () => {
    const err = {
      code: "23505",
      message: "violates unique constraint attendance_sessions_course_id_session_date_title_key",
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya hay una sesión con ese título en esa fecha.");
  });

  it("matchea sesiones — nombre nuevo (lower)", () => {
    const err = {
      code: "23505",
      message: "violates unique constraint attendance_sessions_course_date_title_lower_uidx",
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya hay una sesión con ese título en esa fecha.");
  });

  it("matchea grupos de talleres — legacy y lower", () => {
    expect(
      friendlyUniqueViolation({
        code: "23505",
        message: "violates unique constraint workshop_groups_workshop_id_name_key",
      }),
    ).toBe("Ya existe un grupo con ese nombre en este taller.");
    expect(
      friendlyUniqueViolation({
        code: "23505",
        message: "violates unique constraint workshop_groups_workshop_name_lower_uidx",
      }),
    ).toBe("Ya existe un grupo con ese nombre en este taller.");
  });

  it("matchea grupos de proyectos — legacy y lower", () => {
    expect(
      friendlyUniqueViolation({
        code: "23505",
        message: "violates unique constraint project_groups_project_id_name_key",
      }),
    ).toBe("Ya existe un grupo con ese nombre en este proyecto.");
    expect(
      friendlyUniqueViolation({
        code: "23505",
        message: "violates unique constraint project_groups_project_name_lower_uidx",
      }),
    ).toBe("Ya existe un grupo con ese nombre en este proyecto.");
  });

  it("fallback generico si es 23505 pero el index no esta mapeado", () => {
    const err = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "alguna_otra_constraint_que_no_existe"',
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un registro con esos datos.");
  });

  it("lee code desde error.cause.code (fetch wrapped)", () => {
    // Algunos clientes envuelven el error de Postgres en `cause`.
    const err = {
      cause: { code: "23505" },
      message: "violates unique constraint exams_course_title_lower_uidx",
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un examen con ese título en este curso.");
  });

  it("usa `details` cuando el nombre del constraint esta ahi", () => {
    const err = {
      code: "23505",
      message: "duplicate key",
      details: 'Key (...) already exists. Constraint: "exams_course_title_lower_uidx"',
    };
    expect(friendlyUniqueViolation(err)).toBe("Ya existe un examen con ese título en este curso.");
  });
});

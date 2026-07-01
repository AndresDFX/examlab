import { describe, expect, it } from "vitest";
import { friendlyUniqueViolation, friendlyError } from "./db-errors";

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

describe("friendlyError", () => {
  it("nunca retorna vacío: null → genérico o fallback", () => {
    expect(friendlyError(null)).toBe("Ocurrió un error inesperado");
    expect(friendlyError(null, "Algo salió mal")).toBe("Algo salió mal");
  });

  it("traduce códigos SQLSTATE comunes al español", () => {
    expect(friendlyError({ code: "23503" })).toMatch(/datos relacionados/);
    expect(friendlyError({ code: "23502" })).toMatch(/campo obligatorio/);
    expect(friendlyError({ code: "23514" })).toMatch(/reglas de validación/);
    expect(friendlyError({ code: "42501" })).toBe("No tienes permisos para realizar esta acción.");
    expect(friendlyError({ code: "PGRST116" })).toBe("No se encontró el registro.");
  });

  it("delega en unique_violation (23505)", () => {
    expect(
      friendlyError({
        code: "23505",
        message: "violates unique constraint exams_course_title_lower_uidx",
      }),
    ).toBe("Ya existe un examen con ese título en este curso.");
  });

  it("P0001 en español se muestra tal cual", () => {
    expect(friendlyError({ code: "P0001", message: "El curso ya está cerrado." })).toBe(
      "El curso ya está cerrado.",
    );
  });

  it("P0001 'not authorized' (legacy en inglés) se traduce", () => {
    expect(friendlyError({ code: "P0001", message: "not authorized" })).toBe(
      "No tienes permisos para realizar esta acción.",
    );
    expect(friendlyError({ code: "P0001", message: "User is not allowed" })).toBe(
      "No tienes permisos para realizar esta acción.",
    );
  });

  it("traduce patrones de red / auth del mensaje", () => {
    expect(friendlyError({ message: "Failed to fetch" })).toMatch(/Error de red/);
    expect(friendlyError({ message: "Invalid login credentials" })).toBe(
      "Correo o contraseña inválidos.",
    );
    expect(friendlyError({ message: "rate limit exceeded" })).toMatch(/Demasiados intentos/);
  });

  it("error no reconocido → usa el fallback en español (no el inglés crudo)", () => {
    expect(
      friendlyError(new Error("Database error creating new user"), "No se pudo crear el usuario."),
    ).toBe("No se pudo crear el usuario.");
  });

  it("error no reconocido SIN fallback → muestra el mensaje original (último recurso)", () => {
    expect(friendlyError(new Error("algo raro"))).toBe("algo raro");
  });

  // String plano (edges que reportan failed[].error como string) — antes caía
  // al genérico "Ocurrió un error inesperado" perdiendo el motivo real.
  it("string plano en español → se muestra tal cual", () => {
    expect(friendlyError("Cuenta SSO: el cambio de contraseña no aplica")).toBe(
      "Cuenta SSO: el cambio de contraseña no aplica",
    );
    expect(friendlyError("No autorizado para este usuario")).toBe(
      "No autorizado para este usuario",
    );
  });

  it("string en inglés de auth → se traduce", () => {
    expect(friendlyError("Not authorized")).toBe("No tienes permisos para realizar esta acción.");
    expect(friendlyError("permission denied for table foo")).toBe(
      "No tienes permisos para realizar esta acción.",
    );
  });

  it("string vacío → fallback / genérico", () => {
    expect(friendlyError("   ", "No se pudo")).toBe("No se pudo");
    expect(friendlyError("")).toBe("Ocurrió un error inesperado");
  });
});

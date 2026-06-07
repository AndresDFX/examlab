/**
 * Tests del mapeo path → módulo (ModuleRouteGuard).
 *
 * El guard centralizado mira el pathname actual y, vía `resolveModule`,
 * decide qué módulo aplicar para `ModuleGuard`. Si un path nuevo se
 * agrega al sidebar pero NO al mapeo, el toggle de visibilidad NO se
 * enforza en esa ruta y un usuario con módulo apagado podría acceder
 * pegando la URL.
 *
 * Estos tests cubren:
 *  - Rutas de cada rol (Admin, SuperAdmin, Docente, Estudiante) que
 *    resuelven a su módulo correcto.
 *  - Sub-rutas con parámetros (`/take/<examId>`) que matchean el prefix
 *    del padre.
 *  - Rutas NO togglables (`/app`, `/app/preferences`,
 *    `/app/admin/settings`) que devuelven `null` para que el guard no
 *    aplique.
 *  - Sincronía con NAV_PATH_TO_MODULE: cada path docente/admin/student
 *    canónico debe tener cobertura en ambos lados.
 */
import { describe, expect, it } from "vitest";
import { resolveModule } from "./ModuleRouteGuard";

describe("resolveModule — rutas Admin", () => {
  it("/app/admin/academic → academic", () => {
    expect(resolveModule("/app/admin/academic")).toBe("academic");
  });
  it("/app/admin/courses → courses", () => {
    expect(resolveModule("/app/admin/courses")).toBe("courses");
  });
  it("/app/admin/users → users (NO teacher_students)", () => {
    // Antes esto mapeaba a `teacher_students` y "Usuarios" en la matriz
    // del panel era una sola fila físicamente. Refactor: la fila virtual
    // "Usuarios" usa roleKeyMap → Admin/SuperAdmin escribe (users, X)
    // mientras Docente escribe (teacher_students, Docente). Si este test
    // vuelve a esperar `teacher_students`, el toggle "Usuarios > Admin"
    // del panel deja de tener efecto sobre /app/admin/users.
    expect(resolveModule("/app/admin/users")).toBe("users");
  });
  it("/app/admin/ai-cron → ai_cron", () => {
    expect(resolveModule("/app/admin/ai-cron")).toBe("ai_cron");
  });
  it("/app/admin/statistics → statistics", () => {
    expect(resolveModule("/app/admin/statistics")).toBe("statistics");
  });
  it("/app/admin/audit-logs → audit_logs", () => {
    expect(resolveModule("/app/admin/audit-logs")).toBe("audit_logs");
  });
  it("/app/admin/report-templates → reports", () => {
    expect(resolveModule("/app/admin/report-templates")).toBe("reports");
  });
});

describe("resolveModule — rutas SuperAdmin", () => {
  it("/app/superadmin/tenants → tenants", () => {
    expect(resolveModule("/app/superadmin/tenants")).toBe("tenants");
  });
});

describe("resolveModule — rutas Docente", () => {
  it("/app/teacher/courses → courses", () => {
    expect(resolveModule("/app/teacher/courses")).toBe("courses");
  });
  it("/app/teacher/exams → exams", () => {
    expect(resolveModule("/app/teacher/exams")).toBe("exams");
  });
  it("/app/teacher/exams/<examId> → exams (sub-ruta con param)", () => {
    expect(resolveModule("/app/teacher/exams/abc-123")).toBe("exams");
  });
  it("/app/teacher/monitor/<examId> → exams (monitor reusa toggle exams)", () => {
    expect(resolveModule("/app/teacher/monitor/abc-123")).toBe("exams");
  });
  it("/app/teacher/workshops → workshops", () => {
    expect(resolveModule("/app/teacher/workshops")).toBe("workshops");
  });
  it("/app/teacher/projects → projects", () => {
    expect(resolveModule("/app/teacher/projects")).toBe("projects");
  });
  it("/app/teacher/gradebook → gradebook", () => {
    expect(resolveModule("/app/teacher/gradebook")).toBe("gradebook");
  });
  it("/app/teacher/attendance → attendance", () => {
    expect(resolveModule("/app/teacher/attendance")).toBe("attendance");
  });
  it("/app/teacher/calendar → calendar", () => {
    expect(resolveModule("/app/teacher/calendar")).toBe("calendar");
  });
  it("/app/teacher/question-bank → question_bank", () => {
    expect(resolveModule("/app/teacher/question-bank")).toBe("question_bank");
  });
  it("/app/teacher/polls → polls", () => {
    expect(resolveModule("/app/teacher/polls")).toBe("polls");
  });
  it("/app/teacher/whiteboards → whiteboards", () => {
    expect(resolveModule("/app/teacher/whiteboards")).toBe("whiteboards");
  });
  it("/app/teacher/ai-cron → ai_cron", () => {
    expect(resolveModule("/app/teacher/ai-cron")).toBe("ai_cron");
  });
  it("/app/teacher/contents → contents", () => {
    expect(resolveModule("/app/teacher/contents")).toBe("contents");
  });
  it("/app/teacher/students → teacher_students", () => {
    expect(resolveModule("/app/teacher/students")).toBe("teacher_students");
  });
  it("/app/teacher/audit-logs → audit_logs", () => {
    expect(resolveModule("/app/teacher/audit-logs")).toBe("audit_logs");
  });
});

describe("resolveModule — rutas Estudiante", () => {
  it("/app/student/courses → courses", () => {
    expect(resolveModule("/app/student/courses")).toBe("courses");
  });
  it("/app/student/exams → exams", () => {
    expect(resolveModule("/app/student/exams")).toBe("exams");
  });
  it("/app/student/take/<examId> → exams", () => {
    expect(resolveModule("/app/student/take/abc-123")).toBe("exams");
  });
  it("/app/student/review/<examId> → exams", () => {
    expect(resolveModule("/app/student/review/abc-123")).toBe("exams");
  });
  it("/app/student/workshops → workshops", () => {
    expect(resolveModule("/app/student/workshops")).toBe("workshops");
  });
  it("/app/student/workshop/<id> → workshops", () => {
    expect(resolveModule("/app/student/workshop/xyz")).toBe("workshops");
  });
  it("/app/student/projects → projects", () => {
    expect(resolveModule("/app/student/projects")).toBe("projects");
  });
  it("/app/student/grades → grades", () => {
    expect(resolveModule("/app/student/grades")).toBe("grades");
  });
  it("/app/student/attendance → attendance", () => {
    expect(resolveModule("/app/student/attendance")).toBe("attendance");
  });
  it("/app/student/calendar → calendar", () => {
    expect(resolveModule("/app/student/calendar")).toBe("calendar");
  });
  it("/app/student/certificates → certificates", () => {
    expect(resolveModule("/app/student/certificates")).toBe("certificates");
  });
  it("/app/student/whiteboards → whiteboards", () => {
    expect(resolveModule("/app/student/whiteboards")).toBe("whiteboards");
  });
  it("/app/student/polls → polls", () => {
    expect(resolveModule("/app/student/polls")).toBe("polls");
  });
  it("/app/student/tutor → tutor", () => {
    expect(resolveModule("/app/student/tutor")).toBe("tutor");
  });
  it("/app/student/tutor/<courseId> → tutor", () => {
    expect(resolveModule("/app/student/tutor/curso-abc")).toBe("tutor");
  });
});

describe("resolveModule — rutas comunes (cross-rol)", () => {
  it("/app/certificates → certificates", () => {
    expect(resolveModule("/app/certificates")).toBe("certificates");
  });
  it("/app/videos → videos", () => {
    expect(resolveModule("/app/videos")).toBe("videos");
  });
  it("/app/forum/<courseId> → forum", () => {
    expect(resolveModule("/app/forum/abc-123")).toBe("forum");
  });
  it("/app/messages → messages", () => {
    expect(resolveModule("/app/messages")).toBe("messages");
  });
  it("/app/trash → trash", () => {
    expect(resolveModule("/app/trash")).toBe("trash");
  });
});

describe("resolveModule — rutas NO togglables (devuelven null)", () => {
  // Estas rutas son utilidades transversales (no aparecen en la matriz
  // de módulos) — el guard centralizado debe pasarles `null` para que
  // ModuleGuard no se aplique. Si alguna empezara a matchear un módulo
  // por accidente, el admin que apague ese módulo perdería acceso a una
  // página crítica (configuración / settings).
  it("/app → null (dashboard, sin gating per-módulo)", () => {
    expect(resolveModule("/app")).toBe(null);
  });
  it("/app/preferences → null", () => {
    expect(resolveModule("/app/preferences")).toBe(null);
  });
  it("/app/admin/settings → null (escape hatch para reactivar toggles)", () => {
    expect(resolveModule("/app/admin/settings")).toBe(null);
  });
  it("/app/superadmin/system → null", () => {
    expect(resolveModule("/app/superadmin/system")).toBe(null);
  });
  it("/auth → null (fuera del scope de módulos)", () => {
    expect(resolveModule("/auth")).toBe(null);
  });
});

describe("resolveModule — defensiva contra pathnames con artefactos", () => {
  it("trailing slash: /app/teacher/exams/ → exams", () => {
    expect(resolveModule("/app/teacher/exams/")).toBe("exams");
  });
  it("path con un sufijo extra que NO es subruta: /app/teacher/examsX → exams (3er fallback startsWith)", () => {
    // Caso edge: el 3er check `startsWith(prefix)` matchea aunque no
    // haya `/`. Documentamos el comportamiento — si en el futuro se
    // agrega una ruta `/app/teacher/examsX` que NO debería resolverse a
    // exams, hay que ajustar el matcher. Por ahora ExamLab no tiene
    // colisiones de prefijo, así que esto pasa intencional.
    expect(resolveModule("/app/teacher/examsX")).toBe("exams");
  });
});

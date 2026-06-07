/**
 * ModuleRouteGuard — wrapper centralizado que mira el `pathname` actual,
 * lo mapea a un módulo conocido y aplica `ModuleGuard`. Si la URL no
 * matchea ningún módulo (rutas neutrales como /app, /app/preferences,
 * /app/superadmin/*), renderiza children sin filtrar.
 *
 * Esto evita tener que envolver cada uno de los 40+ archivos de ruta
 * con ModuleGuard manualmente. La fuente de verdad para "qué URL = qué
 * módulo" vive en una tabla local que se mantiene cerca del routing.
 */
import { useLocation } from "@tanstack/react-router";
import { ModuleGuard } from "@/shared/components/ModuleGuard";
import type { ModuleKey } from "@/hooks/use-module-visibility";

// Mapeo prefijo de path → módulo. Orden importa: lo más específico
// arriba. La función itera y se queda con el primer prefijo que matche.
//
// IMPORTANTE: mantener sincronizado con `NAV_PATH_TO_MODULE` en
// `AppLayout.tsx`. El sidebar y el route guard deben respetar las MISMAS
// asociaciones path→module para que el ítem del nav y el contenido de
// la ruta se enciendan/apaguen juntos. Si agregás una ruta nueva al
// nav, agregá su prefijo acá también.
const PREFIX_TO_MODULE: Array<[string, ModuleKey]> = [
  // ── Admin ─────────────────────────────────────────────────────────
  ["/app/admin/academic", "academic"],
  ["/app/admin/courses", "courses"],
  // /app/admin/users → módulo `users` (CRUD del tenant), NO
  // `teacher_students` (que es la vista del docente). Ambos viven bajo
  // la misma fila virtual "Usuarios" en el panel "Módulos" via
  // roleKeyMap — el toggle de Admin escribe (users, Admin) y el de
  // Docente escribe (teacher_students, Docente).
  ["/app/admin/users", "users"],
  ["/app/admin/ai-prompts", "ai_prompts"],
  ["/app/admin/ai-cron", "ai_cron"],
  ["/app/admin/statistics", "statistics"],
  ["/app/admin/audit-logs", "audit_logs"],
  ["/app/admin/report-templates", "reports"],

  // ── SuperAdmin ────────────────────────────────────────────────────
  ["/app/superadmin/tenants", "tenants"],
  ["/app/superadmin/system", "system"],

  // ── Docente ───────────────────────────────────────────────────────
  ["/app/teacher/courses", "courses"],
  ["/app/teacher/workshops", "workshops"],
  ["/app/teacher/projects", "projects"],
  ["/app/teacher/exams", "exams"],
  ["/app/teacher/monitor", "exams"],
  ["/app/teacher/gradebook", "gradebook"],
  ["/app/teacher/grading", "gradebook"],
  ["/app/teacher/attendance", "attendance"],
  ["/app/teacher/calendar", "calendar"],
  ["/app/teacher/question-bank", "question_bank"],
  ["/app/teacher/ai-prompts", "ai_prompts"],
  ["/app/teacher/ai-cron", "ai_cron"],
  ["/app/teacher/contents", "contents"],
  ["/app/teacher/polls", "polls"],
  ["/app/teacher/whiteboards", "whiteboards"],
  ["/app/teacher/statistics", "statistics"],
  ["/app/teacher/reports", "reports"],
  ["/app/teacher/audit-logs", "audit_logs"],
  ["/app/teacher/students", "teacher_students"],

  // ── Estudiante ────────────────────────────────────────────────────
  ["/app/student/courses", "courses"],
  ["/app/student/workshops", "workshops"],
  ["/app/student/workshop/", "workshops"],
  ["/app/student/projects", "projects"],
  ["/app/student/project/", "projects"],
  ["/app/student/exams", "exams"],
  ["/app/student/review/", "exams"],
  ["/app/student/take/", "exams"],
  ["/app/student/grades", "grades"],
  ["/app/student/attendance", "attendance"],
  ["/app/student/calendar", "calendar"],
  ["/app/student/certificates", "certificates"],
  ["/app/student/whiteboards", "whiteboards"],
  ["/app/student/polls", "polls"],
  ["/app/student/tutor/", "tutor"],
  ["/app/student/tutor", "tutor"],

  // ── Comunes (todos los roles) ─────────────────────────────────────
  ["/app/certificates", "certificates"],
  ["/app/videos", "videos"],
  ["/app/forum/", "forum"],
  ["/app/messages", "messages"],
  ["/app/trash", "trash"],

  // Rutas NO togglables (intencional): /app, /app/preferences,
  // /app/admin/settings — no aparecen en MODULES. Configuración es el
  // escape hatch para reactivar cualquier módulo apagado por error;
  // si la togglés podés quedar trabado sin vía de retorno.
];

/**
 * Resuelve el módulo para un pathname dado. Exportada como NAMED export
 * para ser testeable sin montar React Router / jsdom.
 *
 * Reglas de matching:
 *   - Match exacto (`pathname === prefix`) → módulo correspondiente.
 *   - Match con `/` (`pathname.startsWith(prefix + "/")`) → cubre sub-
 *     rutas como `/app/teacher/exams/<examId>`.
 *   - El tercer check (`startsWith(prefix)` sin `/`) es defensivo: cubre
 *     prefijos sin trailing slash en pathnames con query/hash.
 * Devuelve `null` si el path no matchea ninguna ruta togglable (ej.
 * `/app`, `/app/admin/settings`, `/app/preferences`) — esas rutas no
 * pasan por el guard.
 */
export function resolveModule(pathname: string): ModuleKey | null {
  for (const [prefix, mod] of PREFIX_TO_MODULE) {
    if (pathname === prefix || pathname.startsWith(prefix + "/") || pathname.startsWith(prefix)) {
      return mod;
    }
  }
  return null;
}

export function ModuleRouteGuard({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const mod = resolveModule(pathname);
  if (!mod) return <>{children}</>;
  return <ModuleGuard module={mod}>{children}</ModuleGuard>;
}

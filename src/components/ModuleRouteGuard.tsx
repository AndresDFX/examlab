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
import { ModuleGuard } from "@/components/ModuleGuard";
import type { ModuleKey } from "@/hooks/use-module-visibility";

// Mapeo prefijo de path → módulo. Orden importa: lo más específico
// arriba. La función itera y se queda con el primer prefijo que matche.
const PREFIX_TO_MODULE: Array<[string, ModuleKey]> = [
  // Rutas docente
  ["/app/teacher/workshops", "workshops"],
  ["/app/teacher/projects", "projects"],
  ["/app/teacher/exams", "exams"],
  ["/app/teacher/monitor", "exams"],
  ["/app/teacher/gradebook", "gradebook"],
  ["/app/teacher/attendance", "attendance"],
  ["/app/teacher/calendar", "calendar"],
  ["/app/teacher/question-bank", "question_bank"],
  ["/app/teacher/ai-prompts", "ai_prompts"],

  // Rutas estudiante
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
  ["/app/certificates", "certificates"],
  ["/app/student/tutor/", "tutor"],

  // Rutas comunes
  ["/app/forum/", "forum"],
  ["/app/messages", "messages"],

  // Admin: routes admin no toggleables (siempre visibles para Admin —
  // y como Admin bypassa el guard, esto es moot).
];

function resolveModule(pathname: string): ModuleKey | null {
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

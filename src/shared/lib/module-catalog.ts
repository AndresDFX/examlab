/**
 * Catálogo canónico de la "organización de módulos" — ÚNICA fuente de verdad
 * de qué módulos existen, cómo se muestran en el panel de visibilidad y cómo
 * mapea el sidebar cada ruta a su módulo.
 *
 * Consumido por:
 *   - AdminModuleVisibilityPanel  → MODULE_CATALOG (filas del panel "Módulos")
 *   - AppLayout                   → NAV_PATH_TO_MODULE (orden/visibility del sidebar)
 *   - module-catalog.test.ts      → guardrails de consistencia (ver ese archivo)
 *
 * GUARDRAIL: `ALL_MODULE_KEYS` DEBE quedar exhaustivo respecto al type
 * `ModuleKey` — el check de compile-time de abajo ROMPE el build si agregás un
 * módulo al type y te olvidás de la lista (o viceversa). El test cruza además
 * que cada ModuleKey tenga fila en el panel y que las rutas mapeen a módulos
 * válidos. Al crear un módulo nuevo, seguí el checklist de CLAUDE.md
 * ("Checklist para agregar un módulo nuevo").
 */
import type { ModuleKey, RoleKey } from "@/hooks/use-module-visibility";

export type ModuleRoleKey = RoleKey;

/**
 * Lista RUNTIME de todos los module_key reales. Mantener exhaustiva vs el type
 * `ModuleKey` (el check de abajo lo fuerza en compile-time).
 */
export const ALL_MODULE_KEYS = [
  "dashboard",
  "academic",
  "courses",
  "contents",
  "exams",
  "workshops",
  "projects",
  "whiteboards",
  "gradebook",
  "grades",
  "attendance",
  "polls",
  "forum",
  "calendar",
  "certificates",
  "tutor",
  "question_bank",
  "ai_prompts",
  "ai_cron",
  "statistics",
  "messages",
  "notifications",
  "support",
  "support_assistant",
  "videos",
  "users",
  "teacher_students",
  "reports",
  "audit_logs",
  "trash",
  "tenants",
  "system",
  "configuration",
] as const satisfies readonly ModuleKey[];

// ── Guardrail de exhaustividad (compile-time) ───────────────────────────────
// Si falta un ModuleKey en ALL_MODULE_KEYS, `_MissingFromList` deja de ser
// `never` y la asignación de `_exhaustiveModuleKeys` NO compila → build roto.
type _MissingFromList = Exclude<ModuleKey, (typeof ALL_MODULE_KEYS)[number]>;
const _exhaustiveModuleKeys: [_MissingFromList] extends [never] ? true : ["FALTAN en ALL_MODULE_KEYS", _MissingFromList] =
  true;
void _exhaustiveModuleKeys;

export interface ModuleCatalogEntry {
  /** module_key directo, o key VIRTUAL (calificaciones/users) que se resuelve
   *  a un module_key físico por rol vía `roleKeyMap`. */
  key: string;
  label: string;
  /** Cuando presente: la fila del panel es virtual (una fila, varios
   *  module_key físicos según el rol). */
  roleKeyMap?: Partial<Record<ModuleRoleKey, ModuleKey>>;
}

/**
 * Filas del panel "Módulos" (AdminModuleVisibilityPanel). Los labels alinean
 * con el sidebar (`nav.*`); si renombrás un item del nav, sincronizá acá.
 */
export const MODULE_CATALOG: ModuleCatalogEntry[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "academic", label: "Académico" },
  { key: "courses", label: "Cursos" },
  { key: "contents", label: "Contenidos" },
  { key: "exams", label: "Exámenes" },
  { key: "workshops", label: "Talleres" },
  { key: "projects", label: "Proyectos" },
  { key: "whiteboards", label: "Pizarras" },
  {
    // Virtual: Admin/SA/Docente → gradebook, Estudiante → grades.
    key: "calificaciones",
    label: "Calificaciones",
    roleKeyMap: { Admin: "gradebook", SuperAdmin: "gradebook", Docente: "gradebook", Estudiante: "grades" },
  },
  { key: "attendance", label: "Asistencia" },
  { key: "polls", label: "Encuestas" },
  { key: "forum", label: "Foros" },
  { key: "calendar", label: "Calendario" },
  { key: "certificates", label: "Certificaciones" },
  { key: "tutor", label: "Tutor del curso" },
  { key: "question_bank", label: "Banco de preguntas" },
  { key: "ai_prompts", label: "Prompts" },
  { key: "ai_cron", label: "Cola" },
  { key: "statistics", label: "Estadísticas" },
  { key: "messages", label: "Mensajes" },
  { key: "notifications", label: "Notificaciones" },
  { key: "support", label: "Soporte" },
  { key: "support_assistant", label: "Asistente IA" },
  { key: "videos", label: "Videos" },
  {
    // Virtual: Admin/SA → users, Docente → teacher_students, Estudiante → n/a.
    key: "users",
    label: "Usuarios",
    roleKeyMap: { Admin: "users", SuperAdmin: "users", Docente: "teacher_students" },
  },
  { key: "reports", label: "Informes" },
  { key: "audit_logs", label: "Auditoría" },
  { key: "trash", label: "Papelera" },
  { key: "tenants", label: "Instituciones" },
  { key: "system", label: "Sistema" },
  { key: "configuration", label: "Configuración" },
];

/**
 * module_key REALES gobernados por el panel: para filas virtuales expande los
 * valores del roleKeyMap; para filas directas, el propio key. (Excluye los
 * keys virtuales "calificaciones"/"users" que NO son module_key físicos.)
 */
export function panelCoveredModuleKeys(): Set<string> {
  const s = new Set<string>();
  for (const m of MODULE_CATALOG) {
    const mapped = m.roleKeyMap ? Object.values(m.roleKeyMap) : [];
    if (mapped.length) {
      for (const v of mapped) if (v) s.add(v);
    } else {
      s.add(m.key);
    }
  }
  return s;
}

/**
 * Mapeo EXACTO ruta del sidebar → módulo (para orden/visibility del nav). El
 * sidebar (AppLayout) lo usa para que cada item respete el toggle del panel.
 * DEBE mantenerse en sincronía con `PREFIX_TO_MODULE` (ModuleRouteGuard), que
 * hace lo mismo para el gating de RUTAS (con prefijos + sub-rutas).
 */
export const NAV_PATH_TO_MODULE: Array<[string, ModuleKey]> = [
  ["/app", "dashboard"],
  ["/app/admin/courses", "courses"],
  ["/app/teacher/courses", "courses"],
  ["/app/student/courses", "courses"],
  ["/app/teacher/workshops", "workshops"],
  ["/app/student/workshops", "workshops"],
  ["/app/teacher/projects", "projects"],
  ["/app/student/projects", "projects"],
  ["/app/teacher/exams", "exams"],
  ["/app/student/exams", "exams"],
  ["/app/teacher/gradebook", "gradebook"],
  ["/app/student/grades", "grades"],
  ["/app/teacher/attendance", "attendance"],
  ["/app/student/attendance", "attendance"],
  ["/app/teacher/calendar", "calendar"],
  ["/app/student/calendar", "calendar"],
  ["/app/student/certificates", "certificates"],
  ["/app/certificates", "certificates"],
  ["/app/teacher/question-bank", "question_bank"],
  ["/app/teacher/ai-prompts", "ai_prompts"],
  ["/app/admin/ai-prompts", "ai_prompts"],
  ["/app/teacher/ai-cron", "ai_cron"],
  ["/app/admin/ai-cron", "ai_cron"],
  ["/app/teacher/statistics", "statistics"],
  ["/app/admin/statistics", "statistics"],
  ["/app/teacher/contents", "contents"],
  ["/app/videos", "videos"],
  ["/app/student/tutor", "tutor"],
  ["/app/teacher/students", "teacher_students"],
  ["/app/admin/users", "users"],
  ["/app/admin/report-templates", "reports"],
  ["/app/teacher/reports", "reports"],
  ["/app/admin/academic", "academic"],
  ["/app/teacher/polls", "polls"],
  ["/app/student/polls", "polls"],
  ["/app/teacher/audit-logs", "audit_logs"],
  ["/app/admin/audit-logs", "audit_logs"],
  ["/app/teacher/whiteboards", "whiteboards"],
  ["/app/student/whiteboards", "whiteboards"],
  ["/app/trash", "trash"],
  ["/app/superadmin/system", "system"],
  ["/app/superadmin/tenants", "tenants"],
  ["/app/assistant", "support_assistant"],
  ["/app/admin/support", "support"],
  ["/app/superadmin/support", "support"],
  ["/app/admin/settings", "configuration"],
];

/** Resuelve el módulo para un path EXACTO del sidebar (helper del nav). */
export function moduleForNavPath(to: string): ModuleKey | null {
  const found = NAV_PATH_TO_MODULE.find(([prefix]) => to === prefix);
  return found ? found[1] : null;
}

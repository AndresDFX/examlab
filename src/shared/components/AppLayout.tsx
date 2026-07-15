import { Link, useLocation, useNavigate, useMatchRoute } from "@tanstack/react-router";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { useTenant, readTenantOverride, setTenantOverride } from "@/modules/tenants/use-tenant";
import { resolveTenantLogoUrl } from "@/modules/tenants/tenant";
import { ActiveRoleContext } from "@/hooks/use-active-role";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme } from "@/hooks/use-theme";
import { persistThemePreference, useProfileThemeSync } from "@/hooks/use-theme-preference";
import { useMessagingToasts } from "@/hooks/use-messaging-toasts";
import {
  isModuleEnabled,
  getModuleOrder,
  useModuleVisibility,
  type ModuleKey,
  type RoleKey,
} from "@/hooks/use-module-visibility";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";
// ThemeToggle + LanguageSwitcher se siguen usando en el drawer mobile
// (Sheet más abajo), donde sí hay espacio para botones inline. En el
// sidebar de escritorio los reemplazamos por entradas del DropdownMenu.
import { ThemeToggle } from "@/shared/components/ThemeToggle";
import { LanguageSwitcher } from "@/shared/components/LanguageSwitcher";
import { NotificationBell } from "@/modules/notifications/NotificationBell";
import { MessagesBell } from "@/modules/messaging/MessagesBell";
import { MessagesFab } from "@/modules/messaging/MessagesFab";
import { ChangePasswordDialog } from "@/modules/auth/ChangePasswordDialog";
import { EditProfileDialog } from "@/modules/auth/EditProfileDialog";
import { ForceChangePasswordDialog } from "@/modules/auth/ForceChangePasswordDialog";
import { studentAccessLevel } from "@/modules/auth/access-control";
import { captureReturnTo } from "@/shared/lib/return-to";
import { saveLastRoute } from "@/shared/lib/last-route";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { checkAccess, homeForRole } from "@/shared/lib/rbac";
import { sortRolesByDisplay } from "@/shared/lib/role-order";
import { logEvent } from "@/shared/lib/audit";
import { ensurePushSubscription } from "@/modules/notifications/push-subscription";
import { setActiveRoleSignal } from "@/modules/tenants/active-role-signal";
import { ImpersonationBanner } from "@/modules/admin/ImpersonationBanner";
import { IMPERSONATION_TRANSITION_FLAG } from "@/modules/admin/impersonation";
import { TenantOverrideBanner } from "@/modules/tenants/TenantOverrideBanner";
import { KahootLiveBanner } from "@/modules/polls/KahootLiveBanner";
// Lazy: driver.js (+ su CSS) solo se descarga cuando REALMENTE corre un tour
// (primer login del rol o "Ver tour"), no en el shell de cada página /app/*.
const OnboardingTour = lazy(() =>
  import("@/modules/onboarding/OnboardingTour").then((m) => ({ default: m.OnboardingTour })),
);
import { useOnboarding } from "@/modules/onboarding/use-onboarding";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  GraduationCap,
  Users,
  BookOpen,
  FileText,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  UserCog,
  Hammer,
  ChevronsUpDown,
  KeyRound,
  Menu,
  FolderKanban,
  CalendarCheck,
  CalendarDays,
  Sparkles,
  BarChart3,
  ShieldEllipsis,
  Presentation,
  MoreHorizontal,
  Sun,
  Moon,
  Languages,
  Settings,
  Bell,
  Library,
  Award,
  ListChecks,
  Video,
  ListOrdered,
  Building2,
  Wrench,
  Palette,
  HelpCircle,
  Trash2,
  LifeBuoy,
  Bot,
} from "lucide-react";
import { cn } from "@/shared/lib/utils";
import { useState, useEffect, lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

interface NavItem {
  to: string;
  labelKey: string;
  // Permitimos `style` además de `className` para que los íconos puedan
  // recibir el override de color por tenant via inline style con
  // `var(--sidebar-icon-color, currentColor)`. Lucide los acepta nativo.
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  roles: AppRole[];
}

// Orden canónico del nav, igual entre roles. Un rol que no tiene una
// ruta simplemente no la ve, pero la posición relativa de las que sí
// ve es siempre la misma:
//   Dashboard → Cursos → Contenidos → Exámenes → Talleres → Proyectos →
//   Calificaciones → Asistencia → Estadísticas → Prompts → Auditoría →
//   Usuarios.
// "Contenidos" va junto a Cursos porque es la generación pedagógica
// que el docente usa ANTES de crear evaluaciones — orden mental
// curso → preparar material → armar evaluaciones.
// Esto evita que Docente y Admin tengan "Prompts" en posiciones
// distintas (antes Docente lo veía después de Calificaciones y Admin
// al final, lo cual rompía la mental map al cambiar de rol).
const NAV: NavItem[] = [
  {
    to: "/app",
    labelKey: "nav.dashboard",
    icon: LayoutDashboard,
    roles: ["Admin", "Docente", "Estudiante"],
  },
  // Académico: estructura carreras → asignaturas → periodos (el nivel sobre
  // el Curso). Antes vivía dentro de Configuración → Institución; se sacó a
  // su módulo propio para darle visibilidad. SuperAdmin lo hereda vía Admin.
  { to: "/app/admin/academic", labelKey: "nav.academic", icon: GraduationCap, roles: ["Admin"] },
  // Cursos
  { to: "/app/admin/courses", labelKey: "nav.courses", icon: BookOpen, roles: ["Admin"] },
  { to: "/app/teacher/courses", labelKey: "nav.courses", icon: BookOpen, roles: ["Docente"] },
  {
    to: "/app/student/courses",
    labelKey: "nav.studentCourses",
    icon: BookOpen,
    roles: ["Estudiante"],
  },
  // Contenidos: generación de material académico (.pptx + .md) con IA.
  // Va junto a Cursos porque es el insumo pedagógico que el docente
  // usa ANTES de armar exámenes/talleres/proyectos. Admin también lo
  // ve para auditar/gestionar el material que producen los docentes
  // de su institución y crear plantillas centrales. La RLS de la tabla
  // ya filtra por tenant; el RBAC del path lo permite explícitamente
  // (ver rbac.ts `/app/teacher/contents`).
  {
    to: "/app/teacher/contents",
    labelKey: "nav.contents",
    icon: Presentation,
    // SuperAdmin incluido para paridad con whiteboards / pizarras —
    // puede revisar y diagnosticar el módulo de contenidos
    // cross-tenant. RLS filtra a los contenidos visibles.
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  // Banco de preguntas reutilizables por curso (Docente). Va aquí —
  // arriba — porque es el repositorio que alimenta los formularios de
  // exam/taller/proyecto. Tenerlo cerca de Cursos refleja el flujo
  // natural: defino curso → relleno banco → armo evaluaciones.
  // El admin puede ocultarlo globalmente vía app_settings.question_bank_enabled.
  {
    to: "/app/teacher/question-bank",
    labelKey: "nav.questionBank",
    icon: Library,
    // Docente + Admin + SuperAdmin (homologado con Contenidos, el módulo
    // pedagógico hermano). La página YA está codificada para Admin (branch
    // `isAdminLike` que trae todos los cursos del tenant) y la RLS de
    // `question_bank` lo permite (`has_role('Admin')`); faltaba exponerlo en
    // el nav y abrir el path en rbac. SuperAdmin: inspección cross-tenant
    // (RLS recorta). Sin estos roles, el toggle del panel "Módulos" no podía
    // efectuar nada porque el nav filter descartaba el ítem antes.
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  // Exámenes
  {
    to: "/app/teacher/exams",
    labelKey: "nav.exams",
    icon: FileText,
    // Admin homologado: supervisa exámenes de su institución (la página
    // ya usa isStaffRole y carga los cursos del tenant vía RLS).
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  {
    to: "/app/student/exams",
    labelKey: "nav.studentExams",
    icon: FileText,
    roles: ["Estudiante"],
  },
  // Talleres
  {
    to: "/app/teacher/workshops",
    labelKey: "nav.workshops",
    icon: Hammer,
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  {
    to: "/app/student/workshops",
    labelKey: "nav.studentWorkshops",
    icon: Hammer,
    roles: ["Estudiante"],
  },
  // Proyectos
  {
    to: "/app/teacher/projects",
    labelKey: "nav.projects",
    icon: FolderKanban,
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  {
    to: "/app/student/projects",
    labelKey: "nav.studentProjects",
    icon: FolderKanban,
    roles: ["Estudiante"],
  },
  // Calificaciones
  {
    to: "/app/teacher/gradebook",
    labelKey: "nav.grades",
    icon: ClipboardList,
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  {
    to: "/app/student/grades",
    labelKey: "nav.studentGrades",
    icon: ClipboardList,
    roles: ["Estudiante"],
  },
  // Certificados — visible para los 3 roles. La vista compartida en
  // `/app/certificates` (sin user_id filter) deja a RLS limitar el
  // scope: estudiante ve los suyos, docente los de sus cursos, admin
  // todos. La ruta legacy `/app/student/certificates` se mantiene por
  // backward-compat de links viejos, pero el nav ya apunta a la
  // unificada.
  {
    to: "/app/student/certificates",
    labelKey: "nav.studentCertificates",
    icon: Award,
    roles: ["Estudiante"],
  },
  {
    to: "/app/certificates",
    labelKey: "nav.studentCertificates",
    icon: Award,
    roles: ["Docente", "Admin"],
  },
  // Biblioteca de videos: contenedor reusable de URLs (YouTube/Vimeo/
  // MP4) referenciadas desde proyectos/talleres con video gate. Solo
  // staff — los alumnos no tocan la biblioteca, ven el video embebido
  // dentro del módulo que lo usa.
  {
    to: "/app/videos",
    labelKey: "nav.videos",
    icon: Video,
    roles: ["Docente", "Admin"],
  },
  // Asistencia
  {
    to: "/app/teacher/attendance",
    labelKey: "nav.attendance",
    icon: CalendarCheck,
    roles: ["Docente", "Admin", "SuperAdmin"],
  },
  {
    to: "/app/student/attendance",
    labelKey: "nav.studentAttendance",
    icon: CalendarCheck,
    roles: ["Estudiante"],
  },
  // Encuestas — docente lanza preguntas/votaciones (mig 20260720000000).
  // En vivo durante una sesión (tipo single/multiple) o asíncronas tipo
  // Doodle con cupo por opción (tipo slot) — útil para que cada alumno
  // elija fecha de sustentación de proyecto, p.ej.
  {
    to: "/app/teacher/polls",
    labelKey: "nav.polls",
    icon: ListChecks,
    // SuperAdmin agregado para que pueda ver el módulo de encuestas
    // del docente cross-tenant (paridad con whiteboards / contents).
    roles: ["Docente", "SuperAdmin"],
  },
  // Pizarras (whiteboards) — espacio en blanco para que el docente
  // explique conceptos o piense libremente. Excalidraw embebido.
  // Mig 20260603060000 + módulo src/modules/whiteboard. SuperAdmin
  // accede para asistir a docentes cross-tenant; Admin no se incluye
  // porque la pizarra es contenido del Docente — la gestión vive en
  // su propio rol.
  {
    to: "/app/teacher/whiteboards",
    labelKey: "nav.whiteboards",
    icon: Palette,
    roles: ["Docente", "SuperAdmin"],
  },
  // Vista del estudiante de las pizarras compartidas por sus docentes
  // (is_shared_with_course=true). Read-only — la RLS bloquea write.
  {
    to: "/app/student/whiteboards",
    labelKey: "nav.whiteboards",
    icon: Palette,
    roles: ["Estudiante"],
  },
  {
    to: "/app/student/polls",
    labelKey: "nav.polls",
    icon: ListChecks,
    roles: ["Estudiante"],
  },
  {
    to: "/app/teacher/calendar",
    labelKey: "nav.calendar",
    icon: CalendarDays,
    roles: ["Docente", "SuperAdmin"],
  },
  // Calendario integral del estudiante (lista unificada + sync .ics)
  {
    to: "/app/student/calendar",
    labelKey: "nav.studentCalendar",
    icon: CalendarDays,
    roles: ["Estudiante"],
  },
  // Tutor IA: ruta índice que lista cursos del alumno y enlaza al chat
  // específico de cada curso (`/app/student/tutor/$courseId`). Antes no
  // había entrada en el sidebar porque el chat exige courseId y no se
  // puede poner una URL parametrizada en el menú; la nueva ruta index
  // sirve como punto de entrada.
  {
    to: "/app/student/tutor",
    labelKey: "nav.tutor",
    icon: Sparkles,
    roles: ["Estudiante"],
  },
  // Estadísticas — vista por curso (Docente) y agregada (Admin).
  {
    to: "/app/teacher/statistics",
    labelKey: "nav.statistics",
    icon: BarChart3,
    roles: ["Docente"],
  },
  {
    to: "/app/admin/statistics",
    labelKey: "nav.statistics",
    icon: BarChart3,
    roles: ["Admin"],
  },
  // (Banco de preguntas movido arriba, junto a Cursos/Contenidos.)
  // Prompts (config de IA): override por curso para Docente, globales
  // para Admin. Misma posición visual para no descolocar al usuario
  // cuando cambia de rol.
  { to: "/app/teacher/ai-prompts", labelKey: "nav.aiPrompts", icon: Sparkles, roles: ["Docente"] },
  { to: "/app/admin/ai-prompts", labelKey: "nav.aiPrompts", icon: Sparkles, roles: ["Admin"] },
  // Cola — gestión de la cola async de calificación con IA + tareas
  // programadas. Misma posición visual para Admin y Docente para no
  // descolocar al usuario cuando cambia de rol. Va después de Prompts
  // porque es operacional (qué está corriendo) mientras Prompts es
  // configuración (qué prompt se usa). Ícono ListOrdered evoca "cola
  // de jobs ordenados" mejor que el Cpu original.
  { to: "/app/teacher/ai-cron", labelKey: "nav.aiCron", icon: ListOrdered, roles: ["Docente"] },
  { to: "/app/admin/ai-cron", labelKey: "nav.aiCron", icon: ListOrdered, roles: ["Admin"] },
  // Informes: módulo unificado entre roles. Admin gestiona las plantillas
  // globales; Docente genera informes desde esas plantillas (con
  // personalizaciones por curso y privadas). Lo que cambia es qué puede
  // hacer cada rol DENTRO; el nombre del módulo es el mismo para no
  // descolocar al usuario al cambiar de rol.
  {
    to: "/app/admin/report-templates",
    labelKey: "nav.reports",
    icon: ClipboardList,
    roles: ["Admin"],
  },
  {
    to: "/app/teacher/reports",
    labelKey: "nav.reports",
    icon: ClipboardList,
    roles: ["Docente"],
  },
  // Auditoría: Admin ve todo, Docente ve su alcance.
  {
    to: "/app/teacher/audit-logs",
    labelKey: "nav.auditLogs",
    icon: ShieldEllipsis,
    roles: ["Docente"],
  },
  {
    to: "/app/admin/audit-logs",
    labelKey: "nav.auditLogs",
    icon: ShieldEllipsis,
    roles: ["Admin"],
  },
  // Mensajería interna 1-a-1 vive ahora en MessagesBell (header, junto
  // al NotificationBell) en lugar de ser un item del sidebar. Mismo
  // patrón que campana de notificaciones: badge con conteo de no leídos
  // + popover con "Marcar todo leído" + link a /app/messages.
  // (Item viejo del nav removido.)
  // Docente: vista de sus estudiantes con opción "Ver como" (impersonación acotada).
  {
    to: "/app/teacher/students",
    labelKey: "nav.teacherStudents",
    icon: Users,
    roles: ["Docente"],
  },
  // Admin-only: gestión de usuarios al final (transversal a la app, no académico).
  { to: "/app/admin/users", labelKey: "nav.users", icon: Users, roles: ["Admin"] },
  // Errores: el módulo se unificó dentro de Auditoría como tab `?tab=errors`.
  // La ruta legacy `/app/admin/errors` redirige automáticamente, pero ya no
  // tiene item propio en el sidebar — todo lo de eventos del sistema vive
  // bajo el mismo enlace de Auditoría.
  // Papelera: items soft-deletados de cursos/exámenes/talleres/proyectos/
  // sesiones/pizarras/contenidos/encuestas. Visible para Docente y Admin
  // (no para alumno, que no tiene capacidad de borrar entidades).
  // SuperAdmin la ve heredada de Admin. RLS de cada tabla acota qué
  // items ven en la papelera (docente: su curso; admin: su tenant).
  { to: "/app/trash", labelKey: "nav.trash", icon: Trash2, roles: ["Docente", "Admin"] },
  // Asistente IA de plataforma — chat de ayuda de USO de ExamLab para TODOS
  // los roles (clon del Tutor IA del alumno, sin curso). El edge adapta la KB
  // + el prompt al rol activo. SuperAdmin lo hereda de Admin.
  {
    to: "/app/assistant",
    labelKey: "nav.supportAssistant",
    icon: Bot,
    roles: ["Estudiante", "Docente", "Admin"],
  },
  // Soporte (PQRS) — Admin abre tickets hacia el SuperAdmin; el SA los
  // gestiona en su propia ruta. Ambos items mapean al MISMO module_key
  // "support" para que el orden/visibility del panel "Módulos" actúe
  // sincronizado entre roles.
  {
    to: "/app/admin/support",
    labelKey: "nav.support",
    icon: LifeBuoy,
    roles: ["Admin"],
  },
  {
    to: "/app/superadmin/support",
    labelKey: "nav.support",
    icon: LifeBuoy,
    roles: ["SuperAdmin"],
  },
  // SuperAdmin: panel cross-tenant para gestionar instituciones. Se muestra
  // siempre que el usuario tenga el rol SuperAdmin, independiente del
  // activeRole (ver lógica especial en visibleNav filter más abajo).
  {
    to: "/app/superadmin/tenants",
    labelKey: "nav.tenants",
    icon: Building2,
    roles: ["SuperAdmin"],
  },
  {
    to: "/app/superadmin/system",
    labelKey: "nav.system",
    icon: Wrench,
    roles: ["SuperAdmin"],
  },
  // Diagnóstico de infraestructura (`/app/admin/system`) ya no vive en
  // el sidebar — está accesible como tab "Sistema" dentro de
  // Configuración para reducir el ruido de navegación.
  // Configuración global (correos, compilador, etc.). Admin-only.
  {
    to: "/app/admin/settings",
    labelKey: "nav.settings",
    icon: Settings,
    roles: ["Admin"],
  },
];

// Bottom-nav de MÓVIL: destinos más frecuentes por rol activo (los 5 que van
// "a un tap" en la barra inferior). Antes se usaba `visibleNav.slice(0,5)`, que
// tomaba los primeros 5 del array/orden → para el Docente surgía Calendario/Cola/
// Prompts/Banco antes que Exámenes/Talleres/Proyectos. Se prioriza por `to` (no
// por índice) para no depender del orden de NAV ni del orden configurable de
// módulos, y degrada con gracia: un path oculto por visibilidad de módulo se
// saltea y se rellena con el resto de `visibleNav` en su orden natural.
const BOTTOM_NAV_PRIORITY: Partial<Record<AppRole, string[]>> = {
  Estudiante: [
    "/app",
    "/app/student/exams",
    "/app/student/workshops",
    "/app/student/courses",
    "/app/student/grades",
  ],
  Docente: [
    "/app",
    "/app/teacher/exams",
    "/app/teacher/workshops",
    "/app/teacher/projects",
    "/app/teacher/attendance",
  ],
  Admin: [
    "/app",
    "/app/admin/users",
    "/app/admin/courses",
    "/app/admin/academic",
    "/app/admin/statistics",
  ],
  SuperAdmin: [
    "/app",
    "/app/superadmin/tenants",
    "/app/admin/users",
    "/app/admin/courses",
    "/app/superadmin/support",
  ],
};

const ROLE_CONFIG: Record<
  AppRole,
  {
    labelKey: string;
    icon: React.ComponentType<{ className?: string }>;
    accent: string; // sidebar pill (vivid in both light/dark)
    badgeClass: string; // light-mode badge in footer
  }
> = {
  Admin: {
    labelKey: "roles.Admin",
    icon: ShieldCheck,
    accent: "text-indigo-400 dark:text-indigo-300",
    badgeClass:
      "bg-indigo-500/15 text-indigo-700 border-indigo-500/25 dark:bg-indigo-400/15 dark:text-indigo-300 dark:border-indigo-400/25",
  },
  Docente: {
    labelKey: "roles.Docente",
    icon: UserCog,
    accent: "text-amber-400 dark:text-amber-300",
    badgeClass:
      "bg-amber-500/15 text-amber-700 border-amber-500/25 dark:bg-amber-400/15 dark:text-amber-300 dark:border-amber-400/25",
  },
  Estudiante: {
    labelKey: "roles.Estudiante",
    icon: GraduationCap,
    accent: "text-emerald-400 dark:text-emerald-300",
    badgeClass:
      "bg-emerald-500/15 text-emerald-700 border-emerald-500/25 dark:bg-emerald-400/15 dark:text-emerald-300 dark:border-emerald-400/25",
  },
  SuperAdmin: {
    labelKey: "roles.SuperAdmin",
    icon: ShieldEllipsis,
    accent: "text-rose-400 dark:text-rose-300",
    badgeClass:
      "bg-rose-500/15 text-rose-700 border-rose-500/25 dark:bg-rose-400/15 dark:text-rose-300 dark:border-rose-400/25",
  },
};

/**
 * Class única que se aplica a todos los íconos del sidebar nav. Resuelve
 * a `text-sidebar-foreground` (heredado del color de letra del sidebar,
 * sea derivado por luminancia o sobreescrito por `tenant.text_color`).
 *
 * Decisión 20260706: antes existía un mapa `NAV_ICON_COLOR` por ruta
 * (text-amber-300 para exámenes, text-rose-300 para proyectos, etc.).
 * Sobre el sidebar oscuro default funcionaba, pero con branding tenant
 * (sidebar rojo, naranja, verde) la paleta multicolor chocaba con el
 * primario. Estandarizado a un solo color hereditario.
 *
 * Si el tenant define `tenant.icon_color`, TenantThemeProvider setea
 * `--sidebar-icon-color` y los íconos lo toman vía inline style abajo.
 * Cuando la var no está, `currentColor` cae al `text-sidebar-foreground`
 * del nodo padre.
 */
const NAV_ICON_BASE_CLASS = "text-sidebar-foreground";

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, roles, signOut, loading, user, refreshRoles } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { theme, setTheme, resolvedTheme } = useTheme();
  // Aplica la preferencia de tema guardada en el perfil al entrar (sigue al
  // usuario entre dispositivos). El default de la app es claro; esto solo
  // reencuentra la elección de quien prefiere oscuro.
  useProfileThemeSync();
  const changeTheme = (next: "light" | "dark") => {
    setTheme(next);
    persistThemePreference(next);
  };
  const currentLang = (i18n.language.slice(0, 2) as SupportedLanguage) ?? "es";
  // Branding del tenant: logo + nombre. Si no hay (loading o sin
  // configurar), caemos al fallback GraduationCap + "Plataforma de exámenes".
  const { tenant } = useTenant();
  const tenantLogoUrl = resolveTenantLogoUrl(tenant, supabase);
  // Toast efímero en realtime cuando llega un mensaje y NO estoy ya
  // viendo /app/messages. La notificación persistente para el bell la
  // crea el trigger SQL `tg_notify_new_message`.
  useMessagingToasts(user?.id);

  const handleSignOut = async () => {
    const ok = await confirm({
      title: t("nav.signOut"),
      description: t("hc_sharedComponentsAppLayout.signOutConfirm"),
      confirmLabel: t("nav.signOut"),
      tone: "warning",
    });
    if (!ok) return;
    // Auditoría ANTES del signOut — después auth.uid() ya no existe y
    // el RPC `log_audit_event` no podría capturar el actor.
    await logEvent({
      action: "user.logged_out",
      category: "user",
      actorRole: activeRole ?? roles[0],
      entityType: "user",
      entityId: user?.id,
      entityName: profile?.full_name ?? user?.email ?? null,
      severity: "info",
    });
    signOut();
  };
  const [activeRole, setActiveRole] = useState<AppRole | null>(null);
  // Modo SuperAdmin "puro" — rol activo SuperAdmin sin "ver como X".
  // En este modo el SuperAdmin debe operar cross-tenant: no mostramos
  // branding de su tenant default (que es ruido — sugiere que está
  // viendo data de una institución), no mostramos cuotas, los paneles
  // de "mi institución" se gatean. Se recalcula cuando cambia el role
  // o cuando se setea/limpia el override (via custom event).
  const [hasTenantOverride, setHasTenantOverride] = useState<boolean>(
    () => readTenantOverride() !== null,
  );
  useEffect(() => {
    const refresh = () => setHasTenantOverride(readTenantOverride() !== null);
    window.addEventListener("examlab:tenant-override-changed", refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener("examlab:tenant-override-changed", refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  const isSuperAdminCrossTenant = activeRole === "SuperAdmin" && !hasTenantOverride;
  const [pwDialogOpen, setPwDialogOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Sidebar de desktop: colapsable con el botón hamburguesa o
  // automáticamente cuando el examen entra en pantalla completa,
  // para liberar el ancho de la pantalla durante la prueba.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const matchRoute = useMatchRoute();
  // useMatchRoute is the TanStack Router canonical way to detect an active route.
  // pathname.startsWith is unreliable in some Lovable/Vite build configurations.
  const isTakingExam = !!matchRoute({ to: "/app/student/take/$examId" });

  // Auto-colapso al entrar en pantalla completa (típicamente al
  // iniciar el examen). Si el alumno sale de fullscreen volvemos a
  // expandir solo si NO está en flujo de examen — TakeExam vive en
  // modo "concentrado" y queremos mantener el sidebar oculto incluso
  // si el browser cae de fullscreen por algún motivo.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const onFsChange = () => {
      if (document.fullscreenElement) {
        setSidebarCollapsed(true);
      } else if (!isTakingExam) {
        setSidebarCollapsed(false);
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, [isTakingExam]);

  // Auto-colapso cuando el alumno entra al flujo de examen, incluso
  // si fullscreen aún no se activó (el inicio del examen lo solicita
  // pero puede tardar unos ms).
  useEffect(() => {
    if (isTakingExam) setSidebarCollapsed(true);
  }, [isTakingExam]);

  // Auto-close the mobile drawer on navigation so the user isn't left
  // looking at an open menu after tapping a link.
  useEffect(() => {
    setMobileMenuOpen(false);
    // Recordar la última ruta interna para restaurarla al reabrir la app
    // (ver consumeBootLastRoute en app.index / auth). "Déjame donde estaba".
    saveLastRoute(location.pathname);
  }, [location.pathname]);

  // Toggle global del Banco de preguntas (app_settings.question_bank_enabled).
  // Si el Admin lo desactivó, ocultamos el item del nav y bloqueamos la ruta
  // (la ruta tira a /app cuando se intenta acceder).
  const [questionBankEnabled, setQuestionBankEnabled] = useState(true);
  // Matriz módulo × rol — el sidebar la usa abajo para filtrar items
  // hidden por el admin. El hook hace fetch + cache global, así que
  // múltiples instancias de AppLayout (en navegación SPA) reutilizan
  // el mismo mapa sin re-queries.
  const { map: moduleMap, order: moduleOrder } = useModuleVisibility();
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from("app_settings")
        .select("question_bank_enabled")
        .maybeSingle();
      if (cancelled) return;
      if (data && typeof data.question_bank_enabled === "boolean") {
        setQuestionBankEnabled(data.question_bank_enabled);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Web Push: una vez tenemos user, intentamos suscribir el browser.
  // Idempotente — si ya hay suscripción registrada, no hace nada. Si
  // falta permiso, la pide. Si VAPID no está configurado, sale sin
  // ruido. Esto es lo que habilita notificaciones cuando la PWA está
  // CERRADA en móvil; antes solo había realtime + postMessage que solo
  // funcionaba con la pestaña abierta.
  useEffect(() => {
    if (!user?.id) return;
    void ensurePushSubscription(user.id);
  }, [user?.id]);

  useEffect(() => {
    // Don't redirect mid-exam: TakeExam's submit/exit logic handles navigation.
    if (!loading && !user && !isTakingExam) {
      // Tampoco redirigir si estamos en pleno start/stop de impersonación
      // — la transición de session puede dejar a `user` momentáneamente
      // null antes que el hard reload tome efecto. Si redirigíamos
      // aquí, el reload aterrizaba en /auth y el caller tenía que
      // re-loguearse (loop observado tras `auth.verifyOtp`).
      if (sessionStorage.getItem(IMPERSONATION_TRANSITION_FLAG) === "1") return;
      // Recordar el deep-link protegido para volver tras el login (ej. el QR
      // de Kahoot → /app/student/polls?kahootPin=…, o el de asistencia). Sin
      // esto el login siempre cae a /app y se pierde el param del deep-link.
      captureReturnTo();
      navigate({ to: "/auth" });
    }
  }, [loading, user, navigate, isTakingExam]);

  // Una vez confirmamos que el user post-reload está estable (loading
  // false + user no null), limpiamos el flag de transición — su único
  // propósito era proteger la ventana entre `verifyOtp` y el hard
  // reload, y ya cumplió.
  useEffect(() => {
    if (!loading && user) {
      sessionStorage.removeItem(IMPERSONATION_TRANSITION_FLAG);
    }
  }, [loading, user]);

  useEffect(() => {
    if (roles.length && !activeRole) {
      // Prioridad del rol por DEFECTO al loguearse cuando el usuario tiene
      // varios roles. Docente gana a Admin a propósito: un usuario con ambos
      // (caso común: el docente que además administra su tenant) entra a
      // trabajar como Docente, no a la consola de administración. Un Admin
      // puro sigue entrando como Admin; un Estudiante puro como Estudiante.
      // SuperAdmin no se lista (un SA puro cae a roles[0]; mantiene su comportamiento).
      const order: AppRole[] = ["Docente", "Admin", "Estudiante"];
      setActiveRole(order.find((r) => roles.includes(r)) ?? roles[0]);
    }
  }, [roles, activeRole]);

  // Publica el rol activo en el signal compartido para que
  // TenantThemeProvider (en __root.tsx, fuera de este árbol de contexto)
  // pueda reaccionar al cambio. Cuando el usuario tiene SuperAdmin +
  // Admin y togglea, el provider limpia el branding (SuperAdmin) o lo
  // re-aplica (Admin) inmediatamente sin recargar la página.
  useEffect(() => {
    setActiveRoleSignal(activeRole);
  }, [activeRole]);

  /**
   * Handler unificado del Select de rol (desktop + mobile drawer).
   * En CUALQUIER cambio de rol limpiamos el `examlab_tenant_override` que pudo
   * quedar de un "Ver como X" anterior. El override es un concepto EXCLUSIVO del
   * modo SuperAdmin activo (solo se setea deliberadamente desde el botón "Ver
   * como" del panel SA); antes solo se limpiaba al ENTRAR a SuperAdmin, así que
   * al SALIR hacia Admin/Docente el override sobrevivía y `useTenant()` (que lo
   * gatea por rol POSEÍDO, no activo) seguía resolviendo al tenant X — branding y
   * contexto equivocados para un usuario multi-rol SuperAdmin+Admin.
   */
  const handleRoleChange = (v: string) => {
    setActiveRole(v as AppRole);
    setTenantOverride(null);
    navigate({ to: "/app" });
  };

  // ─── Onboarding tour ──────────────────────────────────────────────────
  // El hook decide si mostrar el tour para el activeRole actual. Si el
  // perfil ya tiene ese rol en `onboarding_completed_roles`, no muestra
  // nada. Si NO, dispara con 1s delay después de que carga la UI.
  //
  // `manualTrigger` lo activamos cuando el usuario clickea "Ver tour"
  // desde el menú de avatar — en ese caso ya no marcamos el rol como
  // completado al cerrar (ya lo estaba o lo quiere re-ver).
  const onboarding = useOnboarding();
  const [tourManualMode, setTourManualMode] = useState(false);
  const startManualTour = () => {
    const r = activeRole;
    if (r === "Admin" || r === "Docente" || r === "Estudiante") {
      setTourManualMode(true);
      onboarding.restart(r);
    }
  };

  // RBAC route guard: when the active role doesn't match the required roles
  // for the current path, redirect to /app/unauthorized (or /auth if no role).
  // RLS remains the authoritative guard at the API layer; this is UX.
  useEffect(() => {
    if (loading || !activeRole) return;
    const redirect = checkAccess(location.pathname, activeRole, roles);
    if (redirect && redirect !== location.pathname) {
      navigate({ to: homeForRole(activeRole) });
    }
  }, [loading, activeRole, roles, location.pathname, navigate]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }
  if (!user) return null;

  // ── Control de acceso por estado académico del estudiante ──
  // retirado/aplazado → pantalla bloqueante (no entra). graduado →
  // banner de solo-lectura (el RLS `student_can_write` bloquea sus
  // escrituras). Staff nunca se bloquea. Ver access-control.ts. El
  // enforcement real de escritura está en RLS (mig 20260711000000);
  // esto es la cara de UX.
  // Cuenta desactivada por un Admin/SuperAdmin (is_active=false). Gate
  // INDEPENDIENTE del rol (a diferencia de accessLevel, que exime al staff). El
  // bloqueo REAL del login es el ban GoTrue de admin-set-user-active; esto es la
  // cara de UX para una sesión viva residual (el access token expira solo).
  if (profile && profile.is_active === false) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <ShieldEllipsis className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="text-xl font-semibold">
            {t("appLayout.deactivatedTitle", { defaultValue: "Cuenta desactivada" })}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("appLayout.deactivatedBody", {
              defaultValue:
                "Tu cuenta fue desactivada. Contactá al administrador de tu institución para reactivarla.",
            })}
          </p>
          <Button variant="outline" onClick={signOut}>
            <LogOut className="h-4 w-4 mr-1.5" />
            {t("hc_sharedComponentsAppLayout.signOut")}
          </Button>
        </div>
      </div>
    );
  }

  const accessLevel = studentAccessLevel(profile?.estado, roles);
  if (accessLevel === "blocked") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="max-w-md text-center space-y-4">
          <div className="mx-auto h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center">
            <ShieldEllipsis className="h-6 w-6 text-destructive" />
          </div>
          <h1 className="text-xl font-semibold">
            {t("hc_sharedComponentsAppLayout.restrictedAccessTitle")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("hc_sharedComponentsAppLayout.restrictedAccessPrefix")}{" "}
            <strong>
              {profile?.estado === "aplazado"
                ? t("hc_sharedComponentsAppLayout.statusDeferred")
                : t("hc_sharedComponentsAppLayout.statusWithdrawn")}
            </strong>
            {t("hc_sharedComponentsAppLayout.restrictedAccessSuffix")}
          </p>
          <Button variant="outline" onClick={signOut}>
            <LogOut className="h-4 w-4 mr-1.5" />
            {t("hc_sharedComponentsAppLayout.signOut")}
          </Button>
        </div>
      </div>
    );
  }

  // Mapeo path → módulo. Cumple dos funciones:
  //   1. Filtro de visibilidad: el sidebar oculta items cuyo módulo
  //      esté apagado por rol (matriz `module_visibility`).
  //   2. Ordenamiento: el sidebar ordena por `display_order` del
  //      módulo asociado. Items NO mapeados van con 9999 (al final).
  //
  // IMPORTANTE: TODO item del NAV que represente un módulo gestionado
  // desde el panel "Visibilidad y orden" debe estar acá, incluyendo
  // las variantes admin/teacher/student. Si falta el mapping, el
  // item NO respeta el orden del panel.
  const NAV_PATH_TO_MODULE: Array<[string, ModuleKey]> = [
    // Dashboard — única ruta sin sufijo de rol. Se puede reordenar
    // desde el panel admin (algunos admins prefieren tenerlo al final).
    ["/app", "dashboard"],
    // Cursos — visible en los 3 roles, mismo módulo conceptual.
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
    // Prompts IA — variante admin y docente apuntan al mismo módulo.
    ["/app/teacher/ai-prompts", "ai_prompts"],
    ["/app/admin/ai-prompts", "ai_prompts"],
    // Cron IA — gestión de la cola de calificación con IA + (Admin) los
    // pg_cron de Supabase. Ambas variantes mapean al mismo módulo para
    // que el orden quede unificado entre roles.
    ["/app/teacher/ai-cron", "ai_cron"],
    ["/app/admin/ai-cron", "ai_cron"],
    // Estadísticas — variante docente (por curso) y admin (agregada)
    // mapean al mismo módulo. Estudiante no tiene ruta (no aplica).
    ["/app/teacher/statistics", "statistics"],
    ["/app/admin/statistics", "statistics"],
    ["/app/teacher/contents", "contents"],
    ["/app/videos", "videos"],
    ["/app/student/tutor", "tutor"],
    ["/app/teacher/students", "teacher_students"],
    // /app/admin/users → `users` (NO `teacher_students`). En el panel
    // "Módulos" la fila "Usuarios" es virtual: mapea Admin/SuperAdmin →
    // users y Docente → teacher_students vía roleKeyMap. El sidebar lee
    // este mapa para gatear la visibilidad del item Admin.
    ["/app/admin/users", "users"],
    ["/app/admin/report-templates", "reports"],
    ["/app/teacher/reports", "reports"],
    // Académico: solo Admin (estructura programas/asignaturas/periodos).
    ["/app/admin/academic", "academic"],
    // Encuestas: Docente y Estudiante mapean al mismo módulo.
    ["/app/teacher/polls", "polls"],
    ["/app/student/polls", "polls"],
    // Auditoría: variantes Admin y Docente.
    ["/app/teacher/audit-logs", "audit_logs"],
    ["/app/admin/audit-logs", "audit_logs"],
    // Pizarras (Excalidraw embebido) — Docente edita, Estudiante ve las
    // compartidas. Ambas rutas mapean al mismo `module_key`.
    ["/app/teacher/whiteboards", "whiteboards"],
    ["/app/student/whiteboards", "whiteboards"],
    // Papelera (mig 20260816000000 + seed 20260816000010): Docente / Admin
    // / SuperAdmin acceden al módulo; Estudiante no aplica (no borra
    // entidades soft-deletables). RLS de cada tabla acota qué ve cada uno.
    ["/app/trash", "trash"],
    // Sistema (SuperAdmin-only): panel de diagnóstico de infraestructura.
    // El panel "Módulos" tiene el toggle para reordenar/esconder.
    ["/app/superadmin/system", "system"],
    // Instituciones (SuperAdmin-only): panel cross-tenant. Sin este
    // mapping el ítem del sidebar ignoraba el toggle de orden/visibility
    // del panel "Módulos" — bug detectado en auditoría 2026-09.
    ["/app/superadmin/tenants", "tenants"],
    // Asistente IA de plataforma (Admin; SuperAdmin lo hereda). Mapea a
    // su propio module_key para respetar orden/visibility del panel.
    ["/app/assistant", "support_assistant"],
    // Soporte (Admin + SuperAdmin): el panel "Módulos" tiene UNA fila
    // "support" que decide visibility/orden para ambos lados a la vez.
    ["/app/admin/support", "support"],
    ["/app/superadmin/support", "support"],
    // Configuración (Admin / SuperAdmin): el toggle controla SOLO el
    // sidebar (orden + visibility). La ruta queda siempre accesible por
    // URL — escape hatch documentado en ModuleRouteGuard. Por eso este
    // mapping vive en NAV_PATH_TO_MODULE pero NO en PREFIX_TO_MODULE.
    ["/app/admin/settings", "configuration"],
  ];
  // Resuelve módulo para un path (helper local). Si no hay match,
  // null (no controlado por toggles, no participa en sort).
  const moduleForNav = (to: string): ModuleKey | null => {
    const found = NAV_PATH_TO_MODULE.find(([prefix]) => to === prefix);
    return found ? found[1] : null;
  };
  // Pre-computamos el set de moduleKeys para los cuales EXISTE un item
  // SA-only dedicado en el NAV. Caso: Soporte tiene 2 items distintos
  // (`/app/admin/support` con roles=["Admin"] y `/app/superadmin/support`
  // con roles=["SuperAdmin"]), pero ambos mapean al MISMO module_key
  // "support". Sin este dedup, el SA veía LOS DOS en el sidebar (el
  // suyo + el heredado de Admin). Política: cuando el SA tiene ítem
  // propio, gana el propio; el de Admin se oculta para evitar el
  // duplicado. Mismo principio aplicaría a futuros módulos con vista
  // distinta por rol.
  const moduleKeysWithDedicatedSuperAdminItem = new Set<ModuleKey>();
  for (const item of NAV) {
    if (item.roles.length === 1 && item.roles[0] === "SuperAdmin") {
      const modKey = moduleForNav(item.to);
      if (modKey) moduleKeysWithDedicatedSuperAdminItem.add(modKey);
    }
  }
  const visibleNav = NAV.filter((n) => {
    if (!activeRole) return false;
    // Items marcados como "SuperAdmin" se muestran SOLO cuando el usuario
    // está operando ACTIVAMENTE como SuperAdmin (no por simplemente
    // tener el rol). El panel de Instituciones es una herramienta
    // cross-tenant; cuando el usuario opera como Admin de su propia
    // institución, no queremos saturar el nav con ese ítem global.
    // Para editar SU PROPIA institución, el Admin lo hace desde
    // Configuración → Institución (panel inline, sin salir del rol).
    if (n.roles.length === 1 && n.roles[0] === "SuperAdmin") {
      return activeRole === "SuperAdmin";
    }
    // SuperAdmin = dueño de la plataforma. Ve los items Admin (gestión
    // de cursos, configuración, prompts, cola, informes, etc.) PLUS los
    // SuperAdmin-only. PERO con la mig 20260803 SuperAdmin ya tiene
    // columna propia en `module_visibility` → si toggleó algo OFF, lo
    // respetamos. Default ausente = visible (`isModuleEnabled` true).
    if (activeRole === "SuperAdmin" && n.roles.includes("Admin")) {
      const modKey = moduleForNav(n.to);
      // Dedup: si el SA tiene ítem propio para ese moduleKey (ej. Soporte),
      // ocultamos el de Admin para no mostrar dos veces el mismo módulo.
      if (modKey && moduleKeysWithDedicatedSuperAdminItem.has(modKey)) return false;
      if (modKey && !isModuleEnabled(moduleMap, modKey, "SuperAdmin")) return false;
      return true;
    }
    if (!n.roles.includes(activeRole)) return false;
    // Banco de preguntas legacy: el admin puede esconderlo globalmente.
    if (n.to === "/app/teacher/question-bank" && !questionBankEnabled) return false;
    // Admin bypassa los toggles de visibilidad (siempre ve todo en el
    // nav — el Admin es quien CONFIGURA la matriz, necesita acceso a
    // todos los módulos para gobernarlos).
    if (activeRole === "Admin") return true;
    // Filtro por module_visibility para Docente / Estudiante /
    // SuperAdmin actuando con su rol nativo.
    const modKey = moduleForNav(n.to);
    if (modKey) {
      if (!isModuleEnabled(moduleMap, modKey, activeRole as RoleKey)) return false;
    }
    return true;
  });
  // Aplicamos el orden configurado por el Admin desde el panel "Módulos".
  // Si dos items mapean al mismo módulo (raro), o el item no tiene
  // módulo asociado (ej. /app/admin/users), conservan su posición
  // relativa por orden de declaración en NAV (sort estable en JS).
  visibleNav.sort((a, b) => {
    const ma = moduleForNav(a.to);
    const mb = moduleForNav(b.to);
    const oa = ma ? getModuleOrder(moduleOrder, ma, activeRole as RoleKey) : 9999;
    const ob = mb ? getModuleOrder(moduleOrder, mb, activeRole as RoleKey) : 9999;
    return oa - ob;
  });

  // Bottom-nav de móvil: 5 destinos priorizados por rol (ver BOTTOM_NAV_PRIORITY).
  // Toma los del set de prioridad presentes en visibleNav (en ese orden) y rellena
  // con el resto de visibleNav si faltan slots. Fallback a los primeros 5 si el rol
  // no tiene set o aún no hidrató.
  const bottomNavItems: NavItem[] = (() => {
    const priority = activeRole ? BOTTOM_NAV_PRIORITY[activeRole] : undefined;
    if (!priority) return visibleNav.slice(0, 5);
    const byPath = new Map(visibleNav.map((n) => [n.to, n]));
    const picked: NavItem[] = [];
    const seen = new Set<string>();
    for (const to of priority) {
      const item = byPath.get(to);
      if (item && !seen.has(to)) {
        picked.push(item);
        seen.add(to);
      }
      if (picked.length === 5) break;
    }
    for (const n of visibleNav) {
      if (picked.length === 5) break;
      if (!seen.has(n.to)) {
        picked.push(n);
        seen.add(n.to);
      }
    }
    return picked;
  })();
  const activeCfg = activeRole ? ROLE_CONFIG[activeRole] : null;
  const ActiveIcon = activeCfg?.icon ?? GraduationCap;

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Sidebar (desktop). En mobile siempre va por <Sheet> abajo.
          Colapsable manual via hamburguesa o auto al entrar en
          fullscreen del examen. */}
      <aside
        className={cn(
          // position: fixed garantiza que el sidebar SIEMPRE quede
          // pegado al viewport sin importar la altura del contenido
          // ni el flex flow del padre. sticky/h-screen/self-start
          // se comportaban irregularmente cuando el dashboard era
          // alto y el footer (campana, contraseña, salir) caía
          // fuera del viewport.
          "flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border",
          sidebarCollapsed
            ? "hidden"
            : "hidden md:flex md:fixed md:top-0 md:left-0 md:bottom-0 md:w-64 md:z-30",
        )}
      >
        <div className="px-4 py-3 border-b border-sidebar-border" data-tour-id="brand">
          <div className="flex items-center gap-2">
            {/* Logo del tenant si está configurado, sino fallback al
                ícono de plataforma. El logo entra como <img> con
                object-contain para no deformar PNG/SVG con aspect ratio
                distinto del cuadrado. */}
            {/* SuperAdmin sin override: ocultamos el logo del tenant
                (sugería que el SuperAdmin está viendo "su institución"
                cuando en realidad debe operar cross-tenant). Mostramos
                el ícono de plataforma genérico. */}
            {tenantLogoUrl && !isSuperAdminCrossTenant ? (
              <div className="h-8 w-8 rounded-lg bg-white/5 flex items-center justify-center shadow-sm shrink-0 overflow-hidden">
                <img
                  src={tenantLogoUrl}
                  alt={tenant?.name ?? t("hc_sharedComponentsAppLayout.institutionLogoAlt")}
                  className="h-full w-full object-contain"
                />
              </div>
            ) : (
              <div
                className="h-8 w-8 rounded-lg bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center shadow-sm shrink-0"
                style={
                  tenant?.primary_color && !isSuperAdminCrossTenant
                    ? { background: tenant.primary_color }
                    : undefined
                }
              >
                <GraduationCap className="h-4 w-4 text-sidebar-primary-foreground" />
              </div>
            )}
            <div className="flex-1 min-w-0">
              <div className="font-semibold tracking-tight text-sm">ExamLab</div>
              <div className="text-[10px] text-sidebar-foreground/60 tracking-wide truncate">
                {/* En cross-tenant: indicamos modo SuperAdmin explícito,
                    no el nombre del tenant default del usuario. Al
                    elegir "Ver como X" desde /app/superadmin/tenants se
                    activa el override y vuelve a mostrar el nombre del
                    tenant elegido. */}
                {isSuperAdminCrossTenant
                  ? t("tenant.platformBrand")
                  : (tenant?.name ?? t("hc_sharedComponentsAppLayout.platformFallback"))}
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground h-7 w-7 shrink-0"
              onClick={() => setSidebarCollapsed(true)}
              title={t("hc_sharedComponentsAppLayout.hideMenu")}
              aria-label={t("hc_sharedComponentsAppLayout.hideMenu")}
            >
              <Menu className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Role selector */}
        {roles.length > 1 ? (
          <div className="px-3 py-3 border-b border-sidebar-border" data-tour-id="role-switcher">
            <Select value={activeRole ?? undefined} onValueChange={handleRoleChange}>
              <SelectTrigger className="w-full h-9 bg-sidebar-accent/60 border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent text-sm gap-2 [&>svg:last-child]:hidden">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <ActiveIcon
                    className={cn("h-4 w-4 shrink-0", NAV_ICON_BASE_CLASS)}
                    style={{ color: "var(--sidebar-icon-color, currentColor)" }}
                  />
                  <span className="truncate">{activeCfg ? t(activeCfg.labelKey) : ""}</span>
                </div>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
              </SelectTrigger>
              <SelectContent>
                {sortRolesByDisplay(roles).map((r) => {
                  // Defensive: si un rol nuevo se agrega en DB pero el
                  // cliente no se ha actualizado, ROLE_CONFIG[r] puede ser
                  // undefined. Sin guard la app entera crasheaba al
                  // expandir el sidebar (TypeError: undefined.icon).
                  const cfg = ROLE_CONFIG[r];
                  if (!cfg) return null;
                  const Icon = cfg.icon;
                  return (
                    <SelectItem key={r} value={r}>
                      <div className="flex items-center gap-2">
                        <Icon className="h-4 w-4" />
                        <span>{t(cfg.labelKey)}</span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        ) : (
          activeRole && (
            <div className="px-3 py-3 border-b border-sidebar-border" data-tour-id="role-switcher">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-sidebar-accent/60 text-sm">
                <ActiveIcon className={cn("h-4 w-4 shrink-0", activeCfg?.accent)} />
                <span>{activeCfg ? t(activeCfg.labelKey) : ""}</span>
              </div>
            </div>
          )
        )}

        <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-0.5">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const isActive =
              location.pathname === item.to ||
              (item.to !== "/app" && location.pathname.startsWith(item.to));
            const navClassName = cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors group",
              // Antes: inactive con text-sidebar-foreground/75 — sobre el
              // theme default OKLCH dark (sidebar oscuro) se veía bien,
              // pero con branding tenant donde el sidebar puede ser un
              // color medio (rojo, naranja) el 75% baja demasiado el
              // contraste y el texto se confunde con el fondo. Subimos a
              // /95 para que prácticamente sea blanco puro, manteniendo
              // un toque sutil de jerarquía vs el activo (que ya tiene
              // background propio + font-medium).
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "text-sidebar-foreground/95 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            );
            // Inline style con var fallback a `currentColor` (que es el
            // text-sidebar-foreground del padre). Cuando tenant.icon_color
            // está seteado, TenantThemeProvider asigna --sidebar-icon-color
            // y aquí el ícono lo toma sin tocar nada más.
            const iconStyle = { color: "var(--sidebar-icon-color, currentColor)" };
            // data-tour-module: ancla del onboarding tour matching por
            // module_key (estable) en lugar de por path. Si NAV_PATH_TO_MODULE
            // tiene el item, lo agregamos; si no, el tour cae al data-tour-nav.
            // Esto permite que el tour funcione aunque cambie el path
            // (ej. `/app/admin/ai-cron` → `/app/admin/cron`) o cambien las
            // labels visibles por i18n — el module_key es la identidad estable.
            const tourModule = moduleForNav(item.to) ?? undefined;
            if (isTakingExam) {
              return (
                <button
                  key={item.to}
                  type="button"
                  data-tour-nav={item.to}
                  data-tour-module={tourModule}
                  className={cn(navClassName, "w-full text-left")}
                  onClick={() => window.dispatchEvent(new CustomEvent("examlab:navAttempt"))}
                >
                  <Icon
                    className={cn("h-4 w-4 transition-colors", NAV_ICON_BASE_CLASS)}
                    style={iconStyle}
                  />
                  {t(item.labelKey)}
                </button>
              );
            }
            return (
              <Link
                key={item.to}
                to={item.to}
                data-tour-nav={item.to}
                data-tour-module={tourModule}
                className={navClassName}
              >
                <Icon
                  className={cn("h-4 w-4 transition-colors", NAV_ICON_BASE_CLASS)}
                  style={iconStyle}
                />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>

        <div className="p-2.5 border-t border-sidebar-border">
          <div className="px-2 pt-1 pb-1.5" data-tour-id="user-info">
            <div className="text-xs font-medium truncate">{profile?.full_name ?? user.email}</div>
            <div className="text-[10px] text-sidebar-foreground/60 truncate">
              {profile?.institutional_email}
            </div>
          </div>
          {!isTakingExam && (
            // Bar inferior compacta: solo "cerrar sesión" inline. El resto
            // de opciones (perfil, contraseña, tema, idioma) viven en un
            // DropdownMenu del design system. La campana queda visible
            // aparte porque el badge de no leídas es awareness crítica.
            <div className="flex items-center justify-between gap-1">
              <div className="flex items-center gap-0.5">
                <div data-tour-id="notifications-bell">
                  <NotificationBell
                    userId={user.id}
                    variant="sidebar"
                    viewerRole={activeRole ?? roles[0]}
                  />
                </div>
                <div data-tour-id="messages-bell">
                  <MessagesBell />
                </div>
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t("nav.options")}
                    data-tour-id="more-options"
                    className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="start" className="w-56">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    {profile?.full_name ?? user.email}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setProfileDialogOpen(true)} className="gap-2">
                    <UserCog className="h-4 w-4" />
                    {t("nav.editProfile")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setPwDialogOpen(true)} className="gap-2">
                    <KeyRound className="h-4 w-4" />
                    {t("nav.changePassword")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => navigate({ to: "/app/preferences" })}
                    className="gap-2"
                  >
                    <Bell className="h-4 w-4" />
                    {t("nav.notificationPreferences")}
                  </DropdownMenuItem>
                  {/* Ver tour: solo disponible para roles con tour
                      configurado (Admin/Docente/Estudiante). SuperAdmin
                      no tiene tour, así que el item no se renderiza
                      cuando ese es el rol activo. */}
                  {(activeRole === "Admin" ||
                    activeRole === "Docente" ||
                    activeRole === "Estudiante") && (
                    <DropdownMenuItem onClick={startManualTour} className="gap-2">
                      <HelpCircle className="h-4 w-4" />
                      {t("hc_sharedComponentsAppLayout.viewGuidedTour")}
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2">
                      {resolvedTheme === "dark" ? (
                        <Moon className="h-4 w-4" />
                      ) : (
                        <Sun className="h-4 w-4" />
                      )}
                      {t("nav.theme")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      <DropdownMenuItem onClick={() => changeTheme("light")} className="gap-2">
                        <Sun className="h-4 w-4" /> {t("nav.themeLight")}
                        {theme === "light" && (
                          <span className="ml-auto text-xs text-primary">✓</span>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => changeTheme("dark")} className="gap-2">
                        <Moon className="h-4 w-4" /> {t("nav.themeDark")}
                        {theme === "dark" && (
                          <span className="ml-auto text-xs text-primary">✓</span>
                        )}
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger className="gap-2">
                      <Languages className="h-4 w-4" />
                      {t("nav.language")}
                      <span className="ml-auto text-[10px] uppercase text-muted-foreground">
                        {currentLang}
                      </span>
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {SUPPORTED_LANGUAGES.map((lng) => (
                        <DropdownMenuItem
                          key={lng}
                          onClick={() => void i18n.changeLanguage(lng)}
                          className="gap-2"
                        >
                          {lng === "es" ? "Español" : "English"}
                          {currentLang === lng && (
                            <span className="ml-auto text-xs text-primary">✓</span>
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                  <DropdownMenuSeparator />
                  {/* Política de privacidad: visible en TODOS los roles (este
                      menú se renderiza para cualquier usuario autenticado). */}
                  <DropdownMenuItem
                    onClick={() => navigate({ to: "/app/privacy" })}
                    className="gap-2"
                  >
                    <ShieldCheck className="h-4 w-4" />
                    {t("nav.privacy")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  // Belt-and-suspenders: even if the button renders during exam, intercept it.
                  if (isTakingExam) {
                    window.dispatchEvent(new CustomEvent("examlab:navAttempt"));
                  } else {
                    void handleSignOut();
                  }
                }}
                data-tour-id="logout"
                className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                title={t("nav.signOut")}
              >
                <LogOut className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </aside>

      <ChangePasswordDialog open={pwDialogOpen} onOpenChange={setPwDialogOpen} />
      <EditProfileDialog open={profileDialogOpen} onOpenChange={setProfileDialogOpen} />

      {/* Tour guiado de bienvenida. Solo se monta cuando el hook indica
          mostrarlo (primer login del rol activo, o al clickear "Ver
          tour" del menú avatar). Al completar/cerrar se desmonta. */}
      {(onboarding.shouldShowFor || tourManualMode) && (
        <Suspense fallback={null}>
          <OnboardingTour
            role={onboarding.shouldShowFor}
            manualMode={tourManualMode}
            onComplete={(r) => {
              void onboarding.complete(r);
              setTourManualMode(false);
            }}
            onDismiss={() => {
              onboarding.dismiss();
              setTourManualMode(false);
            }}
          />
        </Suspense>
      )}
      {/* Cambio de contraseña forzado en el primer login: diálogo
          bloqueante mientras `profile.must_change_password` sea true.
          Al guardar baja el flag y `refreshRoles` re-carga el perfil →
          el diálogo se desmonta. */}
      {user && profile?.must_change_password && (
        <ForceChangePasswordDialog userId={user.id} onChanged={refreshRoles} onSignOut={signOut} />
      )}

      {/* ──────────────────────────────────────────────────────────
         MOBILE TOP BAR — hamburger + brand + notifications
         Simplified from the previous crowded bar: only essentials
         stay visible; the rest lives inside the drawer.
         ────────────────────────────────────────────────────────── */}
      <header
        className="md:hidden fixed top-0 inset-x-0 z-30 bg-sidebar text-sidebar-foreground border-b border-sidebar-border flex items-center justify-between px-3 h-14"
        style={{ paddingTop: "env(safe-area-inset-top)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-sidebar-foreground hover:bg-sidebar-accent"
                aria-label={t("hc_sharedComponentsAppLayout.menu")}
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[85vw] max-w-sm p-0 bg-sidebar text-sidebar-foreground border-sidebar-border flex flex-col"
            >
              <SheetHeader className="px-5 py-5 border-b border-sidebar-border text-left">
                <div className="flex items-center gap-2">
                  {/* Mismo gate que el sidebar desktop: SuperAdmin
                      cross-tenant NO ve logo ni nombre del tenant
                      default (línea ~717). Mobile drawer espeja el
                      comportamiento. */}
                  {tenantLogoUrl && !isSuperAdminCrossTenant ? (
                    <div className="h-9 w-9 rounded-lg bg-white/5 flex items-center justify-center shadow-sm overflow-hidden">
                      <img
                        src={tenantLogoUrl}
                        alt={tenant?.name ?? t("hc_sharedComponentsAppLayout.institutionLogoAlt")}
                        className="h-full w-full object-contain"
                      />
                    </div>
                  ) : (
                    <div
                      className="h-9 w-9 rounded-lg bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center shadow-sm"
                      style={
                        tenant?.primary_color && !isSuperAdminCrossTenant
                          ? { background: tenant.primary_color }
                          : undefined
                      }
                    >
                      <GraduationCap className="h-5 w-5 text-sidebar-primary-foreground" />
                    </div>
                  )}
                  <div>
                    <SheetTitle className="text-sidebar-foreground tracking-tight text-base">
                      ExamLab
                    </SheetTitle>
                    <div className="text-[10px] text-sidebar-foreground/60 tracking-wide">
                      {isSuperAdminCrossTenant
                        ? t("tenant.platformBrand")
                        : (tenant?.name ?? t("auth.brandSubtitle"))}
                    </div>
                  </div>
                </div>
              </SheetHeader>

              {/* Role selector inside drawer */}
              {roles.length > 1 ? (
                <div className="px-3 py-3 border-b border-sidebar-border">
                  <Select value={activeRole ?? undefined} onValueChange={handleRoleChange}>
                    <SelectTrigger className="w-full bg-sidebar-accent/60 border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent gap-2 [&>svg:last-child]:hidden">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <ActiveIcon
                          className={cn("h-4 w-4 shrink-0", NAV_ICON_BASE_CLASS)}
                          style={{ color: "var(--sidebar-icon-color, currentColor)" }}
                        />
                        <span className="truncate">{activeCfg ? t(activeCfg.labelKey) : ""}</span>
                      </div>
                      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                    </SelectTrigger>
                    <SelectContent>
                      {sortRolesByDisplay(roles).map((r) => {
                        // Defensive: ver comentario en el otro role-switcher.
                        const cfg = ROLE_CONFIG[r];
                        if (!cfg) return null;
                        const Icon = cfg.icon;
                        return (
                          <SelectItem key={r} value={r}>
                            <div className="flex items-center gap-2">
                              <Icon className="h-4 w-4" />
                              <span>{t(cfg.labelKey)}</span>
                            </div>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                activeRole && (
                  <div className="px-3 py-3 border-b border-sidebar-border">
                    <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-sidebar-accent/60 text-sm">
                      <ActiveIcon
                        className={cn("h-4 w-4 shrink-0", NAV_ICON_BASE_CLASS)}
                        style={{ color: "var(--sidebar-icon-color, currentColor)" }}
                      />
                      <span>{activeCfg ? t(activeCfg.labelKey) : ""}</span>
                    </div>
                  </div>
                )
              )}

              {/* Full nav inside drawer — taller tap targets than desktop */}
              <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5">
                {visibleNav.map((item) => {
                  const Icon = item.icon;
                  const isActive =
                    location.pathname === item.to ||
                    (item.to !== "/app" && location.pathname.startsWith(item.to));
                  const navClassName = cn(
                    "flex items-center gap-3 px-3 py-3 rounded-md text-sm transition-colors touch-manipulation",
                    // Mismo motivo que la versión desktop (línea ~795):
                    // /80 sobre branding tenant queda con poco contraste.
                    // /95 mantiene la jerarquía sin perder legibilidad.
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/95 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                  );
                  const iconStyle = { color: "var(--sidebar-icon-color, currentColor)" };
                  if (isTakingExam) {
                    return (
                      <button
                        key={item.to}
                        type="button"
                        className={cn(navClassName, "w-full text-left")}
                        onClick={() => window.dispatchEvent(new CustomEvent("examlab:navAttempt"))}
                      >
                        <Icon
                          className={cn("h-5 w-5 transition-colors", NAV_ICON_BASE_CLASS)}
                          style={iconStyle}
                        />
                        {t(item.labelKey)}
                      </button>
                    );
                  }
                  return (
                    <Link key={item.to} to={item.to} className={navClassName}>
                      <Icon
                        className={cn("h-5 w-5 transition-colors", NAV_ICON_BASE_CLASS)}
                        style={iconStyle}
                      />
                      {t(item.labelKey)}
                    </Link>
                  );
                })}
              </nav>

              <div
                className="p-3 border-t border-sidebar-border"
                style={{ paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
              >
                <div className="px-2 py-2 mb-1.5">
                  <div className="text-sm font-medium truncate">
                    {profile?.full_name ?? user.email}
                  </div>
                  <div className="text-xs text-sidebar-foreground/60 truncate">
                    {profile?.institutional_email}
                  </div>
                </div>
                {!isTakingExam && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <ThemeToggle />
                    <LanguageSwitcher className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground" />
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setProfileDialogOpen(true);
                        setMobileMenuOpen(false);
                      }}
                      className="text-sidebar-foreground/80 hover:bg-sidebar-accent"
                      title={t("nav.editProfile")}
                    >
                      <UserCog className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setPwDialogOpen(true)}
                      className="text-sidebar-foreground/80 hover:bg-sidebar-accent"
                      title={t("nav.changePassword")}
                    >
                      <KeyRound className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (isTakingExam) {
                          window.dispatchEvent(new CustomEvent("examlab:navAttempt"));
                        } else {
                          void handleSignOut();
                        }
                      }}
                      className="text-sidebar-foreground/80 hover:bg-sidebar-accent ml-auto"
                    >
                      <LogOut className="h-4 w-4 mr-1" />
                      {t("nav.signOut")}
                    </Button>
                  </div>
                )}
              </div>
            </SheetContent>
          </Sheet>

          <div className="flex items-center gap-2 min-w-0">
            {/* Mobile top header (sidebar colapsado): mismo gate que
                el sidebar desktop expandido y el mobile drawer. Sin
                esto el SuperAdmin sin override veía el logo del
                tenant default acá aunque sí estuviera oculto en los
                otros sidebars — fix consistente. */}
            {tenantLogoUrl && !isSuperAdminCrossTenant ? (
              <div className="h-7 w-7 rounded-md bg-white/5 flex items-center justify-center shrink-0 overflow-hidden">
                <img
                  src={tenantLogoUrl}
                  alt={tenant?.name ?? t("hc_sharedComponentsAppLayout.logoAlt")}
                  className="h-full w-full object-contain"
                />
              </div>
            ) : (
              <div
                className="h-7 w-7 rounded-md bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center shrink-0"
                style={
                  tenant?.primary_color && !isSuperAdminCrossTenant
                    ? { background: tenant.primary_color }
                    : undefined
                }
              >
                <GraduationCap className="h-4 w-4 text-sidebar-primary-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <div className="font-semibold truncate leading-tight">ExamLab</div>
              {isSuperAdminCrossTenant ? (
                <div className="text-[10px] text-sidebar-foreground/60 truncate leading-tight">
                  {t("tenant.platformBrand")}
                </div>
              ) : (
                tenant?.name && (
                  <div className="text-[10px] text-sidebar-foreground/60 truncate leading-tight">
                    {tenant.name}
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        {!isTakingExam && (
          <div className="flex items-center gap-0.5">
            <NotificationBell userId={user.id} viewerRole={activeRole ?? roles[0]} />
            <MessagesBell />
          </div>
        )}
      </header>

      {/* Botón flotante para volver a mostrar el sidebar cuando está
          colapsado (desktop). En examen lo escondemos para no romper
          la concentración del modo prueba. */}
      {sidebarCollapsed && !isTakingExam && (
        <Button
          variant="outline"
          size="icon"
          onClick={() => setSidebarCollapsed(false)}
          className="hidden md:flex fixed top-3 left-3 z-40 h-9 w-9 bg-card shadow-sm"
          title={t("hc_sharedComponentsAppLayout.showMenu")}
          aria-label={t("hc_sharedComponentsAppLayout.showMenu")}
        >
          <Menu className="h-4 w-4" />
        </Button>
      )}

      <main
        className={cn(
          "flex-1 min-w-0 pt-14 md:pt-0",
          // Compensar el sidebar fijo en desktop. Con sidebar abierto:
          // 256px = ancho del sidebar. Con sidebar colapsado: 56px de
          // gutter para que el botón "Mostrar menú" (fixed top-3 left-3,
          // 36px) no se monte sobre el contenido y para dejar respiro
          // visual. Sin este gutter, el primer pixel de contenido queda
          // pegado al edge izquierdo y la app se siente apretada.
          sidebarCollapsed ? "md:ml-14" : "md:ml-64",
        )}
      >
        {/* Banner de impersonación: se renderiza arriba de TODO el main
            cuando el admin está viendo la plataforma como otro usuario.
            Sticky top para que sea siempre visible mientras se navega
            por el contenido. Vive dentro del <main> (no a nivel root)
            para no chocar con el sidebar fixed del desktop. */}
        <ImpersonationBanner />
        {/* Banner de override de tenant: solo SuperAdmin con activeRole
            SuperAdmin y un "Ver como X" activo. Le recuerda que los
            datos están filtrados a ese tenant y le da el botón "Salir
            del modo institución" para volver al estado cross-tenant. */}
        <TenantOverrideBanner />
        {/* Notificación global de Kahoot en vivo: para el alumno, persistente
            arriba en cualquier pantalla, con entrada de 1 click ("login
            directo"). Se auto-oculta dentro de la vista del juego. No durante
            un examen. El propio componente decide si hay algo que mostrar. */}
        {activeRole === "Estudiante" && !isTakingExam && <KahootLiveBanner />}
        {/* Banner de solo-lectura para estudiantes graduados: pueden ver
            (certificados, notas) pero no crear entregas. No se muestra
            durante un examen. El bloqueo de escritura real lo impone RLS. */}
        {accessLevel === "readonly" && !isTakingExam && (
          <div className="bg-amber-500/10 border-b border-amber-400/40 px-4 py-2 text-xs text-amber-700 dark:text-amber-300 flex items-center gap-2">
            <ShieldEllipsis className="h-3.5 w-3.5 shrink-0" />
            <span>
              {t("hc_sharedComponentsAppLayout.readonlyBannerPrefix")}{" "}
              <strong>{t("hc_sharedComponentsAppLayout.statusGraduated")}</strong>
              {t("hc_sharedComponentsAppLayout.readonlyBannerSuffix")}
            </span>
          </div>
        )}
        {/* Page container — full-bleed: ocupa TODO el ancho disponible
            (viewport menos el sidebar fixed), con gutters de 16px mobile
            / 32px desktop. Bottom padding reserva espacio para el
            bottom-nav fixed mobile. Durante el examen el bottom-nav no
            se renderiza (`!isTakingExam`), así que bajamos el padding
            para no dejar 96px de aire vacío debajo del contenido.

            Historial: tuvo `mx-auto max-w-7xl` (centrado, dejaba gap a
            ambos lados), luego `mr-auto max-w-7xl` (izquierda, gap solo
            a la derecha). En monitores anchos (1920px+) ese cap de
            1280px dejaba ~400px muertos a la derecha. Ahora SIN cap: los
            grids/tablas/cards se estiran a todo el ancho manteniendo sus
            proporciones internas (cada pantalla ya controla su layout
            con grids responsive + columnas progresivas). */}
        <div
          className={cn(
            "px-4 md:px-8 py-5 md:py-8",
            isTakingExam ? "pb-5 md:pb-8" : "pb-24 md:pb-8",
          )}
        >
          <ActiveRoleContext.Provider value={activeRole}>{children}</ActiveRoleContext.Provider>
        </div>

        {/* ──────────────────────────────────────────────────────────
           MOBILE BOTTOM NAV — thumb-reachable, up to 5 role-aware items
           Keeps the most frequent destinations one tap away without
           reopening the drawer.

           Se oculta durante el examen (`isTakingExam`) por la misma
           razón que el sidebar: cualquier tap en uno de los items
           dispararía un strike de proctoring + sale de fullscreen.
           ────────────────────────────────────────────────────────── */}
        {!isTakingExam && (
          <nav
            className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-card border-t border-border flex items-stretch justify-around"
            style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
            aria-label={t("hc_sharedComponentsAppLayout.mainNavigation")}
          >
            {bottomNavItems.map((item) => {
              const Icon = item.icon;
              const isActive =
                location.pathname === item.to ||
                (item.to !== "/app" && location.pathname.startsWith(item.to));
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex-1 flex flex-col items-center justify-center gap-0.5 py-2 min-h-[56px] text-[10px] font-medium touch-manipulation transition-colors",
                    isActive
                      ? "text-primary"
                      : "text-muted-foreground hover:text-foreground active:bg-muted/50",
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="truncate max-w-[4.5rem]">{t(item.labelKey)}</span>
                </Link>
              );
            })}
          </nav>
        )}
      </main>

      {/* FAB de mensajes — visible cuando el sidebar NO está visible
          (mobile o sidebar de desktop colapsado). En mobile va por
          encima del bottom-nav nativo (`bottom-20`); en desktop pega
          a la esquina inferior (`md:bottom-4`). El bell del header
          sigue cumpliendo el rol en desktop con sidebar expandido. */}
      <MessagesFab sidebarCollapsed={sidebarCollapsed} />
    </div>
  );
}

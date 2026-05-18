import { Link, useLocation, useNavigate, useMatchRoute } from "@tanstack/react-router";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
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
import { useMessagingToasts } from "@/hooks/use-messaging-toasts";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "@/i18n";
// ThemeToggle + LanguageSwitcher se siguen usando en el drawer mobile
// (Sheet más abajo), donde sí hay espacio para botones inline. En el
// sidebar de escritorio los reemplazamos por entradas del DropdownMenu.
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NotificationBell } from "@/components/NotificationBell";
import { MessagesFab } from "@/components/MessagesFab";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { EditProfileDialog } from "@/components/EditProfileDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { checkAccess, homeForRole } from "@/lib/rbac";
import { logEvent } from "@/lib/audit";
import { ensurePushSubscription } from "@/lib/push-subscription";
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
  BookOpenCheck,
  Hammer,
  ChevronsUpDown,
  KeyRound,
  Menu,
  FolderKanban,
  CalendarCheck,
  CalendarDays,
  Sparkles,
  BarChart3,
  ScrollText,
  ShieldEllipsis,
  Presentation,
  MoreHorizontal,
  Sun,
  Moon,
  Monitor,
  Languages,
  Wrench,
  MessageSquare,
  Settings,
  Bell,
  Library,
  Award,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface NavItem {
  to: string;
  labelKey: string;
  icon: React.ComponentType<{ className?: string }>;
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
  // usa ANTES de armar exámenes/talleres/proyectos. Solo Docente —
  // Admin configura marca + prompt desde el módulo Prompts.
  {
    to: "/app/teacher/contents",
    labelKey: "nav.contents",
    icon: Presentation,
    roles: ["Docente"],
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
    roles: ["Docente"],
  },
  // Exámenes
  { to: "/app/teacher/exams", labelKey: "nav.exams", icon: FileText, roles: ["Docente"] },
  {
    to: "/app/student/exams",
    labelKey: "nav.studentExams",
    icon: FileText,
    roles: ["Estudiante"],
  },
  // Talleres
  { to: "/app/teacher/workshops", labelKey: "nav.workshops", icon: Hammer, roles: ["Docente"] },
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
    roles: ["Docente"],
  },
  {
    to: "/app/student/projects",
    labelKey: "nav.studentProjects",
    icon: FolderKanban,
    roles: ["Estudiante"],
  },
  // Calificaciones
  { to: "/app/teacher/gradebook", labelKey: "nav.grades", icon: ClipboardList, roles: ["Docente"] },
  {
    to: "/app/student/grades",
    labelKey: "nav.studentGrades",
    icon: ClipboardList,
    roles: ["Estudiante"],
  },
  // Certificados — solo estudiante. Visibles aunque aún no haya emitidos
  // (la lista vacía explica).
  {
    to: "/app/student/certificates",
    labelKey: "nav.studentCertificates",
    icon: Award,
    roles: ["Estudiante"],
  },
  // Asistencia
  {
    to: "/app/teacher/attendance",
    labelKey: "nav.attendance",
    icon: CalendarCheck,
    roles: ["Docente"],
  },
  {
    to: "/app/student/attendance",
    labelKey: "nav.studentAttendance",
    icon: CalendarCheck,
    roles: ["Estudiante"],
  },
  {
    to: "/app/teacher/calendar",
    labelKey: "nav.calendar",
    icon: CalendarDays,
    roles: ["Docente"],
  },
  // Calendario integral del estudiante (lista unificada + sync .ics)
  {
    to: "/app/student/calendar",
    labelKey: "nav.studentCalendar",
    icon: CalendarDays,
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
  // Mensajería interna 1-a-1. Visible para los tres roles — la regla
  // de "con quién puedo hablar" la enforza la RLS de conversations
  // (compañeros de curso + Admins).
  {
    to: "/app/messages",
    labelKey: "nav.messages",
    icon: MessageSquare,
    roles: ["Admin", "Docente", "Estudiante"],
  },
  // Admin-only: gestión de usuarios al final (transversal a la app, no académico).
  { to: "/app/admin/users", labelKey: "nav.users", icon: Users, roles: ["Admin"] },
  // Admin-only: utilidades de diagnóstico de la infraestructura
  // (edge functions health-check, etc.). Va al final porque rara vez
  // se usa — solo cuando hay sospecha de algo roto en Supabase.
  { to: "/app/admin/system", labelKey: "nav.system", icon: Wrench, roles: ["Admin"] },
  // Configuración global (correos, compilador, etc.). Admin-only.
  {
    to: "/app/admin/settings",
    labelKey: "nav.settings",
    icon: Settings,
    roles: ["Admin"],
  },
];

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
};

// Vivid icon colors per nav route key (path prefix → tailwind color class).
// Works in both light and dark mode against the dark sidebar.
const NAV_ICON_COLOR: Record<string, string> = {
  "/app": "text-sky-300",
  "/app/admin/users": "text-indigo-300",
  "/app/admin/ai-prompts": "text-violet-300",
  "/app/teacher/ai-prompts": "text-violet-300",
  "/app/teacher/contents": "text-pink-300",
  "/app/admin/courses": "text-fuchsia-300",
  "/app/teacher/courses": "text-fuchsia-300",
  "/app/teacher/exams": "text-amber-300",
  "/app/teacher/gradebook": "text-emerald-300",
  "/app/teacher/workshops": "text-orange-300",
  "/app/teacher/projects": "text-rose-300",
  "/app/teacher/attendance": "text-cyan-300",
  "/app/teacher/statistics": "text-blue-300",
  "/app/admin/statistics": "text-blue-300",
  "/app/teacher/audit-logs": "text-teal-300",
  "/app/admin/audit-logs": "text-teal-300",
  "/app/admin/system": "text-cyan-300",
  "/app/student/exams": "text-amber-300",
  "/app/student/workshops": "text-orange-300",
  "/app/student/projects": "text-rose-300",
  "/app/student/courses": "text-fuchsia-300",
  "/app/student/grades": "text-emerald-300",
  "/app/student/certificates": "text-amber-400",
  "/app/student/calendar": "text-blue-300",
  "/app/messages": "text-cyan-300",
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, roles, signOut, loading, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const { theme, setTheme, resolvedTheme } = useTheme();
  const currentLang = (i18n.language.slice(0, 2) as SupportedLanguage) ?? "es";
  // Toast efímero en realtime cuando llega un mensaje y NO estoy ya
  // viendo /app/messages. La notificación persistente para el bell la
  // crea el trigger SQL `tg_notify_new_message`.
  useMessagingToasts(user?.id);

  const handleSignOut = async () => {
    const ok = await confirm({
      title: t("nav.signOut"),
      description: "¿Estás seguro de que quieres cerrar sesión?",
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
  }, [location.pathname]);

  // Toggle global del Banco de preguntas (app_settings.question_bank_enabled).
  // Si el Admin lo desactivó, ocultamos el item del nav y bloqueamos la ruta
  // (la ruta tira a /app cuando se intenta acceder).
  const [questionBankEnabled, setQuestionBankEnabled] = useState(true);
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
    if (!loading && !user && !isTakingExam) navigate({ to: "/auth" });
  }, [loading, user, navigate, isTakingExam]);

  useEffect(() => {
    if (roles.length && !activeRole) {
      const order: AppRole[] = ["Admin", "Docente", "Estudiante"];
      setActiveRole(order.find((r) => roles.includes(r)) ?? roles[0]);
    }
  }, [roles, activeRole]);

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

  const visibleNav = NAV.filter((n) => {
    if (!activeRole || !n.roles.includes(activeRole)) return false;
    // Banco de preguntas: el admin puede esconderlo globalmente.
    if (n.to === "/app/teacher/question-bank" && !questionBankEnabled) return false;
    return true;
  });
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
        <div className="px-4 py-3 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center shadow-sm shrink-0">
              <GraduationCap className="h-4 w-4 text-sidebar-primary-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="font-semibold tracking-tight text-sm">ExamLab</div>
              <div className="text-[10px] text-sidebar-foreground/50 tracking-wide truncate">
                Plataforma de exámenes
              </div>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground h-7 w-7 shrink-0"
              onClick={() => setSidebarCollapsed(true)}
              title="Ocultar menú"
              aria-label="Ocultar menú"
            >
              <Menu className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Role selector */}
        {roles.length > 1 ? (
          <div className="px-3 py-3 border-b border-sidebar-border">
            <Select
              value={activeRole ?? undefined}
              onValueChange={(v) => {
                setActiveRole(v as AppRole);
                navigate({ to: "/app" });
              }}
            >
              <SelectTrigger className="w-full h-9 bg-sidebar-accent/60 border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent text-sm gap-2 [&>svg:last-child]:hidden">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <ActiveIcon className={cn("h-4 w-4 shrink-0", activeCfg?.accent)} />
                  <span className="truncate">{activeCfg ? t(activeCfg.labelKey) : ""}</span>
                </div>
                <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => {
                  const cfg = ROLE_CONFIG[r];
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
            const iconColor = NAV_ICON_COLOR[item.to] ?? "text-sky-300";
            const navClassName = cn(
              "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors group",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
            );
            if (isTakingExam) {
              return (
                <button
                  key={item.to}
                  type="button"
                  className={cn(navClassName, "w-full text-left")}
                  onClick={() => window.dispatchEvent(new CustomEvent("examlab:navAttempt"))}
                >
                  <Icon className={cn("h-4 w-4 transition-colors", iconColor)} />
                  {t(item.labelKey)}
                </button>
              );
            }
            return (
              <Link key={item.to} to={item.to} className={navClassName}>
                <Icon className={cn("h-4 w-4 transition-colors", iconColor)} />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>

        <div className="p-2.5 border-t border-sidebar-border">
          <div className="px-2 pt-1 pb-1.5">
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
              <NotificationBell
                userId={user.id}
                variant="sidebar"
                viewerRole={activeRole ?? roles[0]}
              />

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t("nav.options")}
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
                      <DropdownMenuItem onClick={() => setTheme("light")} className="gap-2">
                        <Sun className="h-4 w-4" /> {t("nav.themeLight")}
                        {theme === "light" && (
                          <span className="ml-auto text-xs text-primary">✓</span>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme("dark")} className="gap-2">
                        <Moon className="h-4 w-4" /> {t("nav.themeDark")}
                        {theme === "dark" && (
                          <span className="ml-auto text-xs text-primary">✓</span>
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setTheme("system")} className="gap-2">
                        <Monitor className="h-4 w-4" /> {t("nav.themeSystem")}
                        {theme === "system" && (
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
                aria-label="Menú"
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
                  <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center shadow-sm">
                    <GraduationCap className="h-5 w-5 text-sidebar-primary-foreground" />
                  </div>
                  <div>
                    <SheetTitle className="text-sidebar-foreground tracking-tight text-base">
                      ExamLab
                    </SheetTitle>
                    <div className="text-[10px] text-sidebar-foreground/50 tracking-wide">
                      {t("auth.brandSubtitle")}
                    </div>
                  </div>
                </div>
              </SheetHeader>

              {/* Role selector inside drawer */}
              {roles.length > 1 ? (
                <div className="px-3 py-3 border-b border-sidebar-border">
                  <Select
                    value={activeRole ?? undefined}
                    onValueChange={(v) => {
                      setActiveRole(v as AppRole);
                      navigate({ to: "/app" });
                    }}
                  >
                    <SelectTrigger className="w-full bg-sidebar-accent/60 border-sidebar-border text-sidebar-foreground hover:bg-sidebar-accent gap-2 [&>svg:last-child]:hidden">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <ActiveIcon className={cn("h-4 w-4 shrink-0", activeCfg?.accent)} />
                        <span className="truncate">{activeCfg ? t(activeCfg.labelKey) : ""}</span>
                      </div>
                      <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
                    </SelectTrigger>
                    <SelectContent>
                      {roles.map((r) => {
                        const cfg = ROLE_CONFIG[r];
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
                      <ActiveIcon className={cn("h-4 w-4 shrink-0", activeCfg?.accent)} />
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
                  const iconColor = NAV_ICON_COLOR[item.to] ?? "text-sky-300";
                  const navClassName = cn(
                    "flex items-center gap-3 px-3 py-3 rounded-md text-sm transition-colors touch-manipulation",
                    isActive
                      ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                  );
                  if (isTakingExam) {
                    return (
                      <button
                        key={item.to}
                        type="button"
                        className={cn(navClassName, "w-full text-left")}
                        onClick={() => window.dispatchEvent(new CustomEvent("examlab:navAttempt"))}
                      >
                        <Icon className={cn("h-5 w-5 transition-colors", iconColor)} />
                        {t(item.labelKey)}
                      </button>
                    );
                  }
                  return (
                    <Link key={item.to} to={item.to} className={navClassName}>
                      <Icon className={cn("h-5 w-5 transition-colors", iconColor)} />
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
            <div className="h-7 w-7 rounded-md bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center shrink-0">
              <GraduationCap className="h-4 w-4 text-sidebar-primary-foreground" />
            </div>
            <span className="font-semibold truncate">ExamLab</span>
          </div>
        </div>

        {!isTakingExam && (
          <div className="flex items-center">
            <NotificationBell userId={user.id} viewerRole={activeRole ?? roles[0]} />
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
          title="Mostrar menú"
          aria-label="Mostrar menú"
        >
          <Menu className="h-4 w-4" />
        </Button>
      )}

      <main
        className={cn(
          "flex-1 min-w-0 pt-14 md:pt-0",
          // Compensar el sidebar fijo en desktop. Cuando está colapsado
          // el contenido ocupa todo el ancho.
          !sidebarCollapsed && "md:ml-64",
        )}
      >
        {/* Page container — constrained on desktop, full-bleed with 16px
            gutters on mobile. Bottom padding reserves room for the bottom
            nav on mobile so fixed content doesn't get clipped. */}
        <div className="px-4 md:px-8 py-5 md:py-8 pb-24 md:pb-8 max-w-7xl mx-auto">
          <ActiveRoleContext.Provider value={activeRole}>{children}</ActiveRoleContext.Provider>
        </div>

        {/* ──────────────────────────────────────────────────────────
           MOBILE BOTTOM NAV — thumb-reachable, up to 5 role-aware items
           Keeps the most frequent destinations one tap away without
           reopening the drawer.
           ────────────────────────────────────────────────────────── */}
        <nav
          className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-card border-t border-border flex items-stretch justify-around"
          style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
          aria-label="Navegación principal"
        >
          {visibleNav.slice(0, 5).map((item) => {
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

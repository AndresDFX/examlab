import { Link, useLocation, useNavigate, useMatchRoute } from "@tanstack/react-router";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { ActiveRoleContext } from "@/hooks/use-active-role";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NotificationBell } from "@/components/NotificationBell";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { useConfirm } from "@/components/ConfirmDialog";
import { checkAccess, homeForRole } from "@/lib/rbac";
import { logEvent } from "@/lib/audit";
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
  Sparkles,
  BarChart3,
  ScrollText,
  ShieldEllipsis,
  Presentation,
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
  // Admin-only: gestión de usuarios al final (transversal a la app, no académico).
  { to: "/app/admin/users", labelKey: "nav.users", icon: Users, roles: ["Admin"] },
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
  "/app/student/exams": "text-amber-300",
  "/app/student/workshops": "text-orange-300",
  "/app/student/projects": "text-rose-300",
  "/app/student/courses": "text-fuchsia-300",
  "/app/student/grades": "text-emerald-300",
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, roles, signOut, loading, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const confirm = useConfirm();

  const handleSignOut = async () => {
    const ok = await confirm({
      title: t("nav.signOut"),
      description: "¿Estás seguro de que quieres cerrar sesión?",
      confirmLabel: t("nav.signOut"),
      tone: "warning",
    });
    if (!ok) return;
    signOut();
  };
  const [activeRole, setActiveRole] = useState<AppRole | null>(null);
  const [pwDialogOpen, setPwDialogOpen] = useState(false);
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

  // Audit log: registra cada cambio de ruta dentro de /app/* como un
  // evento `user.navigated`. Permite que Auditoría muestre "El docente
  // X entró a Y a las HH:MM". Filtramos rutas no-app (/auth, /, etc.)
  // y rutas técnicas que generan demasiado ruido (?student=… deep
  // links). Fire-and-forget vía logEvent — nunca bloquea la UI.
  useEffect(() => {
    if (!user) return;
    if (!location.pathname.startsWith("/app")) return;
    void logEvent({
      action: "user.navigated",
      category: "system",
      actorRole: activeRole ?? roles[0],
      entityType: "page",
      entityName: location.pathname,
      severity: "info",
      metadata: { path: location.pathname, search: location.search ?? null },
    });
    // Solo rastreamos pathname — re-disparar al cambiar `search`
    // ensuciaría los logs (deep-links de notificación con ?student=...
    // recargarían la misma "página").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, user?.id]);

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

  const visibleNav = NAV.filter((n) => (activeRole ? n.roles.includes(activeRole) : false));
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
            <div className="flex items-center gap-1">
              <NotificationBell userId={user.id} variant="sidebar" />
              <ThemeToggle />
              <LanguageSwitcher className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground" />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setPwDialogOpen(true)}
                className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
                title={t("nav.changePassword")}
              >
                <KeyRound className="h-4 w-4" />
              </Button>
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
            <NotificationBell userId={user.id} />
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
    </div>
  );
}

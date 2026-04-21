import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { ActiveRoleContext } from "@/hooks/use-active-role";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { NotificationBell } from "@/components/NotificationBell";
import { ChangePasswordDialog } from "@/components/ChangePasswordDialog";
import { checkAccess } from "@/lib/rbac";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
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

const NAV: NavItem[] = [
  {
    to: "/app",
    labelKey: "nav.dashboard",
    icon: LayoutDashboard,
    roles: ["Admin", "Docente", "Estudiante"],
  },
  { to: "/app/admin/users", labelKey: "nav.users", icon: Users, roles: ["Admin"] },
  { to: "/app/admin/courses", labelKey: "nav.courses", icon: BookOpen, roles: ["Admin"] },
  { to: "/app/teacher/courses", labelKey: "nav.courses", icon: BookOpen, roles: ["Docente"] },
  { to: "/app/teacher/exams", labelKey: "nav.exams", icon: FileText, roles: ["Docente"] },
  { to: "/app/teacher/gradebook", labelKey: "nav.grades", icon: ClipboardList, roles: ["Docente"] },
  { to: "/app/teacher/workshops", labelKey: "nav.workshops", icon: Hammer, roles: ["Docente"] },
  { to: "/app/teacher/attendance", labelKey: "nav.attendance", icon: Users, roles: ["Docente"] },
  {
    to: "/app/student/exams",
    labelKey: "nav.studentExams",
    icon: BookOpenCheck,
    roles: ["Estudiante"],
  },
  {
    to: "/app/student/workshops",
    labelKey: "nav.studentWorkshops",
    icon: Hammer,
    roles: ["Estudiante"],
  },
  {
    to: "/app/student/courses",
    labelKey: "nav.studentCourses",
    icon: BookOpen,
    roles: ["Estudiante"],
  },
  {
    to: "/app/student/grades",
    labelKey: "nav.studentGrades",
    icon: ClipboardList,
    roles: ["Estudiante"],
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
  "/app/admin/courses": "text-fuchsia-300",
  "/app/teacher/courses": "text-fuchsia-300",
  "/app/teacher/exams": "text-amber-300",
  "/app/teacher/gradebook": "text-emerald-300",
  "/app/teacher/workshops": "text-orange-300",
  "/app/teacher/attendance": "text-cyan-300",
  "/app/student/exams": "text-amber-300",
  "/app/student/workshops": "text-orange-300",
  "/app/student/courses": "text-fuchsia-300",
  "/app/student/grades": "text-emerald-300",
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, roles, signOut, loading, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const [activeRole, setActiveRole] = useState<AppRole | null>(null);
  const [pwDialogOpen, setPwDialogOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

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
      navigate({ to: redirect });
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
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        <div className="px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center shadow-sm">
              <GraduationCap className="h-5 w-5 text-sidebar-primary-foreground" />
            </div>
            <div>
              <div className="font-semibold tracking-tight text-base">ExamLab</div>
              <div className="text-[10px] text-sidebar-foreground/50 tracking-wide">
                Plataforma de exámenes
              </div>
            </div>
          </div>
        </div>

        {/* Role selector */}
        {roles.length > 1 ? (
          <div className="px-3 py-3 border-b border-sidebar-border">
            <Select
              value={activeRole ?? undefined}
              onValueChange={(v) => setActiveRole(v as AppRole)}
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

        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {visibleNav.map((item) => {
            const Icon = item.icon;
            const isActive =
              location.pathname === item.to ||
              (item.to !== "/app" && location.pathname.startsWith(item.to));
            const iconColor = NAV_ICON_COLOR[item.to] ?? "text-sky-300";
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors group",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                )}
              >
                <Icon className={cn("h-4 w-4 transition-colors", iconColor)} />
                {t(item.labelKey)}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border">
          <div className="px-2 py-2 mb-1.5">
            <div className="text-sm font-medium truncate">{profile?.full_name ?? user.email}</div>
            <div className="text-xs text-sidebar-foreground/60 truncate">
              {profile?.institutional_email}
            </div>
          </div>
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
              onClick={signOut}
              className="text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground"
              title={t("nav.signOut")}
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </aside>

      <ChangePasswordDialog open={pwDialogOpen} onOpenChange={setPwDialogOpen} />

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-gradient-to-br from-sidebar-primary to-primary flex items-center justify-center">
            <GraduationCap className="h-4 w-4 text-sidebar-primary-foreground" />
          </div>
          <span className="font-semibold">ExamLab</span>
        </div>
        <div className="flex items-center gap-1">
          {/* Mobile role selector */}
          {roles.length > 1 && (
            <Select
              value={activeRole ?? undefined}
              onValueChange={(v) => setActiveRole(v as AppRole)}
            >
              <SelectTrigger className="h-8 w-auto bg-sidebar-accent/60 border-sidebar-border text-sidebar-foreground text-xs gap-1.5 px-2 [&>svg:last-child]:hidden">
                <ActiveIcon className={cn("h-3.5 w-3.5 shrink-0", activeCfg?.accent)} />
                <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
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
          )}
          <NotificationBell userId={user.id} />
          <ThemeToggle />
          <LanguageSwitcher className="text-sidebar-foreground" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPwDialogOpen(true)}
            className="text-sidebar-foreground"
            title={t("nav.changePassword")}
          >
            <KeyRound className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={signOut}
            className="text-sidebar-foreground"
            title={t("nav.signOut")}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <main className="flex-1 min-w-0 pt-14 md:pt-0">
        {/* Mobile nav scroll */}
        <div className="md:hidden overflow-x-auto border-b bg-card">
          <div className="flex gap-1 px-2 py-2">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              const isActive =
                location.pathname === item.to ||
                (item.to !== "/app" && location.pathname.startsWith(item.to));
              const iconColor = NAV_ICON_COLOR[item.to] ?? "text-primary";
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground bg-muted",
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", !isActive && iconColor)} />
                  {t(item.labelKey)}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="px-4 md:px-8 py-6 md:py-8 max-w-7xl mx-auto">
          <ActiveRoleContext.Provider value={activeRole}>{children}</ActiveRoleContext.Provider>
        </div>
      </main>
    </div>
  );
}

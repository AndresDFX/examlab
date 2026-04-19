import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { useAuth, type AppRole } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GraduationCap, Users, BookOpen, FileText, ClipboardList, LayoutDashboard, LogOut, ShieldCheck, UserCog, BookOpenCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState, useEffect } from "react";

interface NavItem { to: string; label: string; icon: React.ComponentType<{ className?: string }>; roles: AppRole[]; }

const NAV: NavItem[] = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, roles: ["Admin", "Docente", "Estudiante"] },
  // Admin
  { to: "/app/admin/users", label: "Usuarios", icon: Users, roles: ["Admin"] },
  { to: "/app/admin/courses", label: "Cursos", icon: BookOpen, roles: ["Admin"] },
  // Docente
  { to: "/app/teacher/exams", label: "Mis Exámenes", icon: FileText, roles: ["Docente"] },
  { to: "/app/teacher/gradebook", label: "Calificaciones", icon: ClipboardList, roles: ["Docente"] },
  // Estudiante
  { to: "/app/student/exams", label: "Mis Exámenes", icon: BookOpenCheck, roles: ["Estudiante"] },
];

const ROLE_BADGE: Record<AppRole, { label: string; className: string; icon: React.ComponentType<{ className?: string }> }> = {
  Admin: { label: "Admin", className: "bg-primary/15 text-primary border-primary/30", icon: ShieldCheck },
  Docente: { label: "Docente", className: "bg-warning/15 text-warning-foreground border-warning/40", icon: UserCog },
  Estudiante: { label: "Estudiante", className: "bg-success/15 text-success border-success/30", icon: GraduationCap },
};

export function AppLayout({ children }: { children: React.ReactNode }) {
  const { profile, roles, signOut, loading, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [activeRole, setActiveRole] = useState<AppRole | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);

  useEffect(() => {
    if (roles.length && !activeRole) {
      // Default: highest privilege
      const order: AppRole[] = ["Admin", "Docente", "Estudiante"];
      setActiveRole(order.find(r => roles.includes(r)) ?? roles[0]);
    }
  }, [roles, activeRole]);

  if (loading) {
    return <div className="flex h-screen items-center justify-center text-muted-foreground">Cargando…</div>;
  }
  if (!user) return null;

  const visibleNav = NAV.filter(n => activeRole ? n.roles.includes(activeRole) : false);

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Sidebar */}
      <aside className="hidden md:flex w-64 flex-col bg-sidebar text-sidebar-foreground border-r border-sidebar-border">
        <div className="px-5 py-5 border-b border-sidebar-border">
          <div className="flex items-center gap-2">
            <div className="h-9 w-9 rounded-lg bg-sidebar-primary flex items-center justify-center">
              <GraduationCap className="h-5 w-5 text-sidebar-primary-foreground" />
            </div>
            <div>
              <div className="font-semibold tracking-tight">ExamLab</div>
              <div className="text-xs text-sidebar-foreground/60">Plataforma de exámenes</div>
            </div>
          </div>
        </div>

        {roles.length > 1 && (
          <div className="px-4 py-3 border-b border-sidebar-border">
            <div className="text-[10px] uppercase tracking-wider text-sidebar-foreground/50 mb-2">Vista actual</div>
            <div className="flex flex-wrap gap-1.5">
              {roles.map(r => {
                const cfg = ROLE_BADGE[r];
                const Icon = cfg.icon;
                const active = r === activeRole;
                return (
                  <button
                    key={r}
                    onClick={() => setActiveRole(r)}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs border transition-colors",
                      active
                        ? "bg-sidebar-primary text-sidebar-primary-foreground border-sidebar-primary"
                        : "bg-sidebar-accent/50 text-sidebar-foreground/80 border-sidebar-border hover:bg-sidebar-accent"
                    )}
                  >
                    <Icon className="h-3 w-3" /> {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <nav className="flex-1 px-3 py-3 space-y-0.5">
          {visibleNav.map(item => {
            const Icon = item.icon;
            const isActive = location.pathname === item.to || (item.to !== "/app" && location.pathname.startsWith(item.to));
            return (
              <Link
                key={item.to}
                to={item.to}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors",
                  isActive
                    ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                    : "text-sidebar-foreground/75 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-sidebar-border">
          <div className="px-2 py-2 mb-1.5">
            <div className="text-sm font-medium truncate">{profile?.full_name ?? user.email}</div>
            <div className="text-xs text-sidebar-foreground/60 truncate">{profile?.institutional_email}</div>
            <div className="flex flex-wrap gap-1 mt-2">
              {roles.map(r => (
                <Badge key={r} variant="outline" className={cn("text-[10px] py-0 h-4", ROLE_BADGE[r].className)}>
                  {ROLE_BADGE[r].label}
                </Badge>
              ))}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={signOut} className="w-full justify-start text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground">
            <LogOut className="h-4 w-4 mr-2" /> Cerrar sesión
          </Button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 bg-sidebar text-sidebar-foreground border-b border-sidebar-border px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GraduationCap className="h-5 w-5" />
          <span className="font-semibold">ExamLab</span>
        </div>
        <Button variant="ghost" size="sm" onClick={signOut} className="text-sidebar-foreground">
          <LogOut className="h-4 w-4" />
        </Button>
      </div>

      <main className="flex-1 min-w-0 pt-14 md:pt-0">
        {/* Mobile nav scroll */}
        <div className="md:hidden overflow-x-auto border-b bg-card">
          <div className="flex gap-1 px-2 py-2">
            {visibleNav.map(item => {
              const Icon = item.icon;
              const isActive = location.pathname === item.to || (item.to !== "/app" && location.pathname.startsWith(item.to));
              return (
                <Link key={item.to} to={item.to}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs whitespace-nowrap",
                    isActive ? "bg-primary text-primary-foreground" : "text-muted-foreground bg-muted"
                  )}>
                  <Icon className="h-3.5 w-3.5" />{item.label}
                </Link>
              );
            })}
          </div>
        </div>
        <div className="px-4 md:px-8 py-6 md:py-8 max-w-7xl mx-auto">
          {children}
        </div>
      </main>
    </div>
  );
}

export function useActiveRole(): AppRole | null {
  // Simple shared via location? For now derive from local: pages will infer from path.
  return null;
}

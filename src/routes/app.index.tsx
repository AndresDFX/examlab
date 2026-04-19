import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useNotifications } from "@/hooks/use-notifications";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Users, BookOpen, FileText, ClipboardList, GraduationCap, Hammer,
  Calendar, Clock, Bell, CheckCircle2, AlertTriangle, ArrowRight,
} from "lucide-react";

export const Route = createFileRoute("/app/")({ component: Dashboard });

type UpcomingExam = {
  id: string; title: string; start_time: string; end_time: string;
  time_limit_minutes: number; course?: { name: string };
};
type UpcomingWorkshop = {
  id: string; title: string; due_date: string | null; status: string;
  course?: { name: string };
};

function Dashboard() {
  const { profile, roles, user } = useAuth();
  const { notifications, unreadCount, markAsRead } = useNotifications(user?.id);
  const [counts, setCounts] = useState({ users: 0, courses: 0, exams: 0, submissions: 0, workshops: 0 });
  const [upcomingExams, setUpcomingExams] = useState<UpcomingExam[]>([]);
  const [upcomingWorkshops, setUpcomingWorkshops] = useState<UpcomingWorkshop[]>([]);

  const isAdmin = roles.includes("Admin");
  const isTeacher = roles.includes("Docente");
  const isStudent = roles.includes("Estudiante");

  // Show unread notifications as toasts on first load
  useEffect(() => {
    if (unreadCount > 0) {
      const recent = notifications.filter(n => !n.read).slice(0, 3);
      recent.forEach(n => {
        toast.info(n.title, { description: n.body, duration: 5000 });
      });
    }
    // Only run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    (async () => {
      const [u, c, e, s, w] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("courses").select("id", { count: "exact", head: true }),
        supabase.from("exams").select("id", { count: "exact", head: true }),
        supabase.from("submissions").select("id", { count: "exact", head: true }),
        supabase.from("workshops").select("id", { count: "exact", head: true }),
      ]);
      setCounts({
        users: u.count ?? 0,
        courses: c.count ?? 0,
        exams: e.count ?? 0,
        submissions: s.count ?? 0,
        workshops: w.count ?? 0,
      });
    })();
  }, []);

  // Load upcoming events
  useEffect(() => {
    if (!user) return;
    const now = new Date().toISOString();

    (async () => {
      if (isStudent) {
        // Student: exams assigned to me that haven't ended
        const { data: asg } = await supabase
          .from("exam_assignments")
          .select("exam:exams(id, title, start_time, end_time, time_limit_minutes, course:courses(name))")
          .eq("user_id", user.id);
        const exams = (asg ?? [])
          .map((a: any) => a.exam)
          .filter((e: any) => e && new Date(e.end_time) > new Date())
          .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
          .slice(0, 5);
        setUpcomingExams(exams);

        // Student: workshops assigned to me
        const { data: wasg } = await supabase
          .from("workshop_assignments")
          .select("workshop:workshops(id, title, due_date, status, course:courses(name))")
          .eq("user_id", user.id);
        const ws = (wasg ?? [])
          .map((a: any) => a.workshop)
          .filter((w: any) => w && w.status === "published" && (!w.due_date || new Date(w.due_date) > new Date()))
          .sort((a: any, b: any) => new Date(a.due_date ?? "9999").getTime() - new Date(b.due_date ?? "9999").getTime())
          .slice(0, 5);
        setUpcomingWorkshops(ws);
      } else if (isTeacher || isAdmin) {
        // Teacher/Admin: upcoming exams
        const { data: exams } = await supabase
          .from("exams")
          .select("id, title, start_time, end_time, time_limit_minutes, course:courses(name)")
          .gte("end_time", now)
          .order("start_time")
          .limit(5);
        setUpcomingExams((exams ?? []) as any);

        // Teacher/Admin: active workshops
        const { data: ws } = await supabase
          .from("workshops")
          .select("id, title, due_date, status, course:courses(name)")
          .eq("status", "published")
          .order("due_date", { ascending: true, nullsFirst: false })
          .limit(5);
        setUpcomingWorkshops((ws ?? []) as any);
      }
    })();
  }, [user, isStudent, isTeacher, isAdmin]);

  const recentNotifs = notifications.filter(n => !n.read).slice(0, 5);

  return (
    <div className="space-y-6">
      {/* Greeting */}
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Hola, {profile?.full_name?.split(" ")[0] ?? "👋"}
        </h1>
        <p className="text-muted-foreground">Bienvenido a tu panel de ExamLab.</p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {isAdmin && <Stat icon={Users} label="Usuarios" value={counts.users} />}
        <Stat icon={BookOpen} label="Cursos" value={counts.courses} />
        <Stat icon={FileText} label="Exámenes" value={counts.exams} />
        <Stat icon={Hammer} label="Talleres" value={counts.workshops} />
        <Stat icon={ClipboardList} label="Entregas" value={counts.submissions} />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {/* Upcoming exams */}
        <Card className="md:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              Próximos exámenes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingExams.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Sin exámenes próximos</p>
            ) : (
              upcomingExams.map(e => {
                const start = new Date(e.start_time);
                const isOpen = new Date() >= start && new Date() <= new Date(e.end_time);
                return (
                  <div key={e.id} className="flex items-start gap-2 p-2 rounded-md border bg-card hover:bg-muted/30 transition-colors">
                    <div className="mt-0.5">
                      {isOpen
                        ? <span className="flex h-2 w-2 rounded-full bg-success animate-pulse" />
                        : <span className="flex h-2 w-2 rounded-full bg-muted-foreground/30" />
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{e.title}</div>
                      <div className="text-xs text-muted-foreground">{e.course?.name}</div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Clock className="h-3 w-3" />
                        {start.toLocaleDateString()} · {e.time_limit_minutes} min
                      </div>
                    </div>
                    {isOpen && <Badge className="bg-success text-success-foreground text-[10px] shrink-0">Abierto</Badge>}
                  </div>
                );
              })
            )}
            {isStudent && (
              <Link to="/app/student/exams">
                <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                  Ver todos <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            )}
            {isTeacher && (
              <Link to="/app/teacher/exams">
                <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                  Gestionar <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>

        {/* Upcoming workshops */}
        <Card className="md:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" />
              Talleres activos
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingWorkshops.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Sin talleres activos</p>
            ) : (
              upcomingWorkshops.map(w => {
                const isOverdue = w.due_date && new Date(w.due_date) < new Date();
                return (
                  <div key={w.id} className="flex items-start gap-2 p-2 rounded-md border bg-card hover:bg-muted/30 transition-colors">
                    <div className="mt-0.5">
                      {isOverdue
                        ? <AlertTriangle className="h-3 w-3 text-destructive" />
                        : <span className="flex h-2 w-2 rounded-full bg-amber-400" />
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{w.title}</div>
                      <div className="text-xs text-muted-foreground">{w.course?.name}</div>
                      {w.due_date && (
                        <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                          <Clock className="h-3 w-3" />
                          {new Date(w.due_date).toLocaleDateString()}
                        </div>
                      )}
                    </div>
                    {isOverdue && <Badge variant="destructive" className="text-[10px] shrink-0">Vencido</Badge>}
                  </div>
                );
              })
            )}
            {isStudent && (
              <Link to="/app/student/workshops">
                <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                  Ver todos <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            )}
            {isTeacher && (
              <Link to="/app/teacher/workshops">
                <Button variant="ghost" size="sm" className="w-full text-xs mt-1">
                  Gestionar <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>

        {/* Recent notifications */}
        <Card className="md:col-span-1">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              Notificaciones
              {unreadCount > 0 && (
                <Badge className="text-[10px] h-5">{unreadCount} nueva{unreadCount > 1 ? "s" : ""}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recentNotifs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Sin notificaciones nuevas</p>
            ) : (
              recentNotifs.map(n => (
                <button
                  key={n.id}
                  onClick={() => markAsRead(n.id)}
                  className="w-full text-left flex items-start gap-2 p-2 rounded-md border bg-primary/5 hover:bg-muted/30 transition-colors"
                >
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{n.title}</div>
                    <p className="text-xs text-muted-foreground line-clamp-1">{n.body}</p>
                    <span className="text-[10px] text-muted-foreground/60">
                      {new Date(n.created_at).toLocaleString()}
                    </span>
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      <div>
        <h2 className="text-sm font-medium text-muted-foreground mb-3">Acciones rápidas</h2>
        <div className="grid md:grid-cols-3 gap-3">
          {isAdmin && (
            <QuickCard to="/app/admin/users" title="Gestionar usuarios" desc="CRUD, roles y carga CSV" icon={Users} />
          )}
          {isAdmin && (
            <QuickCard to="/app/admin/courses" title="Gestionar cursos" desc="Crear cursos y matricular estudiantes" icon={BookOpen} />
          )}
          {isTeacher && (
            <QuickCard to="/app/teacher/exams" title="Crear examen" desc="Diseña con IA y asigna por estudiante" icon={FileText} />
          )}
          {isTeacher && (
            <QuickCard to="/app/teacher/gradebook" title="Calificaciones" desc="Matriz de notas y exportación CSV" icon={ClipboardList} />
          )}
          {isTeacher && (
            <QuickCard to="/app/teacher/workshops" title="Talleres" desc="Crea y califica talleres con IA" icon={Hammer} />
          )}
          {isStudent && (
            <QuickCard to="/app/student/exams" title="Exámenes" desc="Inicia exámenes asignados" icon={GraduationCap} />
          )}
          {isStudent && (
            <QuickCard to="/app/student/workshops" title="Talleres" desc="Entrega y revisa talleres" icon={Hammer} />
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold">{value}</div>
          </div>
          <Icon className="h-5 w-5 text-primary" />
        </div>
      </CardContent>
    </Card>
  );
}

function QuickCard({ to, title, desc, icon: Icon }: { to: string; title: string; desc: string; icon: any }) {
  return (
    <Link to={to}>
      <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
        <CardHeader className="pb-2">
          <Icon className="h-5 w-5 text-primary mb-1" />
          <CardTitle className="text-base">{title}</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground pt-0">{desc}</CardContent>
      </Card>
    </Link>
  );
}

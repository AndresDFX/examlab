import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { useActiveRole } from "@/hooks/use-active-role";
import { useNotifications } from "@/hooks/use-notifications";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
  Users, BookOpen, FileText, ClipboardList, GraduationCap, Hammer,
  Calendar, Clock, Bell, CheckCircle2, AlertTriangle, ArrowRight,
  ShieldCheck, Play, Send, Eye, TrendingUp, UserCog,
} from "lucide-react";

export const Route = createFileRoute("/app/")({ component: Dashboard });

function Dashboard() {
  const { profile, roles, user } = useAuth();
  const activeRole = useActiveRole();
  const { notifications, unreadCount, markAsRead } = useNotifications(user?.id);

  const isAdmin = activeRole === "Admin";
  const isTeacher = activeRole === "Docente";
  const isStudent = activeRole === "Estudiante";

  // Toast unread on mount
  useEffect(() => {
    if (unreadCount > 0) {
      const recent = notifications.filter(n => !n.read).slice(0, 3);
      recent.forEach(n => { toast.info(n.title, { description: n.body, duration: 5000 }); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recentNotifs = notifications.filter(n => !n.read).slice(0, 5);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Hola, {profile?.full_name?.split(" ")[0] ?? "👋"}
        </h1>
        <p className="text-muted-foreground">
          {isAdmin ? "Panel de administración" : isTeacher ? "Panel docente" : "Tu espacio de estudio"}
        </p>
      </div>

      {isAdmin && <AdminDashboard />}
      {isTeacher && <TeacherDashboard userId={user?.id} />}
      {isStudent && <StudentDashboard userId={user?.id} />}

      {/* Notifications — shared across roles */}
      {recentNotifs.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="h-4 w-4 text-primary" />
              Notificaciones
              <Badge className="text-[10px] h-5">{unreadCount}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
              {recentNotifs.map(n => (
                <button
                  key={n.id}
                  onClick={() => markAsRead(n.id)}
                  className="w-full text-left flex items-start gap-2 p-2.5 rounded-md border bg-primary/5 hover:bg-muted/30 transition-colors"
                >
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-primary shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{n.title}</div>
                    <p className="text-xs text-muted-foreground line-clamp-1">{n.body}</p>
                  </div>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   ADMIN DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function AdminDashboard() {
  const [counts, setCounts] = useState({ users: 0, courses: 0, exams: 0, submissions: 0, workshops: 0 });
  const [recentUsers, setRecentUsers] = useState<{ full_name: string; institutional_email: string; created_at: string }[]>([]);

  useEffect(() => {
    (async () => {
      const [u, c, e, s, w] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("courses").select("id", { count: "exact", head: true }),
        supabase.from("exams").select("id", { count: "exact", head: true }),
        supabase.from("submissions").select("id", { count: "exact", head: true }),
        supabase.from("workshops").select("id", { count: "exact", head: true }),
      ]);
      setCounts({ users: u.count ?? 0, courses: c.count ?? 0, exams: e.count ?? 0, submissions: s.count ?? 0, workshops: w.count ?? 0 });

      const { data: ru } = await supabase.from("profiles").select("full_name, institutional_email, created_at").order("created_at", { ascending: false }).limit(5);
      setRecentUsers((ru ?? []) as any);
    })();
  }, []);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Stat icon={Users} label="Usuarios" value={counts.users} color="text-indigo-500 dark:text-indigo-400" />
        <Stat icon={BookOpen} label="Cursos" value={counts.courses} color="text-blue-500 dark:text-blue-400" />
        <Stat icon={FileText} label="Exámenes" value={counts.exams} color="text-violet-500 dark:text-violet-400" />
        <Stat icon={Hammer} label="Talleres" value={counts.workshops} color="text-amber-500 dark:text-amber-400" />
        <Stat icon={ClipboardList} label="Entregas" value={counts.submissions} color="text-emerald-500 dark:text-emerald-400" />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Users className="h-4 w-4 text-indigo-500" /> Usuarios recientes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {recentUsers.map((u, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded-md border text-sm">
                <div className="h-7 w-7 rounded-full bg-indigo-500/10 flex items-center justify-center text-xs font-medium text-indigo-600 dark:text-indigo-400">
                  {u.full_name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{u.full_name}</div>
                  <div className="text-xs text-muted-foreground truncate">{u.institutional_email}</div>
                </div>
              </div>
            ))}
            <Link to="/app/admin/users">
              <Button variant="ghost" size="sm" className="w-full text-xs mt-1">Gestionar usuarios <ArrowRight className="h-3 w-3 ml-1" /></Button>
            </Link>
          </CardContent>
        </Card>

        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Administración</h2>
          <div className="grid grid-cols-2 gap-3">
            <QuickCard to="/app/admin/users" title="Usuarios" desc="Crear, editar roles, importar CSV" icon={Users} color="bg-indigo-500/10 text-indigo-600 dark:text-indigo-400" />
            <QuickCard to="/app/admin/courses" title="Cursos" desc="Periodos, fechas, matrículas" icon={BookOpen} color="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
          </div>
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   TEACHER DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function TeacherDashboard({ userId }: { userId: string | undefined }) {
  const [counts, setCounts] = useState({ exams: 0, workshops: 0, pendingGrades: 0, courses: 0 });
  const [upcomingExams, setUpcomingExams] = useState<any[]>([]);
  const [activeWorkshops, setActiveWorkshops] = useState<any[]>([]);

  useEffect(() => {
    (async () => {
      const now = new Date().toISOString();
      const [e, w, pg, c] = await Promise.all([
        supabase.from("exams").select("id", { count: "exact", head: true }),
        supabase.from("workshops").select("id", { count: "exact", head: true }),
        supabase.from("submissions").select("id", { count: "exact", head: true }).eq("status", "completado").is("final_override_grade", null),
        supabase.from("courses").select("id", { count: "exact", head: true }),
      ]);
      setCounts({ exams: e.count ?? 0, workshops: w.count ?? 0, pendingGrades: pg.count ?? 0, courses: c.count ?? 0 });

      const { data: exams } = await supabase
        .from("exams")
        .select("id, title, start_time, end_time, time_limit_minutes, course:courses(name)")
        .gte("end_time", now)
        .order("start_time")
        .limit(4);
      setUpcomingExams(exams ?? []);

      const { data: ws } = await supabase
        .from("workshops")
        .select("id, title, due_date, status, course:courses(name)")
        .eq("status", "published")
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(4);
      setActiveWorkshops(ws ?? []);
    })();
  }, []);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={FileText} label="Exámenes" value={counts.exams} color="text-violet-500 dark:text-violet-400" />
        <Stat icon={Hammer} label="Talleres" value={counts.workshops} color="text-amber-500 dark:text-amber-400" />
        <Stat icon={Eye} label="Por calificar" value={counts.pendingGrades} color="text-rose-500 dark:text-rose-400" />
        <Stat icon={BookOpen} label="Cursos" value={counts.courses} color="text-blue-500 dark:text-blue-400" />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {/* Upcoming exams */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-violet-500 dark:text-violet-400" /> Próximos exámenes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingExams.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Sin exámenes próximos</p>
            ) : upcomingExams.map((e: any) => {
              const isOpen = new Date() >= new Date(e.start_time) && new Date() <= new Date(e.end_time);
              return (
                <EventRow key={e.id} title={e.title} subtitle={e.course?.name} date={new Date(e.start_time).toLocaleDateString()} badge={isOpen ? "En curso" : undefined} badgeColor="bg-success text-success-foreground" />
              );
            })}
            <Link to="/app/teacher/exams"><Button variant="ghost" size="sm" className="w-full text-xs mt-1">Gestionar <ArrowRight className="h-3 w-3 ml-1" /></Button></Link>
          </CardContent>
        </Card>

        {/* Active workshops */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" /> Talleres activos
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {activeWorkshops.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Sin talleres activos</p>
            ) : activeWorkshops.map((w: any) => (
              <EventRow key={w.id} title={w.title} subtitle={w.course?.name} date={w.due_date ? new Date(w.due_date).toLocaleDateString() : "Sin fecha"} />
            ))}
            <Link to="/app/teacher/workshops"><Button variant="ghost" size="sm" className="w-full text-xs mt-1">Gestionar <ArrowRight className="h-3 w-3 ml-1" /></Button></Link>
          </CardContent>
        </Card>

        {/* Quick actions */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Acciones rápidas</h2>
          <div className="space-y-2">
            <QuickCard to="/app/teacher/exams" title="Crear examen" desc="Diseña con IA y asigna" icon={FileText} color="bg-violet-500/10 text-violet-600 dark:text-violet-400" />
            <QuickCard to="/app/teacher/workshops" title="Crear taller" desc="Publica y asigna a cursos" icon={Hammer} color="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
            <QuickCard to="/app/teacher/gradebook" title="Calificaciones" desc="Matriz de notas y CSV" icon={ClipboardList} color="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" />
          </div>
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   STUDENT DASHBOARD
   ═══════════════════════════════════════════════════════════ */
function StudentDashboard({ userId }: { userId: string | undefined }) {
  const [upcomingExams, setUpcomingExams] = useState<any[]>([]);
  const [pendingWorkshops, setPendingWorkshops] = useState<any[]>([]);
  const [completedCount, setCompletedCount] = useState(0);
  const [courseCount, setCourseCount] = useState(0);

  useEffect(() => {
    if (!userId) return;
    (async () => {
      // Assigned exams
      const { data: asg } = await supabase
        .from("exam_assignments")
        .select("exam:exams(id, title, start_time, end_time, time_limit_minutes, course:courses(name))")
        .eq("user_id", userId);
      const exams = (asg ?? [])
        .map((a: any) => a.exam)
        .filter((e: any) => e && new Date(e.end_time) > new Date())
        .sort((a: any, b: any) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime())
        .slice(0, 4);
      setUpcomingExams(exams);

      // Assigned workshops
      const { data: wasg } = await supabase
        .from("workshop_assignments")
        .select("workshop:workshops(id, title, due_date, status, course:courses(name))")
        .eq("user_id", userId);
      const ws = (wasg ?? [])
        .map((a: any) => a.workshop)
        .filter((w: any) => w && w.status === "published")
        .sort((a: any, b: any) => new Date(a.due_date ?? "9999").getTime() - new Date(b.due_date ?? "9999").getTime())
        .slice(0, 4);
      setPendingWorkshops(ws);

      // Completed submissions
      const { count } = await supabase.from("submissions").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "completado");
      setCompletedCount(count ?? 0);

      // Enrolled courses
      const { count: cc } = await supabase.from("course_enrollments").select("id", { count: "exact", head: true }).eq("user_id", userId);
      setCourseCount(cc ?? 0);
    })();
  }, [userId]);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={FileText} label="Exámenes pendientes" value={upcomingExams.length} color="text-violet-500 dark:text-violet-400" />
        <Stat icon={Hammer} label="Talleres pendientes" value={pendingWorkshops.length} color="text-amber-500 dark:text-amber-400" />
        <Stat icon={CheckCircle2} label="Completados" value={completedCount} color="text-emerald-500 dark:text-emerald-400" />
        <Stat icon={BookOpen} label="Cursos" value={courseCount} color="text-blue-500 dark:text-blue-400" />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        {/* Upcoming exams */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-violet-500 dark:text-violet-400" /> Próximos exámenes
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {upcomingExams.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">No tienes exámenes pendientes 🎉</p>
            ) : upcomingExams.map((e: any) => {
              const isOpen = new Date() >= new Date(e.start_time) && new Date() <= new Date(e.end_time);
              return (
                <Link key={e.id} to="/app/student/take/$examId" params={{ examId: e.id }}>
                  <div className="flex items-start gap-2 p-2.5 rounded-md border hover:border-primary/40 transition-colors cursor-pointer">
                    <div className="mt-0.5">
                      {isOpen
                        ? <Play className="h-3.5 w-3.5 text-success" />
                        : <Clock className="h-3.5 w-3.5 text-muted-foreground/50" />
                      }
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{e.title}</div>
                      <div className="text-xs text-muted-foreground">{e.course?.name} · {e.time_limit_minutes} min</div>
                    </div>
                    {isOpen && <Badge className="bg-success text-success-foreground text-[10px] shrink-0">Iniciar</Badge>}
                  </div>
                </Link>
              );
            })}
            <Link to="/app/student/exams"><Button variant="ghost" size="sm" className="w-full text-xs mt-1">Ver todos <ArrowRight className="h-3 w-3 ml-1" /></Button></Link>
          </CardContent>
        </Card>

        {/* Pending workshops */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Hammer className="h-4 w-4 text-amber-500 dark:text-amber-400" /> Talleres por entregar
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {pendingWorkshops.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">Sin talleres pendientes 🎉</p>
            ) : pendingWorkshops.map((w: any) => {
              const isOverdue = w.due_date && new Date(w.due_date) < new Date();
              return (
                <div key={w.id} className="flex items-start gap-2 p-2.5 rounded-md border">
                  <div className="mt-0.5">
                    {isOverdue
                      ? <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                      : <Send className="h-3.5 w-3.5 text-amber-500 dark:text-amber-400" />
                    }
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{w.title}</div>
                    <div className="text-xs text-muted-foreground">{w.course?.name}</div>
                    {w.due_date && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Entrega: {new Date(w.due_date).toLocaleDateString()}
                      </div>
                    )}
                  </div>
                  {isOverdue && <Badge variant="destructive" className="text-[10px] shrink-0">Vencido</Badge>}
                </div>
              );
            })}
            <Link to="/app/student/workshops"><Button variant="ghost" size="sm" className="w-full text-xs mt-1">Ver todos <ArrowRight className="h-3 w-3 ml-1" /></Button></Link>
          </CardContent>
        </Card>

        {/* Quick links */}
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">Acceso rápido</h2>
          <div className="space-y-2">
            <QuickCard to="/app/student/exams" title="Exámenes" desc="Inicia y revisa tus exámenes" icon={GraduationCap} color="bg-violet-500/10 text-violet-600 dark:text-violet-400" />
            <QuickCard to="/app/student/workshops" title="Talleres" desc="Entrega y revisa talleres" icon={Hammer} color="bg-amber-500/10 text-amber-600 dark:text-amber-400" />
            <QuickCard to="/app/student/courses" title="Cursos" desc="Información de tus cursos" icon={BookOpen} color="bg-blue-500/10 text-blue-600 dark:text-blue-400" />
          </div>
        </div>
      </div>
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   SHARED COMPONENTS
   ═══════════════════════════════════════════════════════════ */

function Stat({ icon: Icon, label, value, color = "text-primary" }: { icon: any; label: string; value: number; color?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="text-2xl font-semibold tabular-nums">{value}</div>
          </div>
          <div className={`h-9 w-9 rounded-lg bg-muted/50 flex items-center justify-center ${color}`}>
            <Icon className="h-4.5 w-4.5" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function QuickCard({ to, title, desc, icon: Icon, color = "bg-primary/10 text-primary" }: { to: string; title: string; desc: string; icon: any; color?: string }) {
  return (
    <Link to={to}>
      <Card className="hover:border-primary/40 transition-colors cursor-pointer">
        <CardContent className="p-4 flex items-center gap-3">
          <div className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
            <Icon className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium">{title}</div>
            <div className="text-xs text-muted-foreground">{desc}</div>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

function EventRow({ title, subtitle, date, badge, badgeColor = "bg-primary text-primary-foreground" }: { title: string; subtitle?: string; date: string; badge?: string; badgeColor?: string }) {
  return (
    <div className="flex items-start gap-2 p-2 rounded-md border">
      <div className="mt-0.5"><span className="flex h-2 w-2 rounded-full bg-muted-foreground/30" /></div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{title}</div>
        {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
        <div className="text-xs text-muted-foreground mt-0.5">{date}</div>
      </div>
      {badge && <Badge className={`text-[10px] shrink-0 ${badgeColor}`}>{badge}</Badge>}
    </div>
  );
}

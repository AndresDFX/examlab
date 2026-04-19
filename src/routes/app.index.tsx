import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, BookOpen, FileText, ClipboardList, GraduationCap } from "lucide-react";

export const Route = createFileRoute("/app/")({
  component: Dashboard,
});

function Dashboard() {
  const { profile, roles } = useAuth();
  const [counts, setCounts] = useState({ users: 0, courses: 0, exams: 0, submissions: 0, myExams: 0 });

  useEffect(() => {
    (async () => {
      const [u, c, e, s] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("courses").select("id", { count: "exact", head: true }),
        supabase.from("exams").select("id", { count: "exact", head: true }),
        supabase.from("submissions").select("id", { count: "exact", head: true }),
      ]);
      setCounts({
        users: u.count ?? 0,
        courses: c.count ?? 0,
        exams: e.count ?? 0,
        submissions: s.count ?? 0,
        myExams: 0,
      });
    })();
  }, []);

  const isAdmin = roles.includes("Admin");
  const isTeacher = roles.includes("Docente");
  const isStudent = roles.includes("Estudiante");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Hola, {profile?.full_name?.split(" ")[0] ?? "👋"}
        </h1>
        <p className="text-muted-foreground">Bienvenido a tu panel.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat icon={Users} label="Usuarios" value={counts.users} />
        <Stat icon={BookOpen} label="Cursos" value={counts.courses} />
        <Stat icon={FileText} label="Exámenes" value={counts.exams} />
        <Stat icon={ClipboardList} label="Entregas" value={counts.submissions} />
      </div>

      <div className="grid md:grid-cols-3 gap-4">
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
        {isStudent && (
          <QuickCard to="/app/student/exams" title="Mis exámenes" desc="Inicia exámenes asignados" icon={GraduationCap} />
        )}
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

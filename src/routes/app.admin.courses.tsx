import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Trash2, Users, Calendar, Pencil } from "lucide-react";

export const Route = createFileRoute("/app/admin/courses")({ component: AdminCourses });

type Course = {
  id: string; name: string; description: string | null;
  period: string | null; start_date: string | null; end_date: string | null;
};
type Profile = { id: string; full_name: string; institutional_email: string };

function AdminCourses() {
  const { roles } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Course> | null>(null);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollCourse, setEnrollCourse] = useState<Course | null>(null);
  const [students, setStudents] = useState<Profile[]>([]);
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());
  const isAdmin = roles.includes("Admin");

  const load = async () => {
    const { data } = await supabase.from("courses").select("*").order("period", { ascending: false, nullsFirst: false }).order("name");
    setCourses((data ?? []) as Course[]);
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setEditing({ id: "", name: "", description: "", period: "", start_date: "", end_date: "" });
    setOpen(true);
  };

  const save = async () => {
    if (!editing?.name?.trim()) { toast.error("Nombre requerido"); return; }
    const payload = {
      name: editing.name,
      description: editing.description || null,
      period: editing.period || null,
      start_date: editing.start_date || null,
      end_date: editing.end_date || null,
    };
    if (editing.id) {
      const { error } = await supabase.from("courses").update(payload).eq("id", editing.id);
      if (error) return toast.error(error.message);
    } else {
      const { error } = await supabase.from("courses").insert(payload);
      if (error) return toast.error(error.message);
    }
    toast.success("Guardado");
    setOpen(false); setEditing(null); load();
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar este curso? Borra también matrículas, exámenes y talleres.")) return;
    const { error } = await supabase.from("courses").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Eliminado"); load();
  };

  const openEnroll = async (c: Course) => {
    setEnrollCourse(c);
    const [{ data: studs }, { data: enr }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, institutional_email").order("full_name"),
      supabase.from("course_enrollments").select("user_id").eq("course_id", c.id),
    ]);
    setStudents(studs ?? []);
    setEnrolledIds(new Set((enr ?? []).map((e: any) => e.user_id)));
    setEnrollOpen(true);
  };

  const toggleEnroll = async (uid: string, checked: boolean) => {
    if (!enrollCourse) return;
    if (checked) {
      const { error } = await supabase.from("course_enrollments").insert({ course_id: enrollCourse.id, user_id: uid });
      if (error) return toast.error(error.message);
      setEnrolledIds(new Set([...enrolledIds, uid]));
    } else {
      const { error } = await supabase.from("course_enrollments").delete().eq("course_id", enrollCourse.id).eq("user_id", uid);
      if (error) return toast.error(error.message);
      const ns = new Set(enrolledIds); ns.delete(uid); setEnrolledIds(ns);
    }
  };

  if (!isAdmin) return <p className="text-muted-foreground">Necesitas rol Admin.</p>;

  // Group by period
  const periods = [...new Set(courses.map(c => c.period ?? "Sin periodo"))];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cursos</h1>
          <p className="text-sm text-muted-foreground">{courses.length} cursos registrados</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="h-4 w-4 mr-1" /> Nuevo curso
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead>Periodo</TableHead>
                <TableHead className="hidden md:table-cell">Fechas</TableHead>
                <TableHead className="hidden lg:table-cell">Descripción</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {courses.map(c => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell>
                    {c.period ? (
                      <Badge variant="outline" className="text-xs">{c.period}</Badge>
                    ) : <span className="text-muted-foreground text-xs">—</span>}
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {c.start_date && c.end_date
                      ? `${new Date(c.start_date + "T00:00").toLocaleDateString()} → ${new Date(c.end_date + "T00:00").toLocaleDateString()}`
                      : c.start_date
                        ? `Desde ${new Date(c.start_date + "T00:00").toLocaleDateString()}`
                        : "—"
                    }
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell max-w-48 truncate">{c.description ?? "—"}</TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button variant="ghost" size="sm" onClick={() => openEnroll(c)}><Users className="h-4 w-4 mr-1" />Matrícula</Button>
                    <Button variant="ghost" size="sm" onClick={() => { setEditing(c); setOpen(true); }}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(c.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing?.id ? "Editar" : "Nuevo"} curso</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div><Label>Nombre</Label><Input value={editing.name ?? ""} onChange={e => setEditing({ ...editing, name: e.target.value })} placeholder="Ej: Programación II" /></div>
              <div><Label>Periodo</Label><Input value={editing.period ?? ""} onChange={e => setEditing({ ...editing, period: e.target.value })} placeholder="Ej: 2026-1" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Fecha inicio</Label><Input type="date" value={editing.start_date ?? ""} onChange={e => setEditing({ ...editing, start_date: e.target.value })} /></div>
                <div><Label>Fecha fin</Label><Input type="date" value={editing.end_date ?? ""} onChange={e => setEditing({ ...editing, end_date: e.target.value })} /></div>
              </div>
              <div><Label>Descripción</Label><Textarea value={editing.description ?? ""} onChange={e => setEditing({ ...editing, description: e.target.value })} /></div>
            </div>
          )}
          <DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button><Button onClick={save}>Guardar</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enrollment Dialog */}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Matrículas — {enrollCourse?.name}</DialogTitle></DialogHeader>
          <div className="max-h-96 overflow-y-auto space-y-1.5">
            {students.map(s => (
              <label key={s.id} className="flex items-center gap-2 p-2 rounded hover:bg-muted/50 text-sm">
                <Checkbox checked={enrolledIds.has(s.id)} onCheckedChange={(v) => toggleEnroll(s.id, !!v)} />
                <div className="flex-1">
                  <div className="font-medium">{s.full_name}</div>
                  <div className="text-xs text-muted-foreground">{s.institutional_email}</div>
                </div>
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

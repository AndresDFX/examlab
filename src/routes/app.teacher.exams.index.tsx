import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Pencil, GitBranch, Monitor } from "lucide-react";

export const Route = createFileRoute("/app/teacher/exams/")({ component: TeacherExams });

type Course = { id: string; name: string };
type Exam = {
  id: string; course_id: string; title: string; description: string | null;
  start_time: string; end_time: string; time_limit_minutes: number;
  navigation_type: string; shuffle_enabled: boolean; parent_exam_id: string | null;
  course?: { name: string };
};

function TeacherExams() {
  const { user, roles } = useAuth();
  const navigate = useNavigate();
  const [courses, setCourses] = useState<Course[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Exam>>({});
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  const load = async () => {
    const [{ data: cs }, { data: es }] = await Promise.all([
      supabase.from("courses").select("id, name").order("name"),
      supabase.from("exams").select("*, course:courses(name)").order("start_time", { ascending: false }),
    ]);
    setCourses(cs ?? []);
    setExams((es ?? []) as any);
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    setForm({
      title: "",
      course_id: courses[0]?.id,
      start_time: toLocal(now),
      end_time: toLocal(end),
      time_limit_minutes: 60,
      navigation_type: "libre",
      shuffle_enabled: false,
      parent_exam_id: null,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!form.title || !form.course_id || !user) { toast.error("Completa los campos"); return; }
    const payload = {
      course_id: form.course_id,
      title: form.title,
      description: form.description ?? null,
      start_time: new Date(form.start_time!).toISOString(),
      end_time: new Date(form.end_time!).toISOString(),
      time_limit_minutes: Number(form.time_limit_minutes) || 60,
      navigation_type: form.navigation_type ?? "libre",
      shuffle_enabled: !!form.shuffle_enabled,
      parent_exam_id: form.parent_exam_id || null,
      created_by: user.id,
    };
    const { data, error } = await supabase.from("exams").insert(payload).select().single();
    if (error) return toast.error(error.message);
    toast.success("Examen creado");
    setOpen(false);
    navigate({ to: "/app/teacher/exams/$examId", params: { examId: data.id } });
  };

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Mis Exámenes</h1>
          <p className="text-sm text-muted-foreground">{exams.length} exámenes</p>
        </div>
        <Button size="sm" onClick={openNew}><Plus className="h-4 w-4 mr-1" />Nuevo examen</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Curso</TableHead>
                <TableHead>Inicio</TableHead>
                <TableHead>Duración</TableHead>
                <TableHead>Tipo</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.map(e => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">
                    {e.title}
                    {e.parent_exam_id && <Badge variant="outline" className="ml-2 text-[10px]"><GitBranch className="h-3 w-3 mr-1" />Supletorio</Badge>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{e.course?.name}</TableCell>
                  <TableCell className="text-sm">{new Date(e.start_time).toLocaleString()}</TableCell>
                  <TableCell className="text-sm">{e.time_limit_minutes} min</TableCell>
                  <TableCell><Badge variant="secondary" className="text-[10px]">{e.navigation_type}</Badge></TableCell>
                  <TableCell className="text-right space-x-1">
                    <Link to="/app/teacher/monitor/$examId" params={{ examId: e.id }}>
                      <Button variant="ghost" size="sm"><Monitor className="h-4 w-4 mr-1" />Monitor</Button>
                    </Link>
                    <Link to="/app/teacher/exams/$examId" params={{ examId: e.id }}>
                      <Button variant="ghost" size="sm"><Pencil className="h-4 w-4 mr-1" />Editar</Button>
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Nuevo examen</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Título</Label><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div><Label>Descripción</Label><Textarea value={form.description ?? ""} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
            <div>
              <Label>Curso</Label>
              <Select value={form.course_id} onValueChange={(v) => setForm({ ...form, course_id: v })}>
                <SelectTrigger><SelectValue placeholder="Curso" /></SelectTrigger>
                <SelectContent>
                  {courses.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Inicio</Label><Input type="datetime-local" value={form.start_time as any} onChange={e => setForm({ ...form, start_time: e.target.value })} /></div>
              <div><Label>Fin</Label><Input type="datetime-local" value={form.end_time as any} onChange={e => setForm({ ...form, end_time: e.target.value })} /></div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Duración (min)</Label><Input type="number" value={form.time_limit_minutes || ""} onChange={e => setForm({ ...form, time_limit_minutes: e.target.value === "" ? 0 : Number(e.target.value) })} /></div>
              <div>
                <Label>Navegación</Label>
                <Select value={form.navigation_type} onValueChange={(v) => setForm({ ...form, navigation_type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="libre">Libre</SelectItem>
                    <SelectItem value="secuencial">Secuencial</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label>Mezclar preguntas</Label>
              <Switch checked={!!form.shuffle_enabled} onCheckedChange={(v) => setForm({ ...form, shuffle_enabled: v })} />
            </div>
            <div>
              <Label>Es supletorio de (opcional)</Label>
              <Select value={form.parent_exam_id ?? "none"} onValueChange={(v) => setForm({ ...form, parent_exam_id: v === "none" ? null : v })}>
                <SelectTrigger><SelectValue placeholder="Examen original" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Ninguno</SelectItem>
                  {exams.filter(e => !e.parent_exam_id && e.course_id === form.course_id).map(e => (
                    <SelectItem key={e.id} value={e.id}>{e.title}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save}>Crear</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

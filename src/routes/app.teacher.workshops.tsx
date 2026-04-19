import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import {
  Plus, Pencil, Trash2, ExternalLink,
  Users, CheckCircle2, FileIcon, Download,
} from "lucide-react";

export const Route = createFileRoute("/app/teacher/workshops")({ component: TeacherWorkshops });

type Course = { id: string; name: string };
type Workshop = {
  id: string; course_id: string; title: string; description: string | null;
  instructions: string | null; external_link: string | null; ai_generated: boolean;
  due_date: string | null; rubric: any; max_score: number; status: string;
  course?: { name: string };
};
type Student = { id: string; full_name: string; institutional_email: string };
type WsSub = {
  id: string; workshop_id: string; user_id: string; content: string | null;
  external_link: string | null; file_url: string | null;
  ai_grade: number | null; ai_feedback: string | null;
  final_grade: number | null; teacher_feedback: string | null; status: string;
  submitted_at: string | null;
  profile?: { full_name: string; institutional_email: string };
};

function TeacherWorkshops() {
  const { user, roles } = useAuth();
  const [courses, setCourses] = useState<Course[]>([]);
  const [workshops, setWorkshops] = useState<Workshop[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Workshop>>({});

  // Grading view
  const [gradingWs, setGradingWs] = useState<Workshop | null>(null);
  const [wsSubs, setWsSubs] = useState<WsSub[]>([]);
  const [gradingOpen, setGradingOpen] = useState(false);

  // Assignment
  const [assignWs, setAssignWs] = useState<Workshop | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [students, setStudents] = useState<Student[]>([]);
  const [assignedIds, setAssignedIds] = useState<Set<string>>(new Set());

  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  const load = async () => {
    const [{ data: cs }, { data: ws }] = await Promise.all([
      supabase.from("courses").select("id, name").order("name"),
      supabase.from("workshops").select("*, course:courses(name)").order("created_at", { ascending: false }),
    ]);
    setCourses(cs ?? []);
    setWorkshops((ws ?? []) as any);
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    setForm({
      title: "",
      course_id: courses[0]?.id,
      description: "",
      instructions: "",
      external_link: "",
      due_date: toLocal(due),
      max_score: 100,
      status: "draft",
      rubric: null,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!form.title || !form.course_id || !user) { toast.error("Completa los campos"); return; }
    const payload = {
      course_id: form.course_id,
      title: form.title,
      description: form.description ?? null,
      instructions: form.instructions ?? null,
      external_link: form.external_link || null,
      due_date: form.due_date ? new Date(form.due_date).toISOString() : null,
      max_score: Number(form.max_score) || 100,
      status: form.status ?? "draft",
      rubric: form.rubric ?? null,
      created_by: user.id,
    };

    if (form.id) {
      const { error } = await supabase.from("workshops").update(payload).eq("id", form.id);
      if (error) return toast.error(error.message);
      toast.success("Taller actualizado");
    } else {
      const { error } = await supabase.from("workshops").insert(payload);
      if (error) return toast.error(error.message);
      toast.success("Taller creado");
    }
    setOpen(false);
    load();
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar este taller?")) return;
    const { error } = await supabase.from("workshops").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Eliminado");
    load();
  };

  const openAssign = async (ws: Workshop) => {
    setAssignWs(ws);
    const [{ data: enr }, { data: asg }] = await Promise.all([
      supabase.from("course_enrollments").select("user_id").eq("course_id", ws.course_id),
      supabase.from("workshop_assignments").select("user_id").eq("workshop_id", ws.id),
    ]);
    const userIds = (enr ?? []).map((r: any) => r.user_id);
    if (userIds.length) {
      const { data: profs } = await supabase.from("profiles").select("id, full_name, institutional_email").in("id", userIds);
      setStudents((profs ?? []) as Student[]);
    } else {
      setStudents([]);
    }
    setAssignedIds(new Set((asg ?? []).map((a: any) => a.user_id)));
    setAssignOpen(true);
  };

  const toggleAssign = async (uid: string, checked: boolean) => {
    if (!assignWs) return;
    if (checked) {
      const { error } = await supabase.from("workshop_assignments").insert({ workshop_id: assignWs.id, user_id: uid });
      if (error) return toast.error(error.message);
      setAssignedIds(new Set([...assignedIds, uid]));
    } else {
      const { error } = await supabase.from("workshop_assignments").delete().eq("workshop_id", assignWs.id).eq("user_id", uid);
      if (error) return toast.error(error.message);
      const ns = new Set(assignedIds); ns.delete(uid); setAssignedIds(ns);
    }
  };

  const assignAll = async () => {
    if (!assignWs) return;
    const toAdd = students.filter(s => !assignedIds.has(s.id));
    if (!toAdd.length) return;
    const { error } = await supabase.from("workshop_assignments").insert(toAdd.map(s => ({ workshop_id: assignWs.id, user_id: s.id })));
    if (error) return toast.error(error.message);
    setAssignedIds(new Set(students.map(s => s.id)));
    toast.success("Todos asignados");
  };

  const openGrading = async (ws: Workshop) => {
    setGradingWs(ws);
    const { data: subs } = await supabase
      .from("workshop_submissions")
      .select("*")
      .eq("workshop_id", ws.id);

    if (subs?.length) {
      const userIds = subs.map((s: any) => s.user_id);
      const { data: profiles } = await supabase.from("profiles").select("id, full_name, institutional_email").in("id", userIds);
      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      setWsSubs(subs.map((s: any) => ({ ...s, profile: profileMap.get(s.user_id) })));
    } else {
      setWsSubs([]);
    }
    setGradingOpen(true);
  };

  const saveGrade = async (subId: string, grade: number, feedback: string) => {
    const { error } = await supabase.from("workshop_submissions").update({
      final_grade: grade,
      teacher_feedback: feedback,
      status: "calificado",
    }).eq("id", subId);
    if (error) return toast.error(error.message);
    toast.success("Calificación guardada");
    if (gradingWs) openGrading(gradingWs);
  };

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Talleres</h1>
          <p className="text-sm text-muted-foreground">{workshops.length} talleres creados</p>
        </div>
        <Button size="sm" onClick={openNew}><Plus className="h-4 w-4 mr-1" />Nuevo taller</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Título</TableHead>
                <TableHead>Curso</TableHead>
                <TableHead>Fecha límite</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {workshops.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No hay talleres creados aún.
                  </TableCell>
                </TableRow>
              )}
              {workshops.map(ws => (
                <TableRow key={ws.id}>
                  <TableCell className="font-medium">
                    {ws.title}
                    {ws.external_link && <ExternalLink className="inline h-3 w-3 ml-1 text-muted-foreground" />}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{ws.course?.name}</TableCell>
                  <TableCell className="text-sm">
                    {ws.due_date ? new Date(ws.due_date).toLocaleDateString() : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={ws.status === "published" ? "default" : ws.status === "closed" ? "secondary" : "outline"} className="text-[10px]">
                      {ws.status === "published" ? "Publicado" : ws.status === "closed" ? "Cerrado" : "Borrador"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right space-x-1">
                    <Button variant="ghost" size="sm" onClick={() => openAssign(ws)}>
                      <Users className="h-4 w-4 mr-1" />Asignar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openGrading(ws)}>
                      <CheckCircle2 className="h-4 w-4 mr-1" />Calificar
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setForm(ws); setOpen(true); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => remove(ws.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{form.id ? "Editar" : "Nuevo"} taller</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Título</Label><Input value={form.title ?? ""} onChange={e => setForm({ ...form, title: e.target.value })} /></div>
            <div>
              <Label>Curso</Label>
              <Select value={form.course_id} onValueChange={(v) => setForm({ ...form, course_id: v })}>
                <SelectTrigger><SelectValue placeholder="Curso" /></SelectTrigger>
                <SelectContent>{courses.map(c => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div><Label>Descripción</Label><Textarea value={form.description ?? ""} onChange={e => setForm({ ...form, description: e.target.value })} /></div>
            <div><Label>Instrucciones</Label><Textarea rows={4} value={form.instructions ?? ""} onChange={e => setForm({ ...form, instructions: e.target.value })} /></div>
            <div><Label>Link externo (opcional)</Label><Input placeholder="https://..." value={form.external_link ?? ""} onChange={e => setForm({ ...form, external_link: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Fecha límite</Label><Input type="datetime-local" value={form.due_date as any ?? ""} onChange={e => setForm({ ...form, due_date: e.target.value })} /></div>
              <div><Label>Puntaje máximo</Label><Input type="number" value={form.max_score || ""} onChange={e => setForm({ ...form, max_score: e.target.value === "" ? 0 : Number(e.target.value) })} /></div>
            </div>
            <div>
              <Label>Estado</Label>
              <Select value={form.status ?? "draft"} onValueChange={(v) => setForm({ ...form, status: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">Borrador</SelectItem>
                  <SelectItem value="published">Publicado</SelectItem>
                  <SelectItem value="closed">Cerrado</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Rúbrica de calificación IA (JSON, opcional)</Label>
              <Textarea
                rows={3}
                placeholder='[{"criterio": "Claridad", "peso": 30}, {"criterio": "Completitud", "peso": 70}]'
                value={form.rubric ? JSON.stringify(form.rubric) : ""}
                onChange={e => {
                  try { setForm({ ...form, rubric: JSON.parse(e.target.value) }); } catch { /* allow typing */ }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={save}>{form.id ? "Guardar" : "Crear"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Assignment Dialog */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Asignar — {assignWs?.title}</DialogTitle></DialogHeader>
          <div className="flex justify-end mb-2">
            <Button size="sm" variant="outline" onClick={assignAll}>Asignar a todos</Button>
          </div>
          <div className="max-h-96 overflow-y-auto space-y-1.5">
            {students.map(s => (
              <label key={s.id} className="flex items-center gap-2 p-2 rounded hover:bg-muted/50 text-sm">
                <Checkbox checked={assignedIds.has(s.id)} onCheckedChange={(v) => toggleAssign(s.id, !!v)} />
                <div className="flex-1">
                  <div className="font-medium">{s.full_name}</div>
                  <div className="text-xs text-muted-foreground">{s.institutional_email}</div>
                </div>
              </label>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* Grading Dialog */}
      <Dialog open={gradingOpen} onOpenChange={setGradingOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Calificaciones — {gradingWs?.title}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {wsSubs.length === 0 && <p className="text-sm text-muted-foreground">No hay entregas aún.</p>}
            {wsSubs.map(sub => (
              <Card key={sub.id}>
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium text-sm">{sub.profile?.full_name}</div>
                      <div className="text-xs text-muted-foreground">{sub.profile?.institutional_email}</div>
                    </div>
                    <Badge variant={sub.status === "calificado" ? "default" : sub.status === "entregado" ? "secondary" : "outline"} className="text-[10px]">
                      {sub.status === "calificado" ? "Calificado" : sub.status === "entregado" ? "Entregado" : "Pendiente"}
                    </Badge>
                  </div>
                  {sub.content && <p className="text-sm bg-muted/50 p-2 rounded">{sub.content}</p>}
                  {sub.file_url && (
                    <button
                      onClick={async () => {
                        const { data } = await supabase.storage.from("workshop-files").createSignedUrl(sub.file_url!, 3600);
                        if (data?.signedUrl) window.open(data.signedUrl, "_blank");
                        else toast.error("No se pudo generar el enlace de descarga");
                      }}
                      className="flex items-center gap-1.5 text-sm text-primary hover:underline"
                    >
                      <FileIcon className="h-3.5 w-3.5" />
                      <span className="truncate max-w-[200px]">{sub.file_url.split("/").pop()}</span>
                      <Download className="h-3 w-3 shrink-0" />
                    </button>
                  )}
                  {sub.external_link && (
                    <a href={sub.external_link} target="_blank" rel="noopener noreferrer" className="text-sm text-primary flex items-center gap-1">
                      <ExternalLink className="h-3 w-3" /> {sub.external_link}
                    </a>
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <Label className="text-xs">Nota final</Label>
                      <Input
                        type="number"
                        min={0}
                        max={gradingWs?.max_score ?? 100}
                        value={sub.final_grade ?? ""}
                        onChange={e => {
                          setWsSubs(prev => prev.map(s => s.id === sub.id ? { ...s, final_grade: e.target.value === "" ? null : Number(e.target.value) } : s));
                        }}
                        className="h-8 text-sm"
                      />
                    </div>
                    <div>
                      <Label className="text-xs">Retroalimentación</Label>
                      <Input
                        value={sub.teacher_feedback ?? ""}
                        onChange={e => {
                          setWsSubs(prev => prev.map(s => s.id === sub.id ? { ...s, teacher_feedback: e.target.value } : s));
                        }}
                        className="h-8 text-sm"
                        placeholder="Comentario..."
                      />
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => saveGrade(sub.id, sub.final_grade ?? 0, sub.teacher_feedback ?? "")}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Guardar nota
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function toLocal(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

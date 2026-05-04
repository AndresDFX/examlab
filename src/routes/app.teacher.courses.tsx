import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { BookOpen, Users, UserPlus, Trash2, Loader2, Settings2 } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/app/teacher/courses")({ component: TeacherCourses });

type Course = {
  id: string;
  name: string;
  description: string | null;
  period: string | null;
  start_date: string | null;
  end_date: string | null;
  max_exam_attempts: number;
};

type Student = { id: string; full_name: string; institutional_email: string };

function TeacherCourses() {
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Course | null>(null);
  const [enrolled, setEnrolled] = useState<Student[]>([]);
  const [allStudents, setAllStudents] = useState<Student[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [pickerIds, setPickerIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);

  // ── Evaluation config (max retries per exam) ──
  const [evalOpen, setEvalOpen] = useState(false);
  const [evalCourse, setEvalCourse] = useState<Course | null>(null);
  const [evalAllowRetries, setEvalAllowRetries] = useState(false);
  const [evalMax, setEvalMax] = useState(1);
  const [evalSaving, setEvalSaving] = useState(false);

  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  const loadCourses = async () => {
    if (!user) return;
    setLoading(true);
    // Cursos donde el docente está asignado
    const { data: links } = await supabase
      .from("course_teachers")
      .select("course_id")
      .eq("user_id", user.id);
    const ids = (links ?? []).map((l) => l.course_id);
    if (!ids.length) {
      setCourses([]);
      setLoading(false);
      return;
    }
    const { data: cs } = await supabase.from("courses").select("*").in("id", ids).order("name");
    setCourses(cs ?? []);
    setLoading(false);
  };

  const loadEnrolled = async (courseId: string) => {
    const { data: enrolls } = await supabase
      .from("course_enrollments")
      .select("user_id")
      .eq("course_id", courseId);
    const uids = (enrolls ?? []).map((e) => e.user_id);
    if (!uids.length) {
      setEnrolled([]);
      return;
    }
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, full_name, institutional_email")
      .in("id", uids)
      .order("full_name");
    setEnrolled(profs ?? []);
  };

  useEffect(() => {
    loadCourses();
  }, [user?.id]);

  const openCourse = async (c: Course) => {
    setSelected(c);
    await loadEnrolled(c.id);
  };

  const openEnroll = async () => {
    if (!selected) return;
    // Cargar todos los estudiantes
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "Estudiante");
    const studentIds = [...new Set((roleRows ?? []).map((r) => r.user_id))];
    if (!studentIds.length) {
      setAllStudents([]);
    } else {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", studentIds)
        .order("full_name");
      setAllStudents(profs ?? []);
    }
    setPickerIds(new Set(enrolled.map((e) => e.id)));
    setEnrollOpen(true);
  };

  const saveEnrollments = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const currentSet = new Set(enrolled.map((e) => e.id));
      const newSet = pickerIds;
      const toAdd = [...newSet].filter((id) => !currentSet.has(id));
      const toRemove = [...currentSet].filter((id) => !newSet.has(id));

      if (toAdd.length) {
        const { error } = await supabase
          .from("course_enrollments")
          .insert(toAdd.map((uid) => ({ course_id: selected.id, user_id: uid })));
        if (error) throw error;
      }
      if (toRemove.length) {
        const { error } = await supabase
          .from("course_enrollments")
          .delete()
          .eq("course_id", selected.id)
          .in("user_id", toRemove);
        if (error) throw error;
      }
      toast.success("Inscripciones actualizadas correctamente");
      setEnrollOpen(false);
      await loadEnrolled(selected.id);
    } catch (e: any) {
      toast.error(e.message ?? "Error al actualizar");
    } finally {
      setBusy(false);
    }
  };

  const removeOne = async (uid: string) => {
    if (!selected) return;
    const student = enrolled.find((s) => s.id === uid);
    const ok = await confirm({
      title: `Retirar a ${student?.full_name ?? "este estudiante"}`,
      description: "Se eliminará la matrícula del curso. Las entregas y calificaciones existentes no se borran.",
      confirmLabel: "Retirar",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase
      .from("course_enrollments")
      .delete()
      .eq("course_id", selected.id)
      .eq("user_id", uid);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success("Estudiante retirado correctamente");
    await loadEnrolled(selected.id);
  };

  // ── Evaluation config (max retries) ──────────────────────
  const openEval = (c: Course) => {
    setEvalCourse(c);
    const cur = Math.max(1, Number(c.max_exam_attempts ?? 1) || 1);
    setEvalAllowRetries(cur > 1);
    setEvalMax(cur > 1 ? cur : 2); // Default propuesto al activar
    setEvalOpen(true);
  };

  const saveEval = async () => {
    if (!evalCourse) return;
    setEvalSaving(true);
    const next = evalAllowRetries ? Math.max(2, Math.floor(Number(evalMax) || 2)) : 1;
    const { error } = await supabase
      .from("courses")
      .update({ max_exam_attempts: next })
      .eq("id", evalCourse.id);
    setEvalSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    toast.success(
      next > 1
        ? `Reintentos habilitados (${next} intentos máximos por examen)`
        : "Reintentos deshabilitados — los exámenes serán de un solo intento",
    );
    setEvalOpen(false);
    await loadCourses();
  };

  if (!isTeacher) return <p className="text-muted-foreground">Necesitas rol Docente.</p>;

  const filtered = allStudents.filter(
    (s) =>
      !search ||
      s.full_name.toLowerCase().includes(search.toLowerCase()) ||
      s.institutional_email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
          <BookOpen className="h-5 w-5" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cursos asignados</h1>
          <p className="text-sm text-muted-foreground">
            Gestiona los estudiantes inscritos en los cursos que tienes asignados.
          </p>
        </div>
      </div>

      {loading ? (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">Cargando…</CardContent>
        </Card>
      ) : courses.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center space-y-2">
            <BookOpen className="h-10 w-10 mx-auto text-muted-foreground/60" />
            <h3 className="font-medium">Sin cursos asignados</h3>
            <p className="text-sm text-muted-foreground">
              El administrador aún no te ha asignado a ningún curso.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {courses.map((c) => (
            <Card
              key={c.id}
              className={`cursor-pointer transition hover:border-primary/50 ${selected?.id === c.id ? "border-primary" : ""}`}
              onClick={() => openCourse(c)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{c.name}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {c.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{c.description}</p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  {c.period && (
                    <Badge variant="secondary" className="text-[10px]">
                      {c.period}
                    </Badge>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Users className="h-5 w-5 text-primary" />
                {selected.name}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {enrolled.length} estudiantes inscritos
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => openEval(selected)}>
                <Settings2 className="h-4 w-4 mr-1" /> Configurar evaluación
              </Button>
              <Button size="sm" onClick={openEnroll}>
                <UserPlus className="h-4 w-4 mr-1" /> Gestionar inscripciones
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {enrolled.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">Sin estudiantes inscritos.</div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Nombre</TableHead>
                      <TableHead className="hidden md:table-cell">Email institucional</TableHead>
                      <TableHead className="text-right">Acciones</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {enrolled.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-medium">{s.full_name}</TableCell>
                        <TableCell className="text-sm text-muted-foreground hidden md:table-cell">
                          {s.institutional_email}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="sm" onClick={() => removeOne(s.id)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Inscribir estudiantes — {selected?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">Buscar</Label>
              <Input
                placeholder="Nombre o email…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="max-h-80 overflow-y-auto border rounded-md divide-y">
              {filtered.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">Sin estudiantes.</div>
              ) : (
                filtered.map((s) => (
                  <label
                    key={s.id}
                    className="flex items-center gap-3 p-2.5 hover:bg-muted/40 cursor-pointer"
                  >
                    <Checkbox
                      checked={pickerIds.has(s.id)}
                      onCheckedChange={(v) => {
                        const next = new Set(pickerIds);
                        if (v) next.add(s.id);
                        else next.delete(s.id);
                        setPickerIds(next);
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{s.full_name}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {s.institutional_email}
                      </div>
                    </div>
                  </label>
                ))
              )}
            </div>
            <p className="text-xs text-muted-foreground">{pickerIds.size} seleccionados</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnrollOpen(false)} disabled={busy}>
              Cancelar
            </Button>
            <Button onClick={saveEnrollments} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Configurar evaluación (reintentos) ── */}
      <Dialog open={evalOpen} onOpenChange={setEvalOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Configurar evaluación — {evalCourse?.name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Esta configuración aplica por defecto a <strong>todos los exámenes</strong> creados en
              este curso. Cada examen puede sobrescribirla puntualmente desde su editor.
            </p>
            <div className="rounded-md border p-3 space-y-3">
              <label className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">Permitir reintentos en exámenes</div>
                  <div className="text-xs text-muted-foreground">
                    Útil para quices o evaluaciones formativas. Si está desactivado, cada examen es
                    de un solo intento.
                  </div>
                </div>
                <Switch
                  checked={evalAllowRetries}
                  onCheckedChange={(v) => {
                    setEvalAllowRetries(v);
                    if (v && evalMax < 2) setEvalMax(2);
                  }}
                />
              </label>
              {evalAllowRetries && (
                <div className="flex items-center justify-between gap-3 pt-2 border-t">
                  <div>
                    <div className="text-sm font-medium">Intentos máximos</div>
                    <div className="text-xs text-muted-foreground">
                      Tras alcanzar el máximo, el último intento se marca como suspendido.
                    </div>
                  </div>
                  <Input
                    type="number"
                    min={2}
                    step={1}
                    value={evalMax || ""}
                    onChange={(e) =>
                      setEvalMax(e.target.value === "" ? 2 : Math.max(2, Number(e.target.value)))
                    }
                    className="w-20 text-right"
                  />
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvalOpen(false)} disabled={evalSaving}>
              Cancelar
            </Button>
            <Button onClick={saveEval} disabled={evalSaving}>
              {evalSaving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Guardar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

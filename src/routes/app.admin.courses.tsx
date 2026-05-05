import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Users,
  Pencil,
  Copy,
  UserCog,
  Search,
  CheckSquare,
  XSquare,
  Loader2,
  Settings,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";
import { AssignSelector } from "@/components/AssignSelector";
import { DatePicker } from "@/components/ui/date-picker";
import { useDirtyDialog } from "@/hooks/use-dirty-dialog";

// grade_cuts/grade_cut_items aren't always reflected in the auto-generated types.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/admin/courses")({ component: AdminCourses });

type Course = {
  id: string;
  name: string;
  description: string | null;
  period: string | null;
  start_date: string | null;
  end_date: string | null;
  grade_scale_min: number;
  grade_scale_max: number;
  exam_weight: number;
  workshop_weight: number;
  attendance_weight: number;
  project_weight: number;
  passing_grade: number;
  max_exam_attempts: number;
};

type DraftCut = {
  // Present only when the cut already exists in the DB.
  id?: string;
  name: string;
  position: number;
  start_date: string | null;
  end_date: string | null;
  weight: number;
  exam_weight: number;
  workshop_weight: number;
  attendance_weight: number;
  project_weight: number;
};

/** Normaliza un valor de fecha (ISO timestamp o YYYY-MM-DD) a YYYY-MM-DD para inputs <date>. */
function toDateInput(value: string | null | undefined): string {
  if (!value) return "";
  // Si viene como ISO con tiempo, recorta. Si viene YYYY-MM-DD, la primera parte ya es eso.
  return value.length >= 10 ? value.slice(0, 10) : value;
}
type Profile = { id: string; full_name: string; institutional_email: string };

export function AdminCourses() {
  const { user, roles } = useAuth();
  const confirm = useConfirm();
  const [courses, setCourses] = useState<Course[]>([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Course> | null>(null);

  // Cortes evaluativos del curso en edición (en memoria; se persiste al guardar).
  const [editingCuts, setEditingCuts] = useState<DraftCut[]>([]);
  // IDs que existían al abrir el diálogo. Lo que falte al guardar se elimina.
  const [originalCutIds, setOriginalCutIds] = useState<Set<string>>(new Set());

  // Guard contra cerrar el modal sin guardar (click fuera, Escape o X).
  const courseDirty = useDirtyDialog(open, { editing, editingCuts });
  // Cortes expandidos en la UI para ver/editar sub-pesos.
  const [expandedCuts, setExpandedCuts] = useState<Set<number>>(new Set());

  // Enrollment
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [enrollCourse, setEnrollCourse] = useState<Course | null>(null);
  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [enrolledIds, setEnrolledIds] = useState<Set<string>>(new Set());
  const [enrollSearch, setEnrollSearch] = useState("");

  // Teacher assignment
  const [teacherOpen, setTeacherOpen] = useState(false);
  const [teacherCourse, setTeacherCourse] = useState<Course | null>(null);
  const [teachers, setTeachers] = useState<Profile[]>([]);
  const [assignedTeacherIds, setAssignedTeacherIds] = useState<Set<string>>(new Set());

  // Duplicate
  const [dupOpen, setDupOpen] = useState(false);
  const [dupSource, setDupSource] = useState<Course | null>(null);
  const [dupName, setDupName] = useState("");
  const [dupPeriod, setDupPeriod] = useState("");
  const [dupCopyExams, setDupCopyExams] = useState(true);
  const [dupCopyWorkshops, setDupCopyWorkshops] = useState(true);
  const [dupCopyStudents, setDupCopyStudents] = useState(false);
  // Por defecto NO copiar docentes (opt-in).
  const [dupCopyTeachers, setDupCopyTeachers] = useState(false);
  const [dupLoading, setDupLoading] = useState(false);

  const isAdmin = roles.includes("Admin");
  const isTeacher = roles.includes("Docente");
  // Docente tiene los mismos privilegios que Admin para gestionar
  // cursos, EXCEPTO auto-asignarse en course_teachers (lo bloquea
  // tanto la RLS como el filtro del dialog de docentes más abajo).
  const canManage = isAdmin || isTeacher;

  const load = async () => {
    const { data } = await supabase
      .from("courses")
      .select("*")
      .order("period", { ascending: false, nullsFirst: false })
      .order("name");
    setCourses((data ?? []) as Course[]);
  };
  useEffect(() => {
    load();
  }, []);

  // ── Course CRUD ──────────────────────────────────────────

  const openNew = () => {
    setEditing({
      id: "",
      name: "",
      description: "",
      period: "",
      start_date: "",
      end_date: "",
      grade_scale_min: 0,
      grade_scale_max: 5,
      exam_weight: 40,
      workshop_weight: 30,
      attendance_weight: 10,
      project_weight: 20,
      passing_grade: 3,
      max_exam_attempts: 1,
    });
    setEditingCuts([]);
    setOriginalCutIds(new Set());
    setExpandedCuts(new Set());
    setOpen(true);
  };

  /** Carga los cortes existentes del curso al abrir el diálogo en modo edición. */
  const openEdit = async (c: Course) => {
    setEditing({
      ...c,
      start_date: toDateInput(c.start_date),
      end_date: toDateInput(c.end_date),
    });
    const { data: cuts } = await db
      .from("grade_cuts")
      .select("*")
      .eq("course_id", c.id)
      .order("position");
    const list = ((cuts ?? []) as DraftCut[]).map((x) => ({
      id: x.id,
      name: x.name,
      position: x.position,
      start_date: x.start_date,
      end_date: x.end_date,
      weight: Number(x.weight ?? 0),
      exam_weight: Number(x.exam_weight ?? 0),
      workshop_weight: Number(x.workshop_weight ?? 0),
      attendance_weight: Number(x.attendance_weight ?? 0),
      project_weight: Number(x.project_weight ?? 0),
    }));
    setEditingCuts(list);
    setOriginalCutIds(new Set(list.map((x) => x.id!).filter(Boolean)));
    setExpandedCuts(new Set());
    setOpen(true);
  };

  /** Crea un corte vacío con defaults razonables. */
  const makeEmptyCut = (position: number, n: number): DraftCut => ({
    name: `Corte ${position + 1}`,
    position,
    start_date: null,
    end_date: null,
    weight: n > 0 ? Math.round(100 / n) : 0,
    exam_weight: 40,
    workshop_weight: 30,
    attendance_weight: 10,
    project_weight: 20,
  });

  /** Cambia el número total de cortes. Pide confirmación si se reduce y hay items. */
  const handleCutCountChange = async (next: number) => {
    const target = Math.max(0, Math.min(20, Math.floor(next || 0)));
    const current = editingCuts.length;
    if (target === current) return;

    if (target > current) {
      // Aumentar: agregar cortes vacíos al final.
      const additions: DraftCut[] = [];
      for (let i = current; i < target; i++) additions.push(makeEmptyCut(i, target));
      setEditingCuts([...editingCuts, ...additions]);
      return;
    }

    // Reducir: revisar si los cortes a eliminar (ya en BD) tienen items.
    const toRemove = editingCuts.slice(target);
    const idsInDb = toRemove.map((c) => c.id).filter(Boolean) as string[];
    let itemsCount = 0;
    if (idsInDb.length) {
      const { count } = await db
        .from("grade_cut_items")
        .select("id", { count: "exact", head: true })
        .in("cut_id", idsInDb);
      itemsCount = count ?? 0;
    }
    const ok = await confirm({
      title: `Reducir cortes a ${target}`,
      description:
        itemsCount > 0
          ? `Se eliminarán ${toRemove.length} corte(s) y ${itemsCount} item(s) asociado(s). Esta acción se aplica al guardar y no se puede deshacer.`
          : `Se eliminarán ${toRemove.length} corte(s). Esta acción se aplica al guardar.`,
      confirmLabel: "Reducir",
      tone: "destructive",
    });
    if (!ok) return;
    setEditingCuts(editingCuts.slice(0, target));
    setExpandedCuts(new Set());
  };

  /** Aplica un parche a un corte por índice. */
  const updateDraftCut = (index: number, patch: Partial<DraftCut>) => {
    setEditingCuts((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  /** Toggle expand/collapse para los sub-pesos. */
  const toggleExpand = (index: number) => {
    setExpandedCuts((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const save = async () => {
    if (!editing?.name?.trim()) {
      toast.error("Nombre requerido");
      return;
    }
    const startInput = toDateInput(editing.start_date);
    const endInput = toDateInput(editing.end_date);
    if (startInput && endInput && startInput > endInput) {
      toast.error("La fecha de fin debe ser posterior a la fecha de inicio");
      return;
    }
    const payload = {
      name: editing.name,
      description: editing.description || null,
      period: editing.period || null,
      start_date: startInput || null,
      end_date: endInput || null,
      grade_scale_min: Number(editing.grade_scale_min ?? 0),
      grade_scale_max: Number(editing.grade_scale_max ?? 5),
      exam_weight: Number(editing.exam_weight ?? 40),
      workshop_weight: Number(editing.workshop_weight ?? 30),
      attendance_weight: Number(editing.attendance_weight ?? 10),
      project_weight: Number(editing.project_weight ?? 20),
      passing_grade: Number(editing.passing_grade ?? 3),
      max_exam_attempts: Math.max(1, Number(editing.max_exam_attempts ?? 1)),
    };
    let courseId = editing.id ?? "";
    if (editing.id) {
      const { error } = await supabase.from("courses").update(payload).eq("id", editing.id);
      if (error) return toast.error(error.message);
    } else {
      const { data: created, error } = await supabase
        .from("courses")
        .insert(payload)
        .select("id")
        .single();
      if (error || !created) return toast.error(error?.message ?? "Error creando curso");
      courseId = created.id as string;
    }

    // ── Persistencia de cortes evaluativos ──
    try {
      // 1) Eliminar cortes que estaban en la BD pero ya no en editingCuts.
      const currentIds = new Set(editingCuts.map((c) => c.id).filter(Boolean) as string[]);
      const toDelete = [...originalCutIds].filter((id) => !currentIds.has(id));
      if (toDelete.length) {
        // Borrar primero los items (no asumimos cascade en la FK).
        await db.from("grade_cut_items").delete().in("cut_id", toDelete);
        const { error: delErr } = await db.from("grade_cuts").delete().in("id", toDelete);
        if (delErr) throw delErr;
      }

      // 2) Actualizar/insertar el resto.
      for (let i = 0; i < editingCuts.length; i++) {
        const c = editingCuts[i];
        const cutPayload = {
          course_id: courseId,
          name: c.name?.trim() || `Corte ${i + 1}`,
          position: i,
          start_date: c.start_date || null,
          end_date: c.end_date || null,
          weight: Number(c.weight || 0),
          exam_weight: Number(c.exam_weight || 0),
          workshop_weight: Number(c.workshop_weight || 0),
          attendance_weight: Number(c.attendance_weight || 0),
          project_weight: Number(c.project_weight || 0),
        };
        if (c.id) {
          const { error } = await db.from("grade_cuts").update(cutPayload).eq("id", c.id);
          if (error) throw error;
        } else {
          const { error } = await db.from("grade_cuts").insert(cutPayload);
          if (error) throw error;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Curso guardado, pero falló la sincronización de cortes: ${msg}`);
      setOpen(false);
      setEditing(null);
      setEditingCuts([]);
      setOriginalCutIds(new Set());
      load();
      return;
    }

    toast.success("Curso guardado correctamente");
    setOpen(false);
    setEditing(null);
    setEditingCuts([]);
    setOriginalCutIds(new Set());
    load();
  };

  const remove = async (id: string) => {
    const ok = await confirm({
      title: "Eliminar curso",
      description:
        "Se eliminarán también las matrículas, exámenes y talleres asociados. Esta acción no se puede deshacer.",
      confirmLabel: "Eliminar curso",
      tone: "destructive",
    });
    if (!ok) return;
    const { error } = await supabase.from("courses").delete().eq("id", id);
    if (error) return toast.error(error.message);
    toast.success("Curso eliminado correctamente");
    load();
  };

  // ── Student Enrollment ───────────────────────────────────

  const openEnroll = async (c: Course) => {
    setEnrollCourse(c);
    setEnrollSearch("");
    const [{ data: profs }, { data: enr }] = await Promise.all([
      supabase.from("profiles").select("id, full_name, institutional_email").order("full_name"),
      supabase.from("course_enrollments").select("user_id").eq("course_id", c.id),
    ]);
    setAllProfiles(profs ?? []);
    setEnrolledIds(new Set((enr ?? []).map((e: any) => e.user_id)));
    setEnrollOpen(true);
  };

  const filteredProfiles = useMemo(() => {
    if (!enrollSearch.trim()) return allProfiles;
    const q = enrollSearch.toLowerCase();
    return allProfiles.filter(
      (p) =>
        p.full_name.toLowerCase().includes(q) || p.institutional_email.toLowerCase().includes(q),
    );
  }, [allProfiles, enrollSearch]);

  const toggleEnroll = async (uid: string, checked: boolean) => {
    if (!enrollCourse) return;
    if (checked) {
      const { error } = await supabase
        .from("course_enrollments")
        .upsert({ course_id: enrollCourse.id, user_id: uid }, { onConflict: "course_id,user_id", ignoreDuplicates: true });
      if (error) return toast.error(error.message);
      setEnrolledIds((prev) => new Set([...prev, uid]));
      toast.success("Estudiante matriculado correctamente");
    } else {
      const { error } = await supabase
        .from("course_enrollments")
        .delete()
        .eq("course_id", enrollCourse.id)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      setEnrolledIds((prev) => {
        const s = new Set(prev);
        s.delete(uid);
        return s;
      });
      toast.success("Estudiante desmatriculado correctamente");
    }
  };

  const enrollMany = async (visibleIds: string[]) => {
    if (!enrollCourse) return;
    const toAdd = visibleIds.filter((id) => !enrolledIds.has(id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("course_enrollments")
      .insert(toAdd.map((id) => ({ course_id: enrollCourse.id, user_id: id })));
    if (error) return toast.error(error.message);
    setEnrolledIds((prev) => new Set([...prev, ...toAdd]));
    toast.success(`${toAdd.length} estudiante(s) matriculados correctamente`);
  };

  const unenrollMany = async (visibleIds: string[]) => {
    if (!enrollCourse) return;
    const toRemove = visibleIds.filter((id) => enrolledIds.has(id));
    if (!toRemove.length) return;
    for (const id of toRemove) {
      await supabase
        .from("course_enrollments")
        .delete()
        .eq("course_id", enrollCourse.id)
        .eq("user_id", id);
    }
    setEnrolledIds((prev) => {
      const s = new Set(prev);
      toRemove.forEach((id) => s.delete(id));
      return s;
    });
    toast.success(`${toRemove.length} estudiante(s) desmatriculados correctamente`);
  };

  // ── Teacher Assignment ───────────────────────────────────

  const openTeachers = async (c: Course) => {
    setTeacherCourse(c);
    // Get all users with Docente role
    const { data: roleRows } = await supabase
      .from("user_roles")
      .select("user_id")
      .eq("role", "Docente");
    const teacherIds = (roleRows ?? []).map((r: any) => r.user_id);
    if (teacherIds.length) {
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", teacherIds)
        .order("full_name");
      setTeachers((profs ?? []) as Profile[]);
    } else {
      setTeachers([]);
    }
    const { data: assigned } = await supabase
      .from("course_teachers")
      .select("user_id")
      .eq("course_id", c.id);
    setAssignedTeacherIds(new Set((assigned ?? []).map((a: any) => a.user_id)));
    setTeacherOpen(true);
  };

  const toggleTeacher = async (uid: string, checked: boolean) => {
    if (!teacherCourse) return;
    if (checked) {
      const { error } = await supabase
        .from("course_teachers")
        .insert({ course_id: teacherCourse.id, user_id: uid });
      if (error) return toast.error(error.message);
      setAssignedTeacherIds((prev) => new Set([...prev, uid]));
      toast.success("Docente asignado correctamente");
    } else {
      const { error } = await supabase
        .from("course_teachers")
        .delete()
        .eq("course_id", teacherCourse.id)
        .eq("user_id", uid);
      if (error) return toast.error(error.message);
      setAssignedTeacherIds((prev) => {
        const s = new Set(prev);
        s.delete(uid);
        return s;
      });
      toast.success("Docente desasignado correctamente");
    }
  };

  const assignTeachersMany = async (visibleIds: string[]) => {
    if (!teacherCourse) return;
    const toAdd = visibleIds.filter((id) => !assignedTeacherIds.has(id));
    if (!toAdd.length) return;
    const { error } = await supabase
      .from("course_teachers")
      .insert(toAdd.map((id) => ({ course_id: teacherCourse.id, user_id: id })));
    if (error) return toast.error(error.message);
    setAssignedTeacherIds((prev) => new Set([...prev, ...toAdd]));
    toast.success(`${toAdd.length} docente(s) asignados correctamente`);
  };

  const unassignTeachersMany = async (visibleIds: string[]) => {
    if (!teacherCourse) return;
    const toRemove = visibleIds.filter((id) => assignedTeacherIds.has(id));
    if (!toRemove.length) return;
    for (const id of toRemove) {
      await supabase
        .from("course_teachers")
        .delete()
        .eq("course_id", teacherCourse.id)
        .eq("user_id", id);
    }
    setAssignedTeacherIds((prev) => {
      const s = new Set(prev);
      toRemove.forEach((id) => s.delete(id));
      return s;
    });
    toast.success(`${toRemove.length} docente(s) desasignados correctamente`);
  };

  // ── Duplicate Course ─────────────────────────────────────

  const openDuplicate = (c: Course) => {
    setDupSource(c);
    setDupName(`${c.name} (copia)`);
    setDupPeriod(c.period ?? "");
    setDupCopyExams(true);
    setDupCopyWorkshops(true);
    setDupCopyStudents(true);
    setDupCopyTeachers(false); // opt-in
    setDupOpen(true);
  };

  const doDuplicate = async () => {
    if (!dupSource || !dupName.trim()) {
      toast.error("Nombre requerido");
      return;
    }
    setDupLoading(true);
    let copiedStudents = 0;
    try {
      // 1. Create new course
      const { data: newCourse, error: cErr } = await supabase
        .from("courses")
        .insert({
          name: dupName,
          description: dupSource.description,
          period: dupPeriod || null,
          start_date: toDateInput(dupSource.start_date) || null,
          end_date: toDateInput(dupSource.end_date) || null,
          grade_scale_min: dupSource.grade_scale_min,
          grade_scale_max: dupSource.grade_scale_max,
          passing_grade: dupSource.passing_grade,
          exam_weight: dupSource.exam_weight,
          workshop_weight: dupSource.workshop_weight,
          attendance_weight: dupSource.attendance_weight,
          project_weight: dupSource.project_weight ?? 0,
          max_exam_attempts: dupSource.max_exam_attempts ?? 1,
        })
        .select()
        .single();
      if (cErr || !newCourse) throw new Error(cErr?.message ?? "Error creando curso");

      // 2. Copy students (CRÍTICO: replicar todas las matrículas)
      if (dupCopyStudents) {
        const { data: enr, error: enrErr } = await supabase
          .from("course_enrollments")
          .select("user_id")
          .eq("course_id", dupSource.id);
        if (enrErr) console.error("read enrollments:", enrErr);
        if (enr?.length) {
          const rows = enr.map((e: any) => ({ course_id: newCourse.id, user_id: e.user_id }));
          const { error: insErr, count } = await supabase
            .from("course_enrollments")
            .insert(rows, { count: "exact" });
          if (insErr) {
            console.error("copy enrollments:", insErr);
            toast.error(`No se pudieron copiar las matrículas: ${insErr.message}`);
          } else {
            copiedStudents = count ?? rows.length;
          }
        }
      }

      // 3. Copy teachers (opt-in)
      if (dupCopyTeachers) {
        const { data: ct } = await supabase
          .from("course_teachers")
          .select("user_id")
          .eq("course_id", dupSource.id);
        if (ct?.length) {
          await supabase
            .from("course_teachers")
            .insert(ct.map((t: any) => ({ course_id: newCourse.id, user_id: t.user_id })));
        }
      }

      // 4. Copy exams (without submissions/assignments)
      if (dupCopyExams) {
        const { data: exams } = await supabase
          .from("exams")
          .select("*")
          .eq("course_id", dupSource.id);
        for (const exam of exams ?? []) {
          const { data: newExam } = await supabase
            .from("exams")
            .insert({
              course_id: newCourse.id,
              created_by: exam.created_by,
              title: exam.title,
              description: exam.description,
              start_time: exam.start_time,
              end_time: exam.end_time,
              time_limit_minutes: exam.time_limit_minutes,
              navigation_type: exam.navigation_type,
              shuffle_enabled: exam.shuffle_enabled,
              max_attempts: (exam as any).max_attempts ?? null,
            })
            .select()
            .single();
          if (newExam) {
            // Copy questions
            const { data: qs } = await supabase
              .from("questions")
              .select("*")
              .eq("exam_id", exam.id);
            if (qs?.length) {
              await supabase.from("questions").insert(
                qs.map((q: any) => ({
                  exam_id: newExam.id,
                  type: q.type,
                  content: q.content,
                  expected_rubric: q.expected_rubric,
                  options: q.options,
                  points: q.points,
                  position: q.position,
                  language: q.language,
                  starter_code: q.starter_code,
                  test_cases: q.test_cases,
                })),
              );
            }
          }
        }
      }

      // 5. Copy workshops (without submissions/assignments)
      if (dupCopyWorkshops) {
        const { data: ws } = await supabase
          .from("workshops")
          .select("*")
          .eq("course_id", dupSource.id);
        if (ws?.length) {
          await supabase.from("workshops").insert(
            ws.map((w: any) => ({
              course_id: newCourse.id,
              created_by: w.created_by,
              title: w.title,
              description: w.description,
              instructions: w.instructions,
              external_link: w.external_link,
              due_date: w.due_date,
              rubric: w.rubric,
              max_score: w.max_score,
              status: "draft",
            })),
          );
        }
      }

      const studentsMsg = dupCopyStudents
        ? ` (${copiedStudents} estudiante${copiedStudents === 1 ? "" : "s"} copiado${copiedStudents === 1 ? "" : "s"})`
        : "";
      toast.success(`Curso duplicado correctamente${studentsMsg}`);
      setDupOpen(false);
      load();
    } catch (e: any) {
      toast.error(e.message ?? "Error al duplicar");
    } finally {
      setDupLoading(false);
    }
  };

  // ── Grading Weights ──────────────────────────────────────

  const [weightsOpen, setWeightsOpen] = useState(false);
  const [weightsCourse, setWeightsCourse] = useState<Course | null>(null);
  const [weights, setWeights] = useState<{ component: string; weight: number }[]>([]);
  const [newComponent, setNewComponent] = useState("");

  const openWeights = async (c: Course) => {
    setWeightsCourse(c);
    const { data } = await supabase
      .from("course_grading_weights")
      .select("component, weight")
      .eq("course_id", c.id)
      .order("component");
    const items = (data ?? []) as { component: string; weight: number }[];
    // Ensure default components exist
    const defaults = ["asistencia", "talleres", "parciales"];
    defaults.forEach((d) => {
      if (!items.find((i) => i.component === d)) items.push({ component: d, weight: 0 });
    });
    setWeights(items);
    setWeightsOpen(true);
  };

  const updateWeight = (component: string, value: number) => {
    setWeights((prev) =>
      prev.map((w) => (w.component === component ? { ...w, weight: value } : w)),
    );
  };

  const addComponent = () => {
    if (!newComponent.trim()) return;
    const name = newComponent.trim().toLowerCase();
    if (weights.find((w) => w.component === name)) {
      toast.error("Ya existe ese componente");
      return;
    }
    setWeights((prev) => [...prev, { component: name, weight: 0 }]);
    setNewComponent("");
  };

  const removeComponent = (component: string) => {
    setWeights((prev) => prev.filter((w) => w.component !== component));
  };

  const saveWeights = async () => {
    if (!weightsCourse) return;
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    if (total !== 100 && total !== 0) {
      toast.error(`Los pesos suman ${total}%. Deben sumar 100%.`);
      return;
    }
    // Delete existing and re-insert
    await supabase.from("course_grading_weights").delete().eq("course_id", weightsCourse.id);
    if (weights.filter((w) => w.weight > 0).length) {
      const { error } = await supabase.from("course_grading_weights").insert(
        weights
          .filter((w) => w.weight > 0)
          .map((w) => ({
            course_id: weightsCourse.id,
            component: w.component,
            weight: w.weight,
          })),
      );
      if (error) {
        toast.error(error.message);
        return;
      }
    }
    toast.success("Pesos de calificación guardados correctamente");
    setWeightsOpen(false);
  };

  if (!canManage)
    return (
      <p className="text-muted-foreground">Necesitas rol Admin o Docente.</p>
    );

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
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Nombre</TableHead>
                <TableHead className="hidden sm:table-cell">Periodo</TableHead>
                <TableHead className="hidden sm:table-cell">Escala</TableHead>
                <TableHead className="hidden md:table-cell">Fechas</TableHead>
                <TableHead className="hidden lg:table-cell">Descripción</TableHead>
                <TableHead className="text-right">Acciones</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {courses.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                    No hay cursos creados.
                  </TableCell>
                </TableRow>
              )}
              {courses.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-1">
                      <span>{c.name}</span>
                      {c.period && (
                        <Badge variant="outline" className="text-[10px] w-fit sm:hidden">
                          {c.period}
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {c.period ? (
                      <Badge variant="outline" className="text-xs">
                        {c.period}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <div className="text-xs tabular-nums">
                      <span className="font-medium">
                        {c.grade_scale_min}–{c.grade_scale_max}
                      </span>
                      <span className="text-muted-foreground ml-1">(≥{c.passing_grade})</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                    {c.start_date && c.end_date
                      ? `${new Date(c.start_date + "T00:00").toLocaleDateString()} → ${new Date(c.end_date + "T00:00").toLocaleDateString()}`
                      : c.start_date
                        ? `Desde ${new Date(c.start_date + "T00:00").toLocaleDateString()}`
                        : "—"}
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden lg:table-cell max-w-48 truncate">
                    {c.description ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openWeights(c)}
                        title="Pesos de calificación"
                      >
                        <Settings className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEnroll(c)}
                        title="Estudiantes"
                      >
                        <Users className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openTeachers(c)}
                        title="Docentes"
                      >
                        <UserCog className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDuplicate(c)}
                        title="Duplicar"
                      >
                        <Copy className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openEdit(c)}
                        title="Editar"
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(c.id)}
                        title="Eliminar"
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* ── Create/Edit Dialog ── */}
      <Dialog open={open} onOpenChange={courseDirty.guardOpenChange(setOpen)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing?.id ? "Editar" : "Nuevo"} curso</DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="space-y-3">
              <div>
                <Label>Nombre</Label>
                <Input
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  placeholder="Ej: Programación II"
                />
              </div>
              <div>
                <Label>Periodo</Label>
                <Input
                  value={editing.period ?? ""}
                  onChange={(e) => setEditing({ ...editing, period: e.target.value })}
                  placeholder="Ej: 2026-1"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label>Fecha inicio</Label>
                  <DatePicker
                    value={toDateInput(editing.start_date) ?? ""}
                    onChange={(v) => setEditing({ ...editing, start_date: v || null })}
                  />
                </div>
                <div>
                  <Label>Fecha fin</Label>
                  <DatePicker
                    value={toDateInput(editing.end_date) ?? ""}
                    onChange={(v) => setEditing({ ...editing, end_date: v || null })}
                  />
                </div>
              </div>
              <div>
                <Label>Descripción</Label>
                <Textarea
                  value={editing.description ?? ""}
                  onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                />
              </div>

              <div className="rounded-md border p-3 space-y-3">
                <p className="text-sm font-medium">Escala de calificación</p>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs">Calificación mínima</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.grade_scale_min ?? 0}
                      onChange={(e) =>
                        setEditing({ ...editing, grade_scale_min: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Calificación máxima</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.grade_scale_max ?? 5}
                      onChange={(e) =>
                        setEditing({ ...editing, grade_scale_max: Number(e.target.value) })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Aprobar ≥</Label>
                    <Input
                      type="number"
                      step="0.1"
                      value={editing.passing_grade ?? 3}
                      onChange={(e) =>
                        setEditing({ ...editing, passing_grade: Number(e.target.value) })
                      }
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <div>
                    <Label className="text-xs">Peso exámenes (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={editing.exam_weight || ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          exam_weight: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Peso talleres (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={editing.workshop_weight || ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          workshop_weight: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Peso asistencia (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={editing.attendance_weight || ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          attendance_weight: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Peso proyecto (%)</Label>
                    <Input
                      type="number"
                      step="1"
                      value={editing.project_weight || ""}
                      onChange={(e) =>
                        setEditing({
                          ...editing,
                          project_weight: e.target.value === "" ? 0 : Number(e.target.value),
                        })
                      }
                    />
                  </div>
                </div>
                {(() => {
                  const total =
                    (editing.exam_weight ?? 0) +
                    (editing.workshop_weight ?? 0) +
                    (editing.attendance_weight ?? 0) +
                    (editing.project_weight ?? 0);
                  return (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-muted-foreground">
                        Total de pesos: debe sumar 100%
                      </p>
                      <Badge
                        variant={total === 100 ? "default" : "destructive"}
                        className="text-xs"
                      >
                        {total}%
                      </Badge>
                    </div>
                  );
                })()}

                {/* ── Cortes evaluativos (inline, en memoria) ── */}
                <div className="rounded-md border p-3 space-y-3">
                  <div className="flex flex-wrap items-end justify-between gap-2">
                    <div>
                      <Label className="text-xs">Cantidad de cortes</Label>
                      <p className="text-[11px] text-muted-foreground">
                        Define cuántos cortes evaluativos tiene este curso. 0 = sin cortes.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={0}
                        max={20}
                        className="w-20 text-right"
                        value={editingCuts.length}
                        onChange={(e) => {
                          const v = e.target.value === "" ? 0 : Number(e.target.value);
                          void handleCutCountChange(v);
                        }}
                      />
                      {editingCuts.length > 0 &&
                        (() => {
                          const sumCuts = editingCuts.reduce(
                            (a, c) => a + Number(c.weight || 0),
                            0,
                          );
                          return (
                            <Badge
                              variant={sumCuts === 100 ? "default" : "destructive"}
                              className="text-xs"
                            >
                              Total: {sumCuts}%
                            </Badge>
                          );
                        })()}
                    </div>
                  </div>

                  {editingCuts.length === 0 && (
                    <p className="text-xs text-muted-foreground italic">
                      Sin cortes configurados.
                    </p>
                  )}

                  <div
                    className={`space-y-2 ${editingCuts.length > 3 ? "max-h-[40vh] overflow-y-auto pr-1" : ""}`}
                  >
                    {editingCuts.map((cut, idx) => {
                      const subSum =
                        Number(cut.exam_weight || 0) +
                        Number(cut.workshop_weight || 0) +
                        Number(cut.attendance_weight || 0) +
                        Number(cut.project_weight || 0);
                      const isOpen = expandedCuts.has(idx);
                      return (
                        <div
                          key={cut.id ?? `new-${idx}`}
                          className="rounded border bg-muted/30 p-2 space-y-2 min-w-0"
                        >
                          {/* Fila 1: chevron + nombre (siempre full width en mobile) */}
                          <div className="flex items-center gap-2 min-w-0">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => toggleExpand(idx)}
                              className="h-8 w-8 p-0 shrink-0"
                              title={isOpen ? "Ocultar sub-pesos" : "Ver sub-pesos"}
                            >
                              {isOpen ? (
                                <ChevronDown className="h-4 w-4" />
                              ) : (
                                <ChevronRight className="h-4 w-4" />
                              )}
                            </Button>
                            <Input
                              value={cut.name}
                              onChange={(e) => updateDraftCut(idx, { name: e.target.value })}
                              placeholder={`Corte ${idx + 1}`}
                              className="min-w-0 flex-1"
                            />
                          </div>
                          {/* Fila 2: fechas + peso (3 columnas desde sm) */}
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 min-w-0">
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">Inicio</Label>
                              <DatePicker
                                value={cut.start_date ?? ""}
                                onChange={(v) => updateDraftCut(idx, { start_date: v || null })}
                                className="min-w-0 w-full"
                              />
                            </div>
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">Fin</Label>
                              <DatePicker
                                value={cut.end_date ?? ""}
                                onChange={(v) => updateDraftCut(idx, { end_date: v || null })}
                                className="min-w-0 w-full"
                              />
                            </div>
                            <div className="min-w-0">
                              <Label className="text-[10px] text-muted-foreground">Peso %</Label>
                              <Input
                                type="number"
                                min={0}
                                max={100}
                                value={cut.weight || ""}
                                onChange={(e) =>
                                  updateDraftCut(idx, {
                                    weight: e.target.value === "" ? 0 : Number(e.target.value),
                                  })
                                }
                                placeholder="0-100"
                                className="min-w-0 w-full"
                              />
                            </div>
                          </div>

                          {isOpen && (
                            <div className="space-y-2 rounded bg-background p-2 min-w-0">
                              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 min-w-0">
                                <div className="min-w-0">
                                  <Label className="text-xs">Talleres %</Label>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={cut.workshop_weight || ""}
                                    onChange={(e) =>
                                      updateDraftCut(idx, {
                                        workshop_weight:
                                          e.target.value === "" ? 0 : Number(e.target.value),
                                      })
                                    }
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-xs">Exámenes %</Label>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={cut.exam_weight || ""}
                                    onChange={(e) =>
                                      updateDraftCut(idx, {
                                        exam_weight:
                                          e.target.value === "" ? 0 : Number(e.target.value),
                                      })
                                    }
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-xs">Proyectos %</Label>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={cut.project_weight || ""}
                                    onChange={(e) =>
                                      updateDraftCut(idx, {
                                        project_weight:
                                          e.target.value === "" ? 0 : Number(e.target.value),
                                      })
                                    }
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                                <div className="min-w-0">
                                  <Label className="text-xs">Asistencia %</Label>
                                  <Input
                                    type="number"
                                    min={0}
                                    max={100}
                                    value={cut.attendance_weight || ""}
                                    onChange={(e) =>
                                      updateDraftCut(idx, {
                                        attendance_weight:
                                          e.target.value === "" ? 0 : Number(e.target.value),
                                      })
                                    }
                                    className="h-8 min-w-0 w-full"
                                  />
                                </div>
                              </div>
                              <div className="flex items-center justify-end">
                                <Badge
                                  variant={subSum === 100 ? "secondary" : "destructive"}
                                  className="text-xs"
                                >
                                  Sub-pesos: {subSum}%
                                </Badge>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>

              {/* ── Reintentos por examen ── */}
              <div className="rounded-md border p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Intentos por examen</p>
                    <p className="text-xs text-muted-foreground">
                      Número máximo de veces que un estudiante puede presentar un examen de este
                      curso (útil para quices). Al superar el límite, el último intento queda
                      registrado y el examen se marca como suspendido.
                    </p>
                  </div>
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    className="w-20 text-right"
                    value={editing.max_exam_attempts ?? 1}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        max_exam_attempts: Math.max(1, Number(e.target.value) || 1),
                      })
                    }
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Cada examen creado en este curso heredará este valor por defecto. Puedes ajustarlo
                  individualmente desde el editor del examen.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={save}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Student Enrollment Dialog ── */}
      <Dialog open={enrollOpen} onOpenChange={setEnrollOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Estudiantes — {enrollCourse?.name}</DialogTitle>
          </DialogHeader>
          <AssignSelector
            items={allProfiles}
            selectedIds={enrolledIds}
            onToggle={toggleEnroll}
            onSelectAll={enrollMany}
            onDeselectAll={unenrollMany}
            selectedLabel="Matriculado"
            countNoun="matriculados"
          />
        </DialogContent>
      </Dialog>

      {/* ── Teacher Assignment Dialog ── */}
      <Dialog open={teacherOpen} onOpenChange={setTeacherOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Docentes — {teacherCourse?.name}</DialogTitle>
          </DialogHeader>
          <AssignSelector
            // Un Docente no puede auto-asignarse: filtramos su propia
            // fila del listado. La RLS lo bloquearía igual, esto solo
            // evita ver un checkbox que se tropieza con error.
            items={isAdmin ? teachers : teachers.filter((t) => t.id !== user?.id)}
            selectedIds={assignedTeacherIds}
            onToggle={toggleTeacher}
            onSelectAll={assignTeachersMany}
            onDeselectAll={unassignTeachersMany}
            emptyText={
              isAdmin
                ? "No hay usuarios con rol Docente."
                : "No hay otros docentes para asignar a este curso."
            }
            countNoun="asignados"
          />
          {!isAdmin && (
            <p className="text-[11px] text-muted-foreground">
              No puedes asignarte a ti mismo a un curso. Si necesitas estar
              en este curso, pídele a un Admin que te agregue.
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Duplicate Course Dialog ── */}
      <Dialog open={dupOpen} onOpenChange={setDupOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Duplicar curso</DialogTitle>
          </DialogHeader>
          {dupSource && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Creará una copia de <strong>{dupSource.name}</strong> con la configuración
                seleccionada.
              </p>
              <div>
                <Label>Nombre del nuevo curso</Label>
                <Input value={dupName} onChange={(e) => setDupName(e.target.value)} />
              </div>
              <div>
                <Label>Periodo</Label>
                <Input
                  value={dupPeriod}
                  onChange={(e) => setDupPeriod(e.target.value)}
                  placeholder="Ej: 2026-2"
                />
              </div>
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-sm font-medium">¿Qué copiar?</p>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Exámenes y preguntas</div>
                    <div className="text-xs text-muted-foreground">
                      Se copian como borrador sin asignaciones
                    </div>
                  </div>
                  <Switch checked={dupCopyExams} onCheckedChange={setDupCopyExams} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Talleres</div>
                    <div className="text-xs text-muted-foreground">
                      Se copian como borrador sin entregas
                    </div>
                  </div>
                  <Switch checked={dupCopyWorkshops} onCheckedChange={setDupCopyWorkshops} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Estudiantes matriculados</div>
                    <div className="text-xs text-muted-foreground">
                      Copia las matrículas al nuevo curso
                    </div>
                  </div>
                  <Switch checked={dupCopyStudents} onCheckedChange={setDupCopyStudents} />
                </label>
                <label className="flex items-center justify-between">
                  <div>
                    <div className="text-sm">Docentes asignados</div>
                    <div className="text-xs text-muted-foreground">
                      Por defecto desactivado — habilita para clonar también el equipo docente
                    </div>
                  </div>
                  <Switch checked={dupCopyTeachers} onCheckedChange={setDupCopyTeachers} />
                </label>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDupOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={doDuplicate} disabled={dupLoading}>
              {dupLoading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Copy className="h-4 w-4 mr-1" />
              )}
              Duplicar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Grading Weights Dialog ── */}
      <Dialog open={weightsOpen} onOpenChange={setWeightsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Pesos de calificación — {weightsCourse?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Define qué porcentaje del 100% corresponde a cada componente.
          </p>
          <div className="space-y-2">
            {weights.map((w) => (
              <div key={w.component} className="flex items-center gap-2">
                <span className="text-sm font-medium capitalize flex-1 min-w-0 truncate">
                  {w.component}
                </span>
                <div className="flex items-center gap-1">
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={w.weight || ""}
                    onChange={(e) =>
                      updateWeight(w.component, e.target.value === "" ? 0 : Number(e.target.value))
                    }
                    className="w-16 h-8 text-sm text-center"
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
                {!["asistencia", "talleres", "parciales"].includes(w.component) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    onClick={() => removeComponent(w.component)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {/* Add custom component */}
          <div className="flex items-center gap-2 pt-2 border-t">
            <Input
              value={newComponent}
              onChange={(e) => setNewComponent(e.target.value)}
              placeholder="Ej: participación, proyecto"
              className="h-8 text-sm flex-1"
              onKeyDown={(e) => e.key === "Enter" && addComponent()}
            />
            <Button variant="outline" size="sm" className="h-8" onClick={addComponent}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Agregar
            </Button>
          </div>
          {/* Total indicator */}
          <div className="flex items-center justify-between pt-2 border-t">
            <span className="text-sm font-medium">Total</span>
            <Badge
              variant={
                weights.reduce((s, w) => s + w.weight, 0) === 100 ? "default" : "destructive"
              }
              className="text-xs"
            >
              {weights.reduce((s, w) => s + w.weight, 0)}%
            </Badge>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setWeightsOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveWeights}>Guardar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

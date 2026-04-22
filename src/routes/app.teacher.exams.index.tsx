import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Plus, Pencil, GitBranch, Monitor, Copy } from "lucide-react";
import { ImportExportMenu } from "@/components/ImportExportMenu";
import { toCSV } from "@/lib/csv";

const EXAMS_TEMPLATE = `course_name,title,description,start_time,end_time,time_limit_minutes,navigation_type,shuffle_enabled
Programación I,Parcial 1,Examen del primer corte,2025-09-15T08:00,2025-09-15T10:00,90,libre,false
Programación I,Quiz 1,Quiz corto sobre listas,2025-09-22T08:00,2025-09-22T08:30,30,secuencial,true`;

export const Route = createFileRoute("/app/teacher/exams/")({ component: TeacherExams });

type Course = { id: string; name: string; period: string | null };
type Exam = {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string;
  time_limit_minutes: number;
  navigation_type: string;
  shuffle_enabled: boolean;
  parent_exam_id: string | null;
  course?: { name: string; period: string | null };
};

function TeacherExams() {
  const { user, roles } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [courses, setCourses] = useState<Course[]>([]);
  const [exams, setExams] = useState<Exam[]>([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Partial<Exam>>({});
  const [selectedCourseIds, setSelectedCourseIds] = useState<Set<string>>(new Set());
  const isTeacher = roles.includes("Docente") || roles.includes("Admin");

  const load = async () => {
    const [{ data: cs }, { data: es }] = await Promise.all([
      supabase.from("courses").select("id, name, period").order("name"),
      supabase
        .from("exams")
        .select("*, course:courses(name, period)")
        .order("start_time", { ascending: false }),
    ]);
    setCourses((cs ?? []) as Course[]);
    setExams((es ?? []) as any);
  };
  useEffect(() => {
    load();
  }, []);

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
    setSelectedCourseIds(new Set(courses[0] ? [courses[0].id] : []));
    setOpen(true);
  };

  const toggleCourse = (id: string) => {
    setSelectedCourseIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Keep form.course_id in sync with first selected
      const first = [...next][0];
      if (first) setForm((f) => ({ ...f, course_id: first }));
      return next;
    });
  };

  const save = async () => {
    if (!form.title || selectedCourseIds.size === 0 || !user) {
      toast.error(t("exam.completeFields"));
      return;
    }
    const courseIds = [...selectedCourseIds];
    const basePayload = {
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

    // Create one exam per selected course
    let firstId: string | null = null;
    for (const cid of courseIds) {
      const { data, error } = await supabase
        .from("exams")
        .insert({ ...basePayload, course_id: cid })
        .select()
        .single();
      if (error) {
        toast.error(error.message);
        return;
      }
      if (!firstId) firstId = data.id;
    }

    toast.success(
      courseIds.length > 1
        ? t("exam.createdIn", { count: courseIds.length })
        : t("exam.createdOne"),
    );
    setOpen(false);
    if (firstId) navigate({ to: "/app/teacher/exams/$examId", params: { examId: firstId } });
  };

  if (!isTeacher) return <p className="text-muted-foreground">{t("exam.needsTeacherRole")}</p>;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("exam.title")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("exam.subtitle", { count: exams.length })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ImportExportMenu
            label={t("exam.title")}
            resourceName="examenes"
            templateCsv={EXAMS_TEMPLATE}
            onExport={() => {
              if (!exams.length) return "";
              return toCSV(
                exams.map((e) => ({
                  course_name: e.course?.name ?? "",
                  title: e.title,
                  description: e.description ?? "",
                  start_time: e.start_time,
                  end_time: e.end_time,
                  time_limit_minutes: e.time_limit_minutes,
                  navigation_type: e.navigation_type,
                  shuffle_enabled: e.shuffle_enabled ? "true" : "false",
                })),
              );
            }}
            onImport={async (rows) => {
              if (!user) throw new Error("Sesión no válida");
              const courseByName = new Map(courses.map((c) => [c.name.toLowerCase().trim(), c.id]));
              let created = 0,
                skipped = 0;
              for (const r of rows) {
                const cid = courseByName.get((r.course_name || "").toLowerCase().trim());
                if (!cid || !r.title || !r.start_time || !r.end_time) {
                  skipped++;
                  continue;
                }
                const { error } = await supabase.from("exams").insert({
                  course_id: cid,
                  title: r.title,
                  description: r.description || null,
                  start_time: new Date(r.start_time).toISOString(),
                  end_time: new Date(r.end_time).toISOString(),
                  time_limit_minutes: Number(r.time_limit_minutes) || 60,
                  navigation_type: r.navigation_type || "libre",
                  shuffle_enabled: String(r.shuffle_enabled).toLowerCase() === "true",
                  created_by: user.id,
                });
                if (error) skipped++;
                else created++;
              }
              await load();
              return t("import.imported", { created, skipped });
            }}
          />
          <Button size="sm" onClick={openNew}>
            <Plus className="h-4 w-4 mr-1" />
            {t("exam.newExam")}
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("exam.columns.title")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("exam.columns.course")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("exam.columns.start")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("exam.columns.duration")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("exam.columns.type")}</TableHead>
                <TableHead className="text-right">{t("common.actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {exams.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-medium">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span>{e.title}</span>
                        {e.parent_exam_id && (
                          <Badge variant="outline" className="text-[10px]">
                            <GitBranch className="h-3 w-3 mr-1" />
                            {t("exam.supletorio")}
                          </Badge>
                        )}
                      </div>
                      <div className="md:hidden text-xs text-muted-foreground truncate">
                        {e.course?.name}
                        {e.course?.period && (
                          <span className="ml-1.5 text-[10px]">({e.course.period})</span>
                        )}
                      </div>
                      <div className="sm:hidden text-[11px] text-muted-foreground tabular-nums">
                        {new Date(e.start_time).toLocaleString()} · {e.time_limit_minutes}{" "}
                        {t("common.min")}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden md:table-cell">
                    {e.course?.name}
                    {e.course?.period && (
                      <Badge variant="outline" className="ml-1.5 text-[9px]">
                        {e.course.period}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm hidden sm:table-cell">
                    {new Date(e.start_time).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-sm hidden lg:table-cell">
                    {e.time_limit_minutes} {t("common.min")}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    <Badge variant="secondary" className="text-[10px]">
                      {e.navigation_type}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-0.5">
                      <Link to="/app/teacher/monitor/$examId" params={{ examId: e.id }}>
                        <Button variant="ghost" size="sm" title={t("exam.liveMonitor")}>
                          <Monitor className="h-4 w-4" />
                        </Button>
                      </Link>
                      <Link to="/app/teacher/exams/$examId" params={{ examId: e.id }}>
                        <Button variant="ghost" size="sm" title={t("common.edit")}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </Link>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("exam.newExam")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>{t("common.title")}</Label>
              <Input
                value={form.title ?? ""}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <Label>{t("common.description")}</Label>
              <Textarea
                value={form.description ?? ""}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div>
              <Label>
                {t("nav.courses")}{" "}
                <span className="text-xs text-muted-foreground font-normal">
                  {t("exam.selectCourses")}
                </span>
              </Label>
              <div className="mt-1.5 max-h-36 overflow-y-auto rounded-md border p-2 space-y-1">
                {courses.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-sm cursor-pointer"
                  >
                    <Checkbox
                      checked={selectedCourseIds.has(c.id)}
                      onCheckedChange={() => toggleCourse(c.id)}
                    />
                    <span className="flex-1">{c.name}</span>
                    {c.period && (
                      <Badge variant="outline" className="text-[9px]">
                        {c.period}
                      </Badge>
                    )}
                  </label>
                ))}
              </div>
              {selectedCourseIds.size > 1 && (
                <p className="text-xs text-muted-foreground mt-1">{t("exam.coursesHelp")}</p>
              )}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>{t("common.start")}</Label>
                <Input
                  type="datetime-local"
                  value={form.start_time as any}
                  onChange={(e) => {
                    const start = e.target.value;
                    const startMs = new Date(start).getTime();
                    // Auto-set end to start + 1h if end is empty or not after start
                    const currentEnd = form.end_time ? new Date(form.end_time).getTime() : 0;
                    const autoEnd =
                      currentEnd > startMs
                        ? form.end_time
                        : toLocal(new Date(startMs + 60 * 60 * 1000));
                    const diffMin = Math.max(
                      1,
                      Math.round((new Date(autoEnd!).getTime() - startMs) / 60000),
                    );
                    setForm({
                      ...form,
                      start_time: start,
                      end_time: autoEnd,
                      time_limit_minutes: diffMin,
                    });
                  }}
                />
              </div>
              <div>
                <Label>{t("common.end")}</Label>
                <Input
                  type="datetime-local"
                  value={form.end_time as any}
                  onChange={(e) => {
                    const end = e.target.value;
                    const diffMin = form.start_time
                      ? Math.max(
                          1,
                          Math.round(
                            (new Date(end).getTime() - new Date(form.start_time!).getTime()) /
                              60000,
                          ),
                        )
                      : form.time_limit_minutes;
                    setForm({ ...form, end_time: end, time_limit_minutes: diffMin });
                  }}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label>
                  {t("common.duration")} ({t("common.min")})
                </Label>
                <Input
                  type="number"
                  value={form.time_limit_minutes || ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      time_limit_minutes: e.target.value === "" ? 0 : Number(e.target.value),
                    })
                  }
                  disabled
                  className="bg-muted/50"
                />
              </div>
              <div>
                <Label>{t("exam.navigation")}</Label>
                <Select
                  value={form.navigation_type}
                  onValueChange={(v) => setForm({ ...form, navigation_type: v })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="libre">{t("exam.navigationFree")}</SelectItem>
                    <SelectItem value="secuencial">{t("exam.navigationSequential")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Label>{t("exam.shuffle")}</Label>
              <Switch
                checked={!!form.shuffle_enabled}
                onCheckedChange={(v) => setForm({ ...form, shuffle_enabled: v })}
              />
            </div>
            <div>
              <Label>{t("exam.parentExam")}</Label>
              <Select
                value={form.parent_exam_id ?? "none"}
                onValueChange={(v) => setForm({ ...form, parent_exam_id: v === "none" ? null : v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("exam.originalExam")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">{t("common.none")}</SelectItem>
                  {exams
                    .filter((e) => !e.parent_exam_id && e.course_id === form.course_id)
                    .map((e) => (
                      <SelectItem key={e.id} value={e.id}>
                        {e.title}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={save}>{t("common.create")}</Button>
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

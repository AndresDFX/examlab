import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import {
  ArrowLeft, Pause, Play, Clock, Plus, Users, User,
  AlertTriangle, CheckCircle2, Loader2,
} from "lucide-react";

export const Route = createFileRoute("/app/teacher/monitor/$examId")({ component: ExamMonitor });

type Submission = {
  id: string;
  user_id: string;
  status: string;
  focus_warnings: number;
  answers: any;
  profile?: { full_name: string; institutional_email: string };
};

function ExamMonitor() {
  const { examId } = Route.useParams();
  const { user } = useAuth();
  const [exam, setExam] = useState<any>(null);
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [extraMinutes, setExtraMinutes] = useState(5);
  const [extraMinutesStudent, setExtraMinutesStudent] = useState(5);
  const [loading, setLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data: e } = await supabase.from("exams").select("*, course:courses(name)").eq("id", examId).single();
    setExam(e);

    const { data: subs } = await supabase
      .from("submissions")
      .select("id, user_id, status, focus_warnings, answers")
      .eq("exam_id", examId);

    if (subs?.length) {
      const userIds = subs.map((s) => s.user_id);
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, full_name, institutional_email")
        .in("id", userIds);

      const profileMap = new Map((profiles ?? []).map((p: any) => [p.id, p]));
      setSubmissions(
        subs.map((s) => ({ ...s, profile: profileMap.get(s.user_id) })) as Submission[]
      );
    } else {
      setSubmissions([]);
    }
  }, [examId]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const sendTimerControl = async (
    action: "pause" | "resume" | "add_time",
    targetUserId: string | null,
    extraSeconds = 0
  ) => {
    if (!user) return;
    const key = `${action}-${targetUserId ?? "global"}`;
    setLoading(key);
    const { error } = await supabase.from("exam_timer_controls").insert({
      exam_id: examId,
      target_user_id: targetUserId,
      action,
      extra_seconds: extraSeconds,
      created_by: user.id,
    });
    setLoading(null);
    if (error) return toast.error(error.message);

    const labels: Record<string, string> = {
      pause: "Temporizador pausado",
      resume: "Temporizador reanudado",
      add_time: `+${Math.floor(extraSeconds / 60)} minuto(s) añadidos`,
    };
    toast.success(`${labels[action]} ${targetUserId ? "(estudiante)" : "(global)"}`);
  };

  if (!exam) return <p className="text-muted-foreground p-6">Cargando…</p>;

  const inProgress = submissions.filter((s) => s.status === "en_progreso");
  const completed = submissions.filter((s) => s.status === "completado" || s.status === "sospechoso");

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-2">
        <Link to="/app/teacher/exams">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" />Volver</Button>
        </Link>
        <div>
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Monitor: {exam.title}</h1>
          <p className="text-sm text-muted-foreground">{exam.course?.name}</p>
        </div>
      </div>

      {/* Global controls */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" /> Controles globales
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Estos controles afectan a todos los estudiantes que están presentando el examen en tiempo real.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => sendTimerControl("pause", null)}
              disabled={loading === "pause-global"}
            >
              {loading === "pause-global" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Pause className="h-4 w-4 mr-1" />}
              Pausar todos
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => sendTimerControl("resume", null)}
              disabled={loading === "resume-global"}
            >
              {loading === "resume-global" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Play className="h-4 w-4 mr-1" />}
              Reanudar todos
            </Button>
            <div className="flex items-center gap-1.5">
              <Input
                type="number"
                min={1}
                max={120}
                value={extraMinutes || ""}
                onChange={(e) => setExtraMinutes(e.target.value === "" ? 0 : Number(e.target.value))}
                className="w-20 h-8 text-sm"
              />
              <span className="text-xs text-muted-foreground">min</span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => sendTimerControl("add_time", null, extraMinutes * 60)}
                disabled={loading === "add_time-global"}
              >
                {loading === "add_time-global" ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Plus className="h-4 w-4 mr-1" />}
                Añadir tiempo a todos
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Live submissions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">
              En progreso ({inProgress.length}) · Completados ({completed.length})
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={load}>
              <Clock className="h-4 w-4 mr-1" /> Actualizar
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Estudiante</TableHead>
                <TableHead>Estado</TableHead>
                <TableHead>Advertencias</TableHead>
                <TableHead>Respuestas</TableHead>
                <TableHead className="text-right">Acciones individuales</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {submissions.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Ningún estudiante ha iniciado el examen aún.
                  </TableCell>
                </TableRow>
              )}
              {submissions.map((sub) => {
                const answeredCount = Object.keys(sub.answers ?? {}).filter(
                  (k) => !k.startsWith("__")
                ).length;
                return (
                  <TableRow key={sub.id}>
                    <TableCell>
                      <div className="font-medium">{sub.profile?.full_name ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{sub.profile?.institutional_email}</div>
                    </TableCell>
                    <TableCell>
                      {sub.status === "en_progreso" ? (
                        <Badge className="bg-success text-success-foreground text-[10px]">En progreso</Badge>
                      ) : sub.status === "sospechoso" ? (
                        <Badge variant="destructive" className="text-[10px]">
                          <AlertTriangle className="h-3 w-3 mr-0.5" /> Sospechoso
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          <CheckCircle2 className="h-3 w-3 mr-0.5" /> Completado
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={sub.focus_warnings > 0 ? "destructive" : "outline"} className="text-[10px]">
                        {sub.focus_warnings}/3
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm">{answeredCount}</TableCell>
                    <TableCell className="text-right">
                      {sub.status === "en_progreso" && (
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => sendTimerControl("pause", sub.user_id)}
                            disabled={loading === `pause-${sub.user_id}`}
                            title="Pausar este estudiante"
                          >
                            <Pause className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => sendTimerControl("resume", sub.user_id)}
                            disabled={loading === `resume-${sub.user_id}`}
                            title="Reanudar este estudiante"
                          >
                            <Play className="h-3.5 w-3.5" />
                          </Button>
                          <div className="flex items-center gap-1">
                            <Input
                              type="number"
                              min={1}
                              max={120}
                              value={extraMinutesStudent || ""}
                              onChange={(e) => setExtraMinutesStudent(e.target.value === "" ? 0 : Number(e.target.value))}
                              className="w-16 h-7 text-xs"
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => sendTimerControl("add_time", sub.user_id, extraMinutesStudent * 60)}
                              disabled={loading === `add_time-${sub.user_id}`}
                              title="Añadir tiempo"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Student Projects — list and upload ZIP submissions.
 */
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Upload, FileArchive, Sparkles, Bot } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const Route = createFileRoute("/app/student/projects")({ component: StudentProjects });

type Project = {
  id: string;
  course_id: string;
  title: string;
  description: string | null;
  instructions: string | null;
  project_type: string;
  max_files: number;
  max_score: number;
  due_date: string | null;
};
type Sub = {
  id: string;
  project_id: string;
  zip_url: string | null;
  status: string;
  ai_grade: number | null;
  ai_feedback: string | null;
  ai_detected: boolean;
  final_grade: number | null;
  teacher_feedback: string | null;
};

function StudentProjects() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[]>([]);
  const [subs, setSubs] = useState<Record<string, Sub>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    if (!user) return;
    const { data: enr } = await supabase
      .from("course_enrollments")
      .select("course_id")
      .eq("user_id", user.id);
    const courseIds = (enr ?? []).map((e: { course_id: string }) => e.course_id);
    if (!courseIds.length) {
      setProjects([]);
      return;
    }
    const { data: ps } = await db
      .from("projects")
      .select("*")
      .in("course_id", courseIds)
      .eq("status", "published")
      .order("due_date", { ascending: true });
    setProjects((ps ?? []) as Project[]);
    if (ps?.length) {
      const { data: ss } = await db
        .from("project_submissions")
        .select("*")
        .eq("user_id", user.id)
        .in(
          "project_id",
          ps.map((p: Project) => p.id),
        );
      const map: Record<string, Sub> = {};
      (ss ?? []).forEach((s: Sub) => (map[s.project_id] = s));
      setSubs(map);
    }
  };

  useEffect(() => {
    void load();
  }, [user]);

  const upload = async (project: Project, file: File) => {
    if (!user) return;
    if (!file.name.toLowerCase().endsWith(".zip")) {
      return toast.error("Debe ser un archivo .zip");
    }
    setBusy(project.id);
    const path = `projects/${project.id}/${user.id}/${Date.now()}_${file.name}`;
    const { error: upErr } = await supabase.storage
      .from("workshop-files")
      .upload(path, file, { upsert: true });
    if (upErr) {
      setBusy(null);
      return toast.error(upErr.message);
    }
    // upsert submission
    const existing = subs[project.id];
    const payload = {
      project_id: project.id,
      user_id: user.id,
      zip_url: path,
      status: "entregado",
      submitted_at: new Date().toISOString(),
    };
    const { error } = existing
      ? await db.from("project_submissions").update(payload).eq("id", existing.id)
      : await db.from("project_submissions").insert(payload);
    setBusy(null);
    if (error) return toast.error(error.message);
    toast.success("Entrega guardada");
    void load();
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Proyectos</h1>
        <p className="text-sm text-muted-foreground">Sube tu entrega como un único archivo ZIP.</p>
      </div>
      <div className="grid gap-3">
        {projects.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No tienes proyectos asignados.
            </CardContent>
          </Card>
        )}
        {projects.map((p) => {
          const s = subs[p.id];
          return (
            <Card key={p.id}>
              <CardHeader className="space-y-1">
                <CardTitle className="text-base">{p.title}</CardTitle>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="outline" className="capitalize">{p.project_type}</Badge>
                  <Badge variant="outline">Máx. {p.max_files} archivos</Badge>
                  {p.due_date && (
                    <span className="text-muted-foreground">
                      Entrega: {new Date(p.due_date).toLocaleString()}
                    </span>
                  )}
                  {s && <Badge>{s.status}</Badge>}
                  {s?.final_grade != null && <Badge variant="secondary">Final: {s.final_grade}</Badge>}
                  {s?.ai_grade != null && <Badge variant="outline">IA: {s.ai_grade}</Badge>}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {p.instructions && (
                  <div className="text-sm whitespace-pre-wrap rounded bg-muted/30 p-3">
                    {p.instructions}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    type="file"
                    accept=".zip,application/zip"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void upload(p, f);
                    }}
                    disabled={busy === p.id}
                    className="max-w-sm"
                  />
                  {busy === p.id && (
                    <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                      <Upload className="h-3 w-3" />Subiendo...
                    </span>
                  )}
                  {s?.zip_url && (
                    <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                      <FileArchive className="h-3 w-3" />Entrega registrada
                    </span>
                  )}
                </div>
                {s?.ai_feedback && (
                  <div className="rounded border p-3 text-sm space-y-1">
                    <p className="font-medium inline-flex items-center gap-1">
                      <Sparkles className="h-3 w-3" />Retroalimentación IA
                    </p>
                    <p className="whitespace-pre-wrap text-muted-foreground">{s.ai_feedback}</p>
                  </div>
                )}
                {s?.teacher_feedback && (
                  <div className="rounded border p-3 text-sm">
                    <p className="font-medium">Retroalimentación del docente</p>
                    <p className="whitespace-pre-wrap text-muted-foreground">{s.teacher_feedback}</p>
                  </div>
                )}
                {s?.ai_detected && (
                  <div className="rounded bg-destructive/10 p-2 text-xs inline-flex items-center gap-1">
                    <Bot className="h-3 w-3" />
                    Tu entrega fue marcada como posiblemente generada por IA. El docente revisará.
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

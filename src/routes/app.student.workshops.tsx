import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { toast } from "sonner";
import {
  Clock,
  ExternalLink,
  Send,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  MessageSquare,
  MessageSquareText,
  Upload,
  FileIcon,
  X,
} from "lucide-react";

export const Route = createFileRoute("/app/student/workshops")({ component: StudentWorkshops });

type WorkshopRow = {
  workshop: {
    id: string;
    title: string;
    description: string | null;
    instructions: string | null;
    external_link: string | null;
    due_date: string | null;
    start_date: string | null;
    max_score: number;
    status: string;
    course: { name: string; grade_scale_min: number; grade_scale_max: number };
  };
  submission?: {
    id: string;
    content: string | null;
    external_link: string | null;
    file_url: string | null;
    ai_grade: number | null;
    ai_feedback: string | null;
    final_grade: number | null;
    teacher_feedback: string | null;
    status: string;
    submitted_at: string | null;
  };
};

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

function StudentWorkshops() {
  const { user, profile } = useAuth();
  const [rows, setRows] = useState<WorkshopRow[]>([]);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [activeWs, setActiveWs] = useState<WorkshopRow | null>(null);
  const [content, setContent] = useState("");
  const [link, setLink] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [existingFileUrl, setExistingFileUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!user) return;
    (async () => {
      const { data: asg } = await supabase
        .from("workshop_assignments")
        .select(
          "workshop:workshops(id, title, description, instructions, external_link, due_date, start_date, max_score, status, course:courses(name, grade_scale_min, grade_scale_max))",
        )
        .eq("user_id", user.id);

      const workshops = (asg ?? []).map((a: any) => a.workshop).filter(Boolean);
      const ids = workshops.map((w: any) => w.id);

      const { data: subs } = ids.length
        ? await supabase
            .from("workshop_submissions")
            .select(
              "id, workshop_id, content, external_link, file_url, ai_grade, ai_feedback, final_grade, teacher_feedback, status, submitted_at",
            )
            .in("workshop_id", ids)
            .eq("user_id", user.id)
        : { data: [] as any[] };

      setRows(
        workshops.map((w: any) => ({
          workshop: w,
          submission: subs?.find((s: any) => s.workshop_id === w.id),
        })),
      );
    })();
  }, [user]);

  const openSubmit = (row: WorkshopRow) => {
    setActiveWs(row);
    setContent(row.submission?.content ?? "");
    setLink(row.submission?.external_link ?? "");
    setFile(null);
    setExistingFileUrl(row.submission?.file_url ?? null);
    setSubmitOpen(true);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (selected.size > MAX_FILE_SIZE) {
      toast.error("El archivo excede el límite de 50 MB");
      return;
    }
    setFile(selected);
  };

  const removeFile = () => {
    setFile(null);
    if (fileRef.current) fileRef.current.value = "";
  };

  const uploadFile = async (workshopId: string): Promise<string | null> => {
    if (!file || !user || !activeWs) return existingFileUrl;

    setUploading(true);
    const ext = file.name.split(".").pop() ?? "bin";

    // Build descriptive filename: curso_taller_email.ext
    const sanitize = (s: string) =>
      s
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // remove accents
        .replace(/[^a-zA-Z0-9._-]/g, "_") // only safe chars
        .replace(/_+/g, "_") // collapse underscores
        .replace(/^_|_$/g, "") // trim underscores
        .substring(0, 60); // limit length

    const courseName = sanitize(activeWs.workshop.course?.name ?? "curso");
    const workshopTitle = sanitize(activeWs.workshop.title ?? "taller");
    const emailPart = sanitize((profile?.institutional_email ?? user.email ?? "").split("@")[0]);
    const fileName = `${courseName}_${workshopTitle}_${emailPart}.${ext}`;
    const path = `${user.id}/${workshopId}/${fileName}`;

    const { error } = await supabase.storage
      .from("workshop-files")
      .upload(path, file, { upsert: true });

    setUploading(false);

    if (error) {
      toast.error(`Error subiendo archivo: ${error.message}`);
      return existingFileUrl;
    }

    return path;
  };

  const getFileDownloadUrl = async (path: string): Promise<string | null> => {
    const { data } = await supabase.storage.from("workshop-files").createSignedUrl(path, 3600); // 1 hour
    return data?.signedUrl ?? null;
  };

  const handleSubmit = async () => {
    if (!user || !activeWs) return;
    // Block if past due date
    if (activeWs.workshop.due_date && new Date(activeWs.workshop.due_date).getTime() < Date.now()) {
      toast.error("La fecha límite ha pasado. No es posible entregar.");
      setSubmitOpen(false);
      return;
    }
    if (!content.trim() && !link.trim() && !file && !existingFileUrl) {
      toast.error("Escribe algo, proporciona un link o sube un archivo");
      return;
    }
    setSubmitting(true);

    // Upload file if selected
    const fileUrl = await uploadFile(activeWs.workshop.id);

    const payload = {
      workshop_id: activeWs.workshop.id,
      user_id: user.id,
      content: content || null,
      external_link: link || null,
      file_url: fileUrl,
      status: "entregado" as const,
      submitted_at: new Date().toISOString(),
    };

    if (activeWs.submission) {
      const { error } = await supabase
        .from("workshop_submissions")
        .update(payload)
        .eq("id", activeWs.submission.id);
      if (error) {
        toast.error(error.message);
        setSubmitting(false);
        return;
      }
    } else {
      const { error } = await supabase.from("workshop_submissions").insert(payload);
      if (error) {
        toast.error(error.message);
        setSubmitting(false);
        return;
      }
    }

    toast.success("Taller entregado correctamente");
    setSubmitOpen(false);
    setSubmitting(false);

    // Refresh
    const { data: sub } = await supabase
      .from("workshop_submissions")
      .select("*")
      .eq("workshop_id", activeWs.workshop.id)
      .eq("user_id", user.id)
      .maybeSingle();

    setRows((prev) =>
      prev.map((r) =>
        r.workshop.id === activeWs.workshop.id ? { ...r, submission: sub ?? undefined } : r,
      ),
    );
  };

  const downloadExistingFile = async (fileUrl: string) => {
    const url = await getFileDownloadUrl(fileUrl);
    if (url) window.open(url, "_blank");
    else toast.error("No se pudo generar el enlace de descarga");
  };

  const getFileName = (path: string) => {
    const parts = path.split("/");
    return parts[parts.length - 1];
  };

  const now = Date.now();
  const visibleRows = rows;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Talleres</h1>
        <p className="text-sm text-muted-foreground">{visibleRows.length} talleres disponibles</p>
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        {visibleRows.length === 0 && (
          <p className="text-muted-foreground text-sm">
            No tienes talleres disponibles en este momento.
          </p>
        )}
        {visibleRows.map(({ workshop, submission }) => {
          const isOverdue = workshop.due_date && new Date(workshop.due_date).getTime() < now;
          const grade = submission?.final_grade ?? submission?.ai_grade;
          return (
            <Card key={workshop.id}>
              <CardContent className="p-5 space-y-3">
                <div className="flex justify-between items-start gap-2">
                  <div className="min-w-0">
                    <div className="text-xs text-muted-foreground">{workshop.course?.name}</div>
                    <h3 className="font-semibold truncate">{workshop.title}</h3>
                  </div>
                  {submission?.status === "calificado" ? (
                    <Badge className="shrink-0">
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Nota: {grade}/{workshop.max_score}
                    </Badge>
                  ) : submission?.status === "entregado" ? (
                    <Badge variant="secondary" className="shrink-0">
                      Entregado
                    </Badge>
                  ) : isOverdue ? (
                    <Badge variant="destructive" className="shrink-0">
                      <AlertTriangle className="h-3 w-3 mr-1" />
                      Vencido
                    </Badge>
                  ) : workshop.status === "published" && (!workshop.start_date || new Date(workshop.start_date).getTime() <= now) ? (
                    <Badge className="bg-success text-success-foreground shrink-0">Abierto</Badge>
                  ) : workshop.start_date && new Date(workshop.start_date).getTime() > now ? (
                    <Badge variant="outline" className="shrink-0">Próximo</Badge>
                  ) : (
                    <Badge variant="outline" className="shrink-0">
                      {workshop.status === "draft" ? "Próximo" : "Cerrado"}
                    </Badge>
                  )}
                </div>

                {workshop.description && (
                  <p className="text-sm text-muted-foreground line-clamp-2">
                    {workshop.description}
                  </p>
                )}

                <div className="text-xs text-muted-foreground space-y-0.5">
                  {workshop.due_date && (
                    <div className="flex items-center gap-1.5">
                      <Clock className="h-3 w-3" />
                      Fecha límite: {new Date(workshop.due_date).toLocaleString()}
                    </div>
                  )}
                  <div>
                    Puntaje máximo: {workshop.max_score} · Escala:{" "}
                    {workshop.course?.grade_scale_min ?? 0}–{workshop.course?.grade_scale_max ?? 5}
                  </div>
                </div>

                {workshop.external_link && (
                  <a
                    href={workshop.external_link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary flex items-center gap-1 hover:underline"
                  >
                    <ExternalLink className="h-3 w-3" /> Material del taller
                  </a>
                )}

                {submission?.file_url && (
                  <button
                    onClick={() => downloadExistingFile(submission.file_url!)}
                    className="text-sm text-primary flex items-center gap-1 hover:underline"
                  >
                    <FileIcon className="h-3 w-3" /> {getFileName(submission.file_url)}
                  </button>
                )}

                {(submission?.teacher_feedback || submission?.ai_feedback) && (
                  <div className="bg-muted/50 p-2 rounded text-sm">
                    <div className="text-xs font-medium flex items-center gap-1 mb-1">
                      <MessageSquare className="h-3 w-3" /> Retroalimentación
                    </div>
                    <div className="whitespace-pre-wrap">
                      {[
                        ...new Set(
                          [submission?.teacher_feedback, submission?.ai_feedback].filter(
                            Boolean,
                          ) as string[],
                        ),
                      ].join("\n\n")}
                    </div>
                  </div>
                )}

                {submission && (
                  <Link to="/app/student/workshop/$workshopId" params={{ workshopId: workshop.id }}>
                    <Button variant="secondary" size="sm" className="w-full">
                      <MessageSquareText className="h-4 w-4 mr-1" />
                      Ver detalle y retroalimentación
                    </Button>
                  </Link>
                )}

                {workshop.status === "published" &&
                  submission?.status !== "calificado" &&
                  !isOverdue && (
                    <Button
                      size="sm"
                      className="w-full"
                      onClick={() => openSubmit({ workshop, submission })}
                    >
                      <Send className="h-4 w-4 mr-1" />
                      {submission ? "Actualizar entrega" : "Entregar taller"}
                    </Button>
                  )}
                {workshop.status === "published" &&
                  submission?.status !== "calificado" &&
                  isOverdue &&
                  !submission && (
                    <p className="text-xs text-destructive text-center">
                      La fecha límite ha pasado. No es posible entregar.
                    </p>
                  )}
                {workshop.status === "published" &&
                  isOverdue &&
                  submission?.status === "entregado" && (
                    <p className="text-xs text-muted-foreground text-center">
                      Entregado antes de la fecha límite. No se permiten modificaciones.
                    </p>
                  )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Submit Dialog */}
      <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Entregar — {activeWs?.workshop.title}</DialogTitle>
          </DialogHeader>
          {activeWs?.workshop.instructions && (
            <div className="bg-muted/50 p-3 rounded text-sm">
              <div className="text-xs font-medium mb-1">Instrucciones:</div>
              {activeWs.workshop.instructions}
            </div>
          )}
          <div className="space-y-3">
            <div>
              <Label>Tu respuesta / contenido</Label>
              <Textarea
                rows={4}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Escribe tu respuesta aquí..."
              />
            </div>

            {/* File upload */}
            <div>
              <Label>Archivo adjunto (máx. 50 MB)</Label>
              <div className="mt-1.5">
                {file ? (
                  <div className="flex items-center gap-2 p-2.5 rounded-md border bg-muted/30">
                    <FileIcon className="h-4 w-4 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{file.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {formatFileSize(file.size)}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={removeFile}
                      className="h-7 w-7 p-0 shrink-0"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : existingFileUrl ? (
                  <div className="flex items-center gap-2 p-2.5 rounded-md border bg-muted/30">
                    <FileIcon className="h-4 w-4 text-primary shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">
                        {getFileName(existingFileUrl)}
                      </div>
                      <div className="text-xs text-muted-foreground">Archivo actual</div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setExistingFileUrl(null)}
                      className="h-7 w-7 p-0 shrink-0"
                      title="Quitar archivo"
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : null}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className={file || existingFileUrl ? "mt-2" : ""}
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-4 w-4 mr-1.5" />
                  {file || existingFileUrl ? "Cambiar archivo" : "Seleccionar archivo"}
                </Button>
                <input
                  ref={fileRef}
                  type="file"
                  className="hidden"
                  accept=".pdf,.zip,.rar,.7z,.gz,.tar,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.html,.png,.jpg,.jpeg,.gif,.webp,.json,.xml,.jar"
                  onChange={handleFileSelect}
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  PDF, ZIP, RAR, documentos Office, imágenes, código
                </p>
              </div>
            </div>

            <div>
              <Label>Link externo (opcional)</Label>
              <Input
                placeholder="https://github.com/..."
                value={link}
                onChange={(e) => setLink(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubmitOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleSubmit} disabled={submitting || uploading}>
              {submitting || uploading ? (
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-1" />
              )}
              {uploading ? "Subiendo…" : "Entregar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

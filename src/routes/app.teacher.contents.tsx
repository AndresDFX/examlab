import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useMemo, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TableEmpty } from "@/components/ui/empty-state";
import { TableSkeleton } from "@/components/ui/table-skeleton";
import { Spinner } from "@/components/ui/spinner";
import { RowActionsMenu } from "@/components/ui/row-actions-menu";
import { DateCell } from "@/components/ui/date-cell";
import { useConfirm } from "@/components/ConfirmDialog";
import { Plus, Download, FileText, Presentation, RefreshCw, Trash2, Eye } from "lucide-react";
import { buildPptxBlob, type PptxBrand } from "@/lib/contents-pptx";

export const Route = createFileRoute("/app/teacher/contents")({ component: TeacherContents });

// El tipo `generated_contents` aún no está reflejado en los types
// generados de Supabase (se acaba de crear su migración). Usamos any
// localmente para mantener el contrato sin esperar a la regeneración.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type ContentMode = "curso_completo" | "material_individual";
type ContentStatus = "queued" | "processing" | "done" | "failed";
type ContentModality = "teorica" | "practica" | "teorico_practica";

interface FileEntry {
  name: string;
  path: string;
  kind: "pptx-source" | "md" | "txt";
  body?: string;
}

interface GeneratedContent {
  id: string;
  teacher_id: string;
  course_id: string | null;
  mode: ContentMode;
  topic: string;
  n_classes: number | null;
  language: string;
  author: string | null;
  status: ContentStatus;
  files: FileEntry[];
  error: string | null;
  raw_output: string | null;
  created_at: string;
  updated_at: string;
}

interface CourseLite {
  id: string;
  name: string;
}

interface BrandConfig {
  university_name: string;
  primary_color: string;
  secondary_color: string;
  logo_url: string | null;
  author_default: string | null;
}

function statusVariant(s: ContentStatus): "default" | "secondary" | "destructive" | "outline" {
  switch (s) {
    case "done":
      return "default";
    case "processing":
    case "queued":
      return "secondary";
    case "failed":
      return "destructive";
    default:
      return "outline";
  }
}

function TeacherContents() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const confirm = useConfirm();

  const [items, setItems] = useState<GeneratedContent[]>([]);
  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [brand, setBrand] = useState<BrandConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [rawForId, setRawForId] = useState<string | null>(null);

  // Form
  const [topic, setTopic] = useState("");
  const [mode, setMode] = useState<ContentMode>("material_individual");
  const [nClasses, setNClasses] = useState<number>(8);
  // Duración por clase, en minutos. La IA lo usa como criterio de
  // extensión: <30 → material compacto, >120 → material extenso. Default
  // 60 (clase universitaria estándar).
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  // Modalidad: define QUÉ archivos genera la IA.
  //   teorica          → solo presentación + guía
  //   practica         → solo taller práctico
  //   teorico_practica → todo (default — el caso más común).
  const [modality, setModality] = useState<ContentModality>("teorico_practica");
  const [language, setLanguage] = useState<"es" | "en">("es");
  const [courseId, setCourseId] = useState<string>("");
  const [author, setAuthor] = useState("");

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const [{ data: gens }, { data: brandRow }, { data: cs }] = await Promise.all([
      db
        .from("generated_contents")
        .select("*")
        .eq("teacher_id", user.id)
        .order("created_at", { ascending: false }),
      db.from("content_brand_config").select("*").maybeSingle(),
      // Cursos donde el docente tiene rol — para el selector opcional.
      db.from("course_teachers").select("course:courses(id, name)").eq("teacher_id", user.id),
    ]);
    setItems((gens ?? []) as GeneratedContent[]);
    setBrand((brandRow as BrandConfig) ?? null);
    // course_teachers viene anidado; aplanamos a {id, name}.
    setCourses(
      ((cs ?? []) as Array<{ course: CourseLite | null }>)
        .map((r) => r.course)
        .filter((c): c is CourseLite => c != null),
    );
    setLoading(false);
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polling suave: si hay items en queued/processing, recargamos cada
  // 5s para reflejar el cambio de estado sin que el docente recargue
  // manualmente. Cuando todos están done/failed, paramos el polling.
  useEffect(() => {
    const hasPending = items.some((i) => i.status === "queued" || i.status === "processing");
    if (!hasPending) return;
    const id = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(id);
  }, [items, load]);

  const submitNew = async () => {
    if (!user) return;
    if (!topic.trim()) {
      toast.error(t("integrity.applyError"));
      return;
    }
    setCreating(true);
    try {
      const insertPayload: Record<string, unknown> = {
        teacher_id: user.id,
        topic: topic.trim(),
        mode,
        language,
        n_classes: mode === "curso_completo" ? nClasses : null,
        duration_minutes: durationMinutes,
        modality,
        course_id: courseId || null,
        author: author.trim() || null,
        status: "queued",
      };
      const { data: created, error: insErr } = await db
        .from("generated_contents")
        .insert(insertPayload)
        .select("*")
        .maybeSingle();
      if (insErr || !created) throw new Error(insErr?.message ?? "insert failed");

      // Disparamos la edge function fire-and-forget. El usuario verá
      // el estado en la lista (queued → processing → done/failed) vía polling.
      void supabase.functions.invoke("generate-contents", { body: { id: created.id } });

      toast.success(t("contents.createdToast"));
      setDialogOpen(false);
      // Reset form
      setTopic("");
      setAuthor("");
      void load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const remove = async (item: GeneratedContent) => {
    const ok = await confirm({
      title: t("contents.deleteTitle"),
      description: t("contents.deleteBody"),
      confirmLabel: t("common.delete"),
      tone: "destructive",
    });
    if (!ok) return;
    // Borra los archivos del bucket (en el patrón <teacher>/<id>/*) y la fila.
    const paths = (item.files ?? []).map((f) => f.path).filter(Boolean);
    if (paths.length) {
      await supabase.storage.from("generated-contents").remove(paths);
    }
    const { error } = await db.from("generated_contents").delete().eq("id", item.id);
    if (error) {
      toast.error(error.message);
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    toast.success(t("contents.deletedToast"));
  };

  const regenerate = async (item: GeneratedContent) => {
    // Reset al estado queued y re-disparamos la edge function. La función
    // resetea error e ignora si ya está done (en realidad la pasamos a queued
    // con un update explícito antes para reintentar fallos).
    const { error } = await db
      .from("generated_contents")
      .update({ status: "queued", error: null })
      .eq("id", item.id);
    if (error) return toast.error(error.message);
    void supabase.functions.invoke("generate-contents", { body: { id: item.id } });
    toast.success(t("contents.regeneratedToast"));
    void load();
  };

  /**
   * Descarga un archivo. Para `kind='md'` y `'txt'` viene como texto
   * plano del bucket — descargamos directo.
   * Para `pptx-source` leemos el body crudo (que la edge function dejó
   * almacenado como .pptx.txt) y lo convertimos a .pptx real con
   * pptxgenjs en el browser. Esto evita pesar el bundle inicial — el
   * import es lazy dentro de buildPptxBlob.
   */
  const download = async (item: GeneratedContent, file: FileEntry) => {
    setDownloadingId(`${item.id}:${file.path}`);
    try {
      const { data: blob, error } = await supabase.storage
        .from("generated-contents")
        .download(file.path);
      if (error || !blob) throw new Error(error?.message ?? "download failed");

      if (file.kind === "pptx-source") {
        const raw = await blob.text();
        const pptxBrand: PptxBrand = {
          universityName: brand?.university_name ?? "",
          primaryColor: brand?.primary_color ?? "#1e40af",
          secondaryColor: brand?.secondary_color ?? "#64748b",
          logoUrl: brand?.logo_url ?? null,
          author: item.author ?? brand?.author_default ?? null,
        };
        const documentTitle = item.topic;
        const pptxBlob = await buildPptxBlob(raw, pptxBrand, documentTitle);
        const url = URL.createObjectURL(pptxBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name.replace(/\.txt$/i, "");
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setDownloadingId(null);
    }
  };

  const courseNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of courses) m.set(c.id, c.name);
    return m;
  }, [courses]);

  const rawItem = items.find((i) => i.id === rawForId) ?? null;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Presentation className="h-5 w-5 text-primary" />
            {t("contents.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("contents.subtitle")}</p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" />
          {t("contents.newContent")}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <TableSkeleton rows={5} cols={5} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("contents.topicColumn")}</TableHead>
                  <TableHead>{t("contents.modeColumn")}</TableHead>
                  <TableHead>{t("common.course")}</TableHead>
                  <TableHead>{t("common.status")}</TableHead>
                  <TableHead>{t("contents.filesColumn")}</TableHead>
                  <TableHead>{t("contents.createdColumn")}</TableHead>
                  <TableHead className="text-right">{t("common.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 && (
                  <TableEmpty
                    colSpan={7}
                    text={t("contents.emptyTitle")}
                    hint={t("contents.emptyHint")}
                    action={
                      <Button onClick={() => setDialogOpen(true)}>
                        <Plus className="h-4 w-4 mr-1" />
                        {t("contents.createFirst")}
                      </Button>
                    }
                  />
                )}
                {items.map((it) => (
                  <TableRow key={it.id}>
                    <TableCell className="font-medium max-w-xs truncate" title={it.topic}>
                      {it.topic}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-[11px]">
                        {it.mode === "curso_completo"
                          ? `${t("contents.modeFull")} (${it.n_classes})`
                          : t("contents.modeSingle")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {it.course_id
                        ? (courseNameById.get(it.course_id) ?? "—")
                        : t("contents.noCourse")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(it.status)} className="text-[11px]">
                        {it.status === "processing" && <Spinner size="xs" className="mr-1" />}
                        {t(
                          `contents.status${it.status.charAt(0).toUpperCase()}${it.status.slice(1)}`,
                        )}
                      </Badge>
                      {it.status === "failed" && it.error && (
                        <div
                          className="text-[10px] text-destructive mt-1 max-w-xs truncate"
                          title={it.error}
                        >
                          {t("contents.errorPrefix")}: {it.error}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(it.files ?? []).slice(0, 3).map((f) => (
                          <Button
                            key={f.path}
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() => download(it, f)}
                            disabled={downloadingId === `${it.id}:${f.path}`}
                          >
                            {downloadingId === `${it.id}:${f.path}` ? (
                              <Spinner size="xs" className="mr-1" />
                            ) : f.kind === "pptx-source" ? (
                              <Presentation className="h-3 w-3 mr-1" />
                            ) : (
                              <FileText className="h-3 w-3 mr-1" />
                            )}
                            {f.kind === "pptx-source"
                              ? t("contents.filesPpt")
                              : f.kind === "md"
                                ? t("contents.filesMd")
                                : t("contents.filesTxt")}
                          </Button>
                        ))}
                        {(it.files?.length ?? 0) > 3 && (
                          <span className="text-[11px] text-muted-foreground self-center">
                            {t("contents.fileTooManyHint", { count: it.files.length - 3 })}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <DateCell value={it.created_at} variant="datetime" />
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActionsMenu
                        actions={[
                          it.raw_output
                            ? {
                                label: t("contents.viewRaw"),
                                icon: Eye,
                                onClick: () => setRawForId(it.id),
                              }
                            : null,
                          {
                            label: t("contents.regenerate"),
                            icon: RefreshCw,
                            onClick: () => regenerate(it),
                            disabled: it.status === "queued" || it.status === "processing",
                          },
                          {
                            label: t("common.delete"),
                            icon: Trash2,
                            tone: "destructive",
                            separatorBefore: true,
                            onClick: () => remove(it),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("contents.newContent")}</DialogTitle>
            <DialogDescription>{t("contents.queuedHint")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label required>{t("contents.topic")}</Label>
              <Input
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("contents.topicPlaceholder")}
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t("contents.mode")}</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {(["material_individual", "curso_completo"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className={`text-left rounded-md border p-2.5 transition-colors ${
                      mode === m ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="font-medium text-sm">
                      {m === "curso_completo" ? t("contents.modeFull") : t("contents.modeSingle")}
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      {m === "curso_completo"
                        ? t("contents.modeFullDesc")
                        : t("contents.modeSingleDesc")}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {mode === "curso_completo" && (
                <div className="space-y-1.5">
                  <Label required>{t("contents.nClasses")}</Label>
                  <Input
                    type="number"
                    min={1}
                    max={40}
                    value={nClasses}
                    onChange={(e) => setNClasses(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label required>{t("contents.duration")}</Label>
                <Input
                  type="number"
                  min={10}
                  max={480}
                  step={5}
                  value={durationMinutes}
                  onChange={(e) =>
                    setDurationMinutes(Math.max(10, Math.min(480, Number(e.target.value) || 60)))
                  }
                />
                <p className="text-[11px] text-muted-foreground">{t("contents.durationHelper")}</p>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label required>{t("contents.modality")}</Label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {(
                  [
                    { key: "teorica", label: t("contents.modalityTheory") },
                    { key: "practica", label: t("contents.modalityPractice") },
                    { key: "teorico_practica", label: t("contents.modalityBoth") },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setModality(opt.key as ContentModality)}
                    className={`text-left rounded-md border p-2 text-xs transition-colors ${
                      modality === opt.key
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/40"
                    }`}
                  >
                    <div className="font-medium text-sm">{opt.label}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {t(`contents.modality_${opt.key}_desc`)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t("contents.courseOptional")}</Label>
                <Select
                  value={courseId || "none"}
                  onValueChange={(v) => setCourseId(v === "none" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t("contents.noCourse")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t("contents.noCourse")}</SelectItem>
                    {courses.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("contents.language")}</Label>
                <Select value={language} onValueChange={(v) => setLanguage(v as "es" | "en")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="es">Español</SelectItem>
                    <SelectItem value="en">English</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t("contents.author")}</Label>
              <Input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder={t("contents.authorPlaceholder")}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialogOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button onClick={submitNew} disabled={creating || !topic.trim()}>
              {creating ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <Download className="h-4 w-4 mr-1" />
              )}
              {creating ? t("contents.submitting") : t("contents.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Raw output dialog */}
      <Dialog open={rawForId != null} onOpenChange={(o) => !o && setRawForId(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("contents.raw")}</DialogTitle>
            <DialogDescription>{rawItem?.topic}</DialogDescription>
          </DialogHeader>
          <pre className="text-[11px] whitespace-pre-wrap max-h-[60vh] overflow-y-auto bg-muted/30 p-3 rounded">
            {rawItem?.raw_output ?? ""}
          </pre>
        </DialogContent>
      </Dialog>
    </div>
  );
}

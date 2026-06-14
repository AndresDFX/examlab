/**
 * GenerateKahootFromContentDialog — crear un Kahoot generando sus preguntas
 * con IA a partir del CONTENIDO del curso (Goal #18).
 *
 * Flujo:
 *   1. El docente elige CURSO + FUENTE del contenido:
 *        - "Todo el material del curso" → la IA lee TODO el contenido `done`
 *          del curso (mismo patrón que el Tutor IA).
 *        - "Material de una sesión"     → la IA lee solo el material de la
 *          sesión elegida; el Kahoot queda asociado a esa sesión
 *          (`polls.attendance_session_id`).
 *      Opcionalmente puede enfocar en unos temas dentro del material.
 *   2. Crea el poll (poll_type='kahoot') + lo enlaza al curso (poll_courses).
 *   3. Invoca el edge `ai-generate-questions` en modo kahoot pasando el scope
 *      del material; el edge extrae el texto y persiste kahoot_questions +
 *      kahoot_question_options.
 *   4. Respeta el gate IA (sync / código inmediato / cola) igual que el editor
 *      de preguntas Kahoot. En cola se encola con el body extendido.
 *
 * NO duplica la extracción de material en el cliente: el edge ya tiene el
 * patrón de tutor-chat (inline / notebook / docx-pptx). Acá solo se decide el
 * SCOPE y se manda al edge.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Wand2, Gamepad2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useAiAuthorizationGate } from "@/modules/ai/AiAuthorizationGate";
import { formatSessionLabel } from "@/shared/lib/format";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type MaterialScope = "course" | "session";

interface SessionRow {
  id: string;
  session_date: string | null;
  title: string | null;
  content_id: string | null;
}

export function GenerateKahootFromContentDialog({
  open,
  onOpenChange,
  courses,
  userId,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  courses: Array<{ id: string; name: string }>;
  userId: string | null;
  /** Llamado tras crear el Kahoot. Recibe el poll.id para que el caller pueda
   *  abrir el editor de preguntas si lo desea. */
  onCreated: (pollId: string) => void;
}) {
  const { t } = useTranslation();
  const aiGate = useAiAuthorizationGate();

  const [title, setTitle] = useState("");
  const [courseId, setCourseId] = useState<string | null>(null);
  const [scope, setScope] = useState<MaterialScope>("course");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [focus, setFocus] = useState("");
  const [count, setCount] = useState(8);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [saving, setSaving] = useState(false);

  // Reset al abrir / cerrar.
  useEffect(() => {
    if (!open) return;
    setTitle("");
    setCourseId(courses.length === 1 ? courses[0].id : null);
    setScope("course");
    setSessionId(null);
    setFocus("");
    setCount(8);
  }, [open, courses]);

  // Cargar sesiones del curso elegido (solo las que tienen contenido asignado,
  // que es lo único que sirve como fuente). Filtra papelera.
  useEffect(() => {
    if (!open || !courseId) {
      setSessions([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoadingSessions(true);
      const { data } = await db
        .from("attendance_sessions")
        .select("id, session_date, title, content_id")
        .eq("course_id", courseId)
        .is("deleted_at", null)
        .order("session_date", { ascending: true });
      if (cancelled) return;
      const rows = ((data ?? []) as SessionRow[]).filter((s) => !!s.content_id);
      setSessions(rows);
      setLoadingSessions(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, courseId]);

  // Si cambia el set de sesiones y la elegida ya no está, la limpiamos.
  useEffect(() => {
    if (sessionId && !sessions.some((s) => s.id === sessionId)) setSessionId(null);
  }, [sessions, sessionId]);

  const canSubmit = useMemo(() => {
    if (!title.trim() || !courseId) return false;
    if (scope === "session" && !sessionId) return false;
    return true;
  }, [title, courseId, scope, sessionId]);

  const generate = async () => {
    if (!userId) {
      toast.error(t("kahootGen.notAuthenticated", { defaultValue: "No autenticado" }));
      return;
    }
    if (!canSubmit || !courseId) return;
    const n = Math.max(1, Math.min(20, Math.round(count) || 8));
    const sessionForPoll = scope === "session" ? sessionId : null;

    // Gate IA igual que el editor: sync / código inmediato / cola.
    const decision = await aiGate.ensureAuthorized({ allowQueue: true });
    if (decision === "cancel") return;

    setSaving(true);
    try {
      // 1) Crear el poll kahoot asociado al curso (+ sesión si aplica).
      const { data: pollRow, error: pollErr } = await db
        .from("polls")
        .insert({
          course_id: courseId,
          title: title.trim(),
          poll_type: "kahoot",
          attendance_session_id: sessionForPoll,
          created_by: userId,
        })
        .select("id")
        .single();
      if (pollErr || !pollRow) {
        toast.error(friendlyError(pollErr, t("kahootGen.errCreate", { defaultValue: "No se pudo crear el Kahoot" })));
        return;
      }
      const pollId = pollRow.id as string;

      // El trigger AFTER INSERT en polls ya inserta el row ancla en
      // poll_courses; el upsert con ignoreDuplicates es por si acaso (paridad
      // con el create del form de encuestas). Single-course aquí.
      await db
        .from("poll_courses")
        .upsert([{ poll_id: pollId, course_id: courseId }], {
          onConflict: "poll_id,course_id",
          ignoreDuplicates: true,
        });

      // Body que viaja idéntico al edge (sync) y a la cola (async).
      const edgeBody = {
        type: "kahoot",
        count: n,
        examId: pollId,
        targetTable: "kahoot_questions",
        courseId,
        materialScope: scope,
        sessionId: sessionForPoll,
        // `topics` opcional: enfoque dentro del material.
        topics: focus.trim() || null,
      };

      if (decision === "proceed-async") {
        const { error: enqErr } = await db.from("ai_generation_queue").insert([
          {
            kind: "kahoot_questions",
            invoke_target: "ai-generate-questions",
            source_table: "polls",
            source_id: pollId,
            course_id: courseId,
            created_by: userId,
            body: edgeBody,
          },
        ]);
        if (enqErr) {
          toast.error(friendlyError(enqErr, t("kahootGen.errQueue", { defaultValue: "No se pudo encolar" })));
          return;
        }
        toast.success(
          t("kahootGen.queued", {
            defaultValue: "Kahoot creado. Las preguntas se generarán en cola.",
          }),
        );
        onOpenChange(false);
        onCreated(pollId);
        return;
      }

      // 2) Sync: invocar el edge y esperar las preguntas.
      const { data, error } = await supabase.functions.invoke("ai-generate-questions", {
        body: edgeBody,
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const edgeErr = error ?? (data as any)?.error;
      if (edgeErr) {
        // El poll ya existe (vacío). Lo dejamos para que el docente reintente
        // generando desde el editor o agregue preguntas a mano — pero avisamos.
        toast.error(friendlyError(edgeErr));
        onOpenChange(false);
        onCreated(pollId);
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inserted = (data as any)?.inserted?.length ?? 0;
      if (inserted === 0) {
        toast.warning(
          t("kahootGen.noQuestions", {
            defaultValue:
              "Kahoot creado, pero la IA no generó preguntas. Revisa el material o agrégalas a mano.",
          }),
        );
      } else {
        toast.success(
          t("kahootGen.generated", {
            defaultValue: "Kahoot creado con {{n}} pregunta(s).",
            n: inserted,
          }),
        );
      }
      onOpenChange(false);
      onCreated(pollId);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !saving && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gamepad2 className="h-5 w-5 text-primary" />
            {t("kahootGen.title", { defaultValue: "Generar Kahoot con IA del contenido" })}
          </DialogTitle>
          <DialogDescription>
            {t("kahootGen.subtitle", {
              defaultValue:
                "La IA crea las preguntas leyendo el material del curso. Puedes editarlas después.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label required>{t("kahootGen.fieldTitle", { defaultValue: "Título del Kahoot" })}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("kahootGen.titlePlaceholder", { defaultValue: "Ej. Repaso clase 3" })}
              maxLength={200}
              disabled={saving}
              className="mt-1"
            />
          </div>

          <div>
            <Label required>{t("kahootGen.fieldCourse", { defaultValue: "Curso" })}</Label>
            <Select
              value={courseId ?? ""}
              onValueChange={(v) => setCourseId(v || null)}
              disabled={saving || courses.length === 0}
            >
              <SelectTrigger className="mt-1">
                <SelectValue
                  placeholder={t("kahootGen.coursePlaceholder", { defaultValue: "Elige un curso" })}
                />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>
              {t("kahootGen.fieldSource", { defaultValue: "Fuente del contenido" })}{" "}
              <HelpHint>
                {t("kahootGen.sourceHint", {
                  defaultValue:
                    "Todo el material = lee todos los contenidos del curso. Una sesión = lee solo el material de esa sesión y asocia el Kahoot a ella.",
                })}
              </HelpHint>
            </Label>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v as MaterialScope)}
              disabled={saving}
            >
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="course">
                  {t("kahootGen.scopeCourse", { defaultValue: "Todo el material del curso" })}
                </SelectItem>
                <SelectItem value="session">
                  {t("kahootGen.scopeSession", { defaultValue: "Material de una sesión" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {scope === "session" && (
            <div>
              <Label required>{t("kahootGen.fieldSession", { defaultValue: "Sesión" })}</Label>
              <Select
                value={sessionId ?? ""}
                onValueChange={(v) => setSessionId(v || null)}
                disabled={saving || !courseId || loadingSessions}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue
                    placeholder={
                      loadingSessions
                        ? t("kahootGen.loadingSessions", { defaultValue: "Cargando sesiones…" })
                        : t("kahootGen.sessionPlaceholder", { defaultValue: "Elige una sesión" })
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {sessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {formatSessionLabel(s.session_date, s.title)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!loadingSessions && courseId && sessions.length === 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("kahootGen.noSessionsWithContent", {
                    defaultValue:
                      "Este curso no tiene sesiones con material asignado. Asígnale contenido en Asistencia o usa todo el material del curso.",
                  })}
                </p>
              )}
            </div>
          )}

          <div>
            <Label>
              {t("kahootGen.fieldFocus", { defaultValue: "Enfoque (opcional)" })}{" "}
              <HelpHint>
                {t("kahootGen.focusHint", {
                  defaultValue:
                    "Temas concretos dentro del material en los que quieres que se enfoque. Déjalo vacío para cubrir todo.",
                })}
              </HelpHint>
            </Label>
            <Textarea
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              placeholder={t("kahootGen.focusPlaceholder", {
                defaultValue: "Ej. herencia, polimorfismo, interfaces",
              })}
              rows={2}
              disabled={saving}
              className="mt-1"
            />
          </div>

          <div className="flex items-center gap-2">
            <Label className="text-xs">{t("kahootGen.fieldCount", { defaultValue: "N.º de preguntas" })}</Label>
            <Input
              type="number"
              min={1}
              max={20}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="h-8 w-20"
              disabled={saving}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("kahootGen.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button onClick={() => void generate()} disabled={saving || !canSubmit}>
            {saving ? <Spinner size="sm" className="mr-1" /> : <Wand2 className="h-4 w-4 mr-1" />}
            {t("kahootGen.generate", { defaultValue: "Generar Kahoot" })}
          </Button>
        </DialogFooter>

        {/* Gate de autorización IA (sync / código inmediato / cola). */}
        <aiGate.GateDialog />
      </DialogContent>
    </Dialog>
  );
}

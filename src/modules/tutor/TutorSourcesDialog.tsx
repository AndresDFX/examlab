/**
 * Diálogo «Fuentes del Tutor IA» (Fase 1).
 *
 * Reutilizable en dos alcances:
 *   - scope="subject" → el Admin define el DEFAULT de la asignatura.
 *   - scope="course"  → el docente (o Admin) SOBRESCRIBE para su curso, o
 *     vuelve a lo heredado de la asignatura.
 *
 * Cambia QUÉ fuentes alimentan al tutor (material de asignatura, material del
 * curso, transcripciones del curso, transcripciones de otros grupos de la
 * misma asignatura y periodo). No toca cómo se busca (Fase 1, sin embeddings).
 */
import { useEffect, useState } from "react";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Bot, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { useTranslation } from "react-i18next";
import {
  resolveTutorSources,
  configToRow,
  TUTOR_SOURCES_DEFAULT,
  type TutorSourcesConfig,
  type TutorAiSourceRow,
} from "./tutor-sources";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scope: "subject" | "course";
  scopeId: string;
  /** Solo en scope="course": la asignatura del curso, para mostrar lo heredado. */
  subjectId?: string | null;
}

type Row = TutorAiSourceRow & { id?: string };

export function TutorSourcesDialog({ open, onOpenChange, scope, scopeId, subjectId }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [overrideRow, setOverrideRow] = useState<Row | null>(null);
  const [subjectRow, setSubjectRow] = useState<Row | null>(null);
  const [overriding, setOverriding] = useState(false);
  const [draft, setDraft] = useState<TutorSourcesConfig>(TUTOR_SOURCES_DEFAULT);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        if (scope === "subject") {
          const { data } = await db
            .from("tutor_ai_sources")
            .select("*")
            .eq("subject_id", scopeId)
            .maybeSingle();
          if (cancelled) return;
          const row = (data as Row) ?? null;
          setSubjectRow(row);
          const eff = resolveTutorSources(null, row);
          setDraft(eff);
        } else {
          const [ov, subj] = await Promise.all([
            db.from("tutor_ai_sources").select("*").eq("course_id", scopeId).maybeSingle(),
            subjectId
              ? db.from("tutor_ai_sources").select("*").eq("subject_id", subjectId).maybeSingle()
              : Promise.resolve({ data: null }),
          ]);
          if (cancelled) return;
          const override = (ov.data as Row) ?? null;
          const subject = (subj.data as Row) ?? null;
          setOverrideRow(override);
          setSubjectRow(subject);
          setOverriding(!!override);
          setDraft(resolveTutorSources(override, subject));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, scope, scopeId, subjectId]);

  const inheritedOrigin = scope === "course" ? (subjectRow ? "subject" : "default") : null;
  const effectiveDisabled = scope === "course" && !overriding;

  function toggle(key: keyof TutorSourcesConfig, v: boolean) {
    setDraft((d) => ({ ...d, [key]: v }));
  }

  async function save() {
    setSaving(true);
    try {
      if (scope === "course" && !overriding) {
        // Volver a lo heredado: borrar el override si existe.
        if (overrideRow?.id) {
          const { error } = await db
            .from("tutor_ai_sources")
            .delete()
            .eq("course_id", scopeId);
          if (error) throw error;
        }
        toast.success(t("tutorSources.savedInherited"));
      } else {
        // Update-por-id o insert (no upsert: los índices únicos de
        // tutor_ai_sources son PARCIALES y ON CONFLICT no los infiere).
        const existingId = scope === "subject" ? subjectRow?.id : overrideRow?.id;
        const cols = configToRow(draft);
        if (existingId) {
          const { error } = await db
            .from("tutor_ai_sources")
            .update(cols)
            .eq("id", existingId);
          if (error) throw error;
        } else {
          const payload = {
            ...(scope === "subject" ? { subject_id: scopeId } : { course_id: scopeId }),
            ...cols,
          };
          const { error } = await db.from("tutor_ai_sources").insert(payload);
          if (error) throw error;
        }
        toast.success(t("tutorSources.saved"));
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  const switches: Array<{ key: keyof TutorSourcesConfig; label: string; hint: string }> = [
    {
      key: "subjectMaterial",
      label: t("tutorSources.subjectMaterial"),
      hint: t("tutorSources.subjectMaterialHint"),
    },
    {
      key: "courseMaterial",
      label: t("tutorSources.courseMaterial"),
      hint: t("tutorSources.courseMaterialHint"),
    },
    {
      key: "courseTranscripts",
      label: t("tutorSources.courseTranscripts"),
      hint: t("tutorSources.courseTranscriptsHint"),
    },
    {
      key: "siblingTranscripts",
      label: t("tutorSources.siblingTranscripts"),
      hint: t("tutorSources.siblingTranscriptsHint"),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            {t("tutorSources.title")}
          </DialogTitle>
          <DialogDescription>
            {scope === "subject"
              ? t("tutorSources.descriptionSubject")
              : t("tutorSources.descriptionCourse")}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="space-y-4">
            {scope === "course" && (
              <div className="flex items-center justify-between rounded-md border p-3">
                <div className="space-y-0.5 pr-3">
                  <Label className="text-sm">{t("tutorSources.overrideLabel")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {overriding
                      ? t("tutorSources.overrideOn")
                      : inheritedOrigin === "subject"
                        ? t("tutorSources.inheritedFromSubject")
                        : t("tutorSources.inheritedFromDefault")}
                  </p>
                </div>
                <Switch
                  checked={overriding}
                  onCheckedChange={(v) => {
                    setOverriding(v);
                    if (!v) setDraft(resolveTutorSources(null, subjectRow));
                  }}
                />
              </div>
            )}

            <div className="space-y-3">
              {switches.map((s) => (
                <div
                  key={s.key}
                  className="flex items-start justify-between gap-3 rounded-md border p-3"
                >
                  <div className="space-y-0.5">
                    <Label className="text-sm">{s.label}</Label>
                    <p className="text-xs text-muted-foreground">{s.hint}</p>
                  </div>
                  <Switch
                    checked={draft[s.key]}
                    disabled={effectiveDisabled}
                    onCheckedChange={(v) => toggle(s.key, v)}
                  />
                </div>
              ))}
            </div>

            {scope === "course" && overriding && overrideRow?.id && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => {
                  setOverriding(false);
                  setDraft(resolveTutorSources(null, subjectRow));
                }}
              >
                <RotateCcw className="h-4 w-4" />
                {t("tutorSources.backToSubject")}
              </Button>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button onClick={save} disabled={saving || loading}>
            {saving && <Spinner size="xs" />}
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

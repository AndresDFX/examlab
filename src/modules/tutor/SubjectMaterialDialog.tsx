/**
 * Diálogo «Material de la asignatura» (Admin).
 *
 * Asigna contenidos (generated_contents) a una ASIGNATURA para que el Tutor IA
 * los herede en CUALQUIER curso de esa asignatura, también en semestres
 * futuros, sin reasignarlos. Escribe en content_subject_assignments.
 *
 * Respeta la papelera: solo lista contenidos con status=done y sin deleted_at.
 */
import { useEffect, useMemo, useState } from "react";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { SearchInput } from "@/components/ui/search-input";
import { EmptyState } from "@/components/ui/empty-state";
import { FileText, FolderOpen } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { normalizeForSearch } from "@/modules/search/search-text";
import { useTranslation } from "react-i18next";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  subjectId: string;
  subjectName: string;
}

interface Content {
  id: string;
  display_name: string | null;
  topic: string | null;
}

export function SubjectMaterialDialog({ open, onOpenChange, subjectId, subjectName }: Props) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [contents, setContents] = useState<Content[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setQuery("");
    void (async () => {
      try {
        const [all, asg] = await Promise.all([
          db
            .from("generated_contents")
            .select("id, display_name, topic")
            .eq("status", "done")
            .is("deleted_at", null)
            .order("updated_at", { ascending: false })
            .limit(500),
          db
            .from("content_subject_assignments")
            .select("content_id")
            .eq("subject_id", subjectId),
        ]);
        if (cancelled) return;
        setContents(((all.data ?? []) as Content[]) || []);
        const ids = new Set<string>(
          ((asg.data ?? []) as Array<{ content_id: string }>).map((a) => a.content_id),
        );
        setSelected(new Set(ids));
        setInitial(new Set(ids));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, subjectId]);

  const filtered = useMemo(() => {
    const q = normalizeForSearch(query);
    if (!q) return contents;
    return contents.filter((c) =>
      normalizeForSearch(`${c.display_name ?? ""} ${c.topic ?? ""}`).includes(q),
    );
  }, [contents, query]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      const toAdd = [...selected].filter((id) => !initial.has(id));
      const toRemove = [...initial].filter((id) => !selected.has(id));
      if (toAdd.length) {
        const { error } = await db
          .from("content_subject_assignments")
          .upsert(
            toAdd.map((content_id) => ({ content_id, subject_id: subjectId })),
            { onConflict: "content_id,subject_id", ignoreDuplicates: true },
          );
        if (error) throw error;
      }
      if (toRemove.length) {
        const { error } = await db
          .from("content_subject_assignments")
          .delete()
          .eq("subject_id", subjectId)
          .in("content_id", toRemove);
        if (error) throw error;
      }
      toast.success(t("tutorSources.materialSaved"));
      onOpenChange(false);
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5 text-primary" />
            {t("tutorSources.materialTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("tutorSources.materialDescription", { subject: subjectName })}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex justify-center py-8">
            <Spinner size="lg" />
          </div>
        ) : contents.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={t("tutorSources.materialEmpty")}
            description={t("tutorSources.materialEmptyHint")}
          />
        ) : (
          <div className="space-y-3">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t("common.search")}
            />
            <div className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
              {filtered.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-accent"
                >
                  <Checkbox checked={selected.has(c.id)} onCheckedChange={() => toggle(c.id)} />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {c.display_name || c.topic || t("contents.untitled", { defaultValue: "(sin título)" })}
                  </span>
                </label>
              ))}
              {filtered.length === 0 && (
                <p className="px-2 py-4 text-center text-sm text-muted-foreground">
                  {t("common.noResults")}
                </p>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("tutorSources.materialSelectedCount", { count: selected.size })}
            </p>
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

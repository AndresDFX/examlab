/**
 * ContentPromptsOverridesDialog
 *
 * Editor de overrides de prompts POR CONTENIDO ESPECÍFICO.
 *
 * Contexto: el módulo de Contenidos genera material académico usando un
 * system prompt orquestador (`content_generation`) + 5 sub-prompts
 * (`content.presentacion`, `content.guia_docente`, `content.taller_practico`,
 * `content.ejercicio`, `content.examen`). Por defecto, esos prompts vienen
 * del módulo global de Prompts (lo edita Admin para toda la plataforma).
 *
 * Este dialog permite SOBRESCRIBIR cualquiera de esos 6 prompts SOLO
 * para este contenido — útil cuando un docente quiere generar el mismo
 * tópico para diferentes audiencias (universidad A vs B, presencial vs
 * virtual, etc.) sin tocar el global.
 *
 * Jerarquía resuelta por la edge function `generate-contents`:
 *   1) override aquí (prompt_overrides[use_case] en la fila)
 *   2) global del módulo de Prompts (ai_prompts WHERE course_id IS NULL)
 *   3) fallback hardcoded
 *
 * Persistencia: JSONB `generated_contents.prompt_overrides`. Cada key
 * vive solo si el docente la marcó como "personalizada"; si la suelta
 * (botón "Volver al global"), borramos la key del JSONB.
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HelpHint } from "@/components/ui/help-hint";
import { Spinner } from "@/components/ui/spinner";
import { RotateCcw, Save } from "lucide-react";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";
import {
  CONTENT_PROMPT_USE_CASES,
  type ContentPromptOverrides,
  type ContentPromptUseCase,
  sanitizeContentPromptOverrides,
} from "@/modules/contents/content-prompts";

// `ai_prompts` está en los types generados, pero el JSONB
// `prompt_overrides` aún no — lo recibimos via casts puntuales.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface UseCaseMeta {
  key: ContentPromptUseCase;
  label: string;
  description: string;
}

const USE_CASE_META: UseCaseMeta[] = [
  {
    key: "content_generation",
    label: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseOrchestratorLabel"),
    description: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseOrchestratorDesc"),
  },
  {
    key: "content.presentacion",
    label: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCasePresentationLabel"),
    description: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCasePresentationDesc"),
  },
  {
    key: "content.guia_docente",
    label: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseTeacherGuideLabel"),
    description: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseTeacherGuideDesc"),
  },
  {
    key: "content.taller_practico",
    label: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseWorkshopLabel"),
    description: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseWorkshopDesc"),
  },
  {
    key: "content.ejercicio",
    label: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseExerciseLabel"),
    description: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseExerciseDesc"),
  },
  {
    key: "content.examen",
    label: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseExamLabel"),
    description: i18n.t("hc_modulesContentsContentPromptsOverridesDialog.useCaseExamDesc"),
  },
];

interface ContentPromptsOverridesDialogProps {
  contentId: string | null;
  onClose: () => void;
  /** Notifica al padre que el override cambió; útil para refrescar el
   *  badge "Prompts personalizados" en el grid. */
  onSaved?: () => void;
}

interface GlobalsState {
  globals: Partial<Record<ContentPromptUseCase, string>>;
  overrides: ContentPromptOverrides;
  loaded: boolean;
}

export function ContentPromptsOverridesDialog({
  contentId,
  onClose,
  onSaved,
}: ContentPromptsOverridesDialogProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<GlobalsState>({
    globals: {},
    overrides: {},
    loaded: false,
  });
  /** Drafts que el usuario está editando. Cada key con valor !== undefined
   *  significa "este prompt está personalizado para este contenido".
   *  `undefined` = "volver al global". String vacío "" se trata como
   *  ausencia al guardar (sanitizado por sanitizeContentPromptOverrides). */
  const [drafts, setDrafts] = useState<ContentPromptOverrides>({});
  const [saving, setSaving] = useState(false);

  const open = contentId !== null;

  useEffect(() => {
    if (!contentId) {
      setState({ globals: {}, overrides: {}, loaded: false });
      setDrafts({});
      return;
    }
    let cancelled = false;
    (async () => {
      // Globales: una sola query con .in() sobre los 6 use_cases.
      // Override del contenido: una query a generated_contents.
      const [{ data: promptRows }, { data: row }] = await Promise.all([
        db
          .from("ai_prompts")
          .select("use_case, system_prompt")
          .in("use_case", CONTENT_PROMPT_USE_CASES as readonly string[])
          .is("course_id", null),
        db
          .from("generated_contents")
          .select("prompt_overrides")
          .eq("id", contentId)
          .maybeSingle(),
      ]);
      if (cancelled) return;
      const globals: Partial<Record<ContentPromptUseCase, string>> = {};
      for (const r of (promptRows ?? []) as Array<{
        use_case: ContentPromptUseCase;
        system_prompt: string;
      }>) {
        globals[r.use_case] = r.system_prompt;
      }
      const overrides = sanitizeContentPromptOverrides(
        (row?.prompt_overrides ?? {}) as Record<string, unknown>,
      );
      setState({ globals, overrides, loaded: true });
      setDrafts(overrides);
    })();
    return () => {
      cancelled = true;
    };
  }, [contentId]);

  const dirty = useMemo(() => {
    // Comparación shallow por key: si una key existe en uno y no en
    // el otro, o el valor difiere, está dirty.
    const a = state.overrides;
    const b = drafts;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = a[k as ContentPromptUseCase];
      const bv = b[k as ContentPromptUseCase];
      if ((av ?? "") !== (bv ?? "")) return true;
    }
    return false;
  }, [state.overrides, drafts]);

  const handleCustomize = (uc: ContentPromptUseCase) => {
    // Toma el global como punto de partida — el docente edita sobre él
    // en lugar de empezar en blanco (mejor UX para cambios pequeños).
    const seed = state.globals[uc] ?? "";
    setDrafts((d) => ({ ...d, [uc]: seed }));
  };

  const handleRevertToGlobal = (uc: ContentPromptUseCase) => {
    setDrafts((d) => {
      const next = { ...d };
      delete next[uc];
      return next;
    });
  };

  const handleSave = async () => {
    if (!contentId) return;
    setSaving(true);
    try {
      const payload = sanitizeContentPromptOverrides(drafts);
      const { error } = await db
        .from("generated_contents")
        .update({ prompt_overrides: payload })
        .eq("id", contentId);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      setState((s) => ({ ...s, overrides: payload }));
      setDrafts(payload);
      toast.success(t("hc_modulesContentsContentPromptsOverridesDialog.savedOk"));
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl max-h-[85dvh] overflow-y-auto" hideCloseButton>
        <DialogHeader>
          <DialogTitle>{t("hc_modulesContentsContentPromptsOverridesDialog.dialogTitle")}</DialogTitle>
          <DialogDescription>
            {t("hc_modulesContentsContentPromptsOverridesDialog.dialogDescription")}
          </DialogDescription>
        </DialogHeader>

        {!state.loaded ? (
          <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> {t("hc_modulesContentsContentPromptsOverridesDialog.loading")}
          </div>
        ) : (
          <div className="space-y-3">
            {USE_CASE_META.map((meta) => {
              const draftVal = drafts[meta.key];
              const customized = typeof draftVal === "string";
              const globalText = state.globals[meta.key] ?? "";
              return (
                <Card key={meta.key}>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 flex-wrap">
                      {meta.label}
                      {customized ? (
                        <Badge
                          className="text-[10px] bg-indigo-500/15 text-indigo-700 border-indigo-500/25 dark:bg-indigo-400/15 dark:text-indigo-300 dark:border-indigo-400/25"
                          data-testid={`badge-customized-${meta.key}`}
                        >
                          {t("hc_modulesContentsContentPromptsOverridesDialog.badgeCustomized")}
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="text-[10px]"
                          data-testid={`badge-global-${meta.key}`}
                        >
                          {t("hc_modulesContentsContentPromptsOverridesDialog.badgeGlobal")}
                        </Badge>
                      )}
                      <HelpHint>{meta.description}</HelpHint>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {customized ? (
                      <>
                        <Textarea
                          rows={6}
                          value={draftVal ?? ""}
                          onChange={(e) =>
                            setDrafts((d) => ({ ...d, [meta.key]: e.target.value }))
                          }
                          className="font-mono text-xs leading-relaxed"
                          placeholder={globalText}
                          aria-label={t("hc_modulesContentsContentPromptsOverridesDialog.promptAriaLabel", { label: meta.label })}
                        />
                        <div className="flex justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRevertToGlobal(meta.key)}
                          >
                            <RotateCcw className="h-4 w-4 mr-1" />
                            {t("hc_modulesContentsContentPromptsOverridesDialog.revertToGlobal")}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-xs text-muted-foreground italic line-clamp-3 flex-1">
                          {globalText || t("hc_modulesContentsContentPromptsOverridesDialog.noGlobalPrompt")}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCustomize(meta.key)}
                        >
                          {t("hc_modulesContentsContentPromptsOverridesDialog.customize")}
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {t("hc_modulesContentsContentPromptsOverridesDialog.cancel")}
          </Button>
          <Button onClick={handleSave} disabled={!dirty || saving}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            {t("hc_modulesContentsContentPromptsOverridesDialog.saveOverrides")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

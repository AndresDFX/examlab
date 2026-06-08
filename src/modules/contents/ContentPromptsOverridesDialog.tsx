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
    label: "Prompt orquestador",
    description:
      "System prompt principal que define el rol del modelo y el contrato de marcadores [INICIO_ARCHIVO]/[FIN_ARCHIVO]. Acepta placeholders {{topic}}, {{primary_color}}, etc.",
  },
  {
    key: "content.presentacion",
    label: "Presentación (PPTX)",
    description:
      "Sub-prompt para PRESENTACION_CLASE_<N>.PPTX cuando el tag 'teorico' está activo.",
  },
  {
    key: "content.guia_docente",
    label: "Guía docente (MD)",
    description: "Sub-prompt para GUIA_DOCENTE_CLASE_<N>.MD (tag 'teorico').",
  },
  {
    key: "content.taller_practico",
    label: "Taller práctico (MD)",
    description: "Sub-prompt para TALLER_PRACTICO_CLASE_<N>.MD (tag 'practico').",
  },
  {
    key: "content.ejercicio",
    label: "Ejercicio + solución (MD)",
    description: "Sub-prompt para EJERCICIO_ESTUDIANTE + EJERCICIO_SOLUCION (tag 'practico').",
  },
  {
    key: "content.examen",
    label: "Examen por sesión (MD)",
    description:
      "Sub-prompt para EXAMEN_CLASE_<N>.MD (tag 'examen'). Solo docente — el estudiante nunca lo ve.",
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
      toast.success(i18n.t("toast.modules_contents_ContentPromptsOverridesDialog.savedOk", { defaultValue: "Prompts personalizados guardados" }));
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
          <DialogTitle>Personalizar prompts de este contenido</DialogTitle>
          <DialogDescription>
            Sobrescribe los prompts globales SOLO para este contenido. Útil para parametrizar el
            mismo tema para diferentes audiencias (universidad, idioma, estilo). Si dejas un prompt
            en "Global", se usa el del módulo de Prompts.
          </DialogDescription>
        </DialogHeader>

        {!state.loaded ? (
          <div className="p-6 text-sm text-muted-foreground flex items-center gap-2">
            <Spinner size="sm" /> Cargando prompts…
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
                          Personalizado
                        </Badge>
                      ) : (
                        <Badge
                          variant="secondary"
                          className="text-[10px]"
                          data-testid={`badge-global-${meta.key}`}
                        >
                          Global
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
                          aria-label={`Prompt ${meta.label}`}
                        />
                        <div className="flex justify-end">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleRevertToGlobal(meta.key)}
                          >
                            <RotateCcw className="h-4 w-4 mr-1" />
                            Volver al global
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-xs text-muted-foreground italic line-clamp-3 flex-1">
                          {globalText || "(sin prompt global configurado)"}
                        </p>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCustomize(meta.key)}
                        >
                          Personalizar
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
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={!dirty || saving}>
            {saving ? (
              <Spinner size="sm" className="mr-1" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            Guardar overrides
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

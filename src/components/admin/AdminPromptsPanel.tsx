/**
 * Panel de configuración de prompts globales de IA (Admin).
 *
 * 5 use_cases con prompts editables. La fila vive en `ai_prompts` con
 * `course_id IS NULL` para los globales. El docente puede pisar por
 * curso desde su propia ruta.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Loader2, RotateCcw, Save } from "lucide-react";
import { useConfirm } from "@/components/ConfirmDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type UseCase =
  | "workshop_full"
  | "workshop_question"
  | "project_file"
  | "project_full"
  | "exam_question"
  | "exam_time_evaluation";

type UseCaseDef = {
  key: UseCase;
  label: string;
  description: string;
  defaultPrompt: string;
};

// Sincronizado con seeds de la migración 20260508100000_ai_prompts.sql.
const USE_CASES: UseCaseDef[] = [
  {
    key: "workshop_full",
    label: "Taller completo",
    description:
      "Calificación de un taller entero (todas las respuestas del estudiante en bloque).",
    defaultPrompt:
      "Eres un evaluador académico imparcial. Calificas entregas de talleres según las instrucciones y rúbrica proporcionadas. Das un puntaje numérico, retroalimentación detallada y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.",
  },
  {
    key: "workshop_question",
    label: "Pregunta de taller",
    description: "Calificación pregunta por pregunta dentro de un taller.",
    defaultPrompt:
      "Eres un evaluador académico imparcial. Calificas la respuesta de un estudiante a UNA pregunta de taller. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.",
  },
  {
    key: "project_file",
    label: "Archivo de proyecto",
    description: "Calificación de un archivo individual del proyecto (texto extraído).",
    defaultPrompt:
      "Eres un evaluador académico imparcial. Calificas el contenido textual de UN archivo del proyecto de un estudiante. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que el contenido haya sido generado por IA.",
  },
  {
    key: "project_full",
    label: "Proyecto completo",
    description: "Calificación holística del proyecto considerando todos los archivos.",
    defaultPrompt:
      "Eres un evaluador académico imparcial y experto. Calificas un proyecto académico basándote en sus archivos. Das nota, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones claras.",
  },
  {
    key: "exam_question",
    label: "Pregunta de examen",
    description: "Calificación de una pregunta abierta de examen (rúbrica + respuesta).",
    defaultPrompt:
      "Eres un evaluador imparcial. Calificas respuestas de exámenes según la rúbrica dada. Das un puntaje, una breve justificación y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA con razones.",
  },
  {
    key: "exam_time_evaluation",
    label: "Evaluación de duración de examen",
    description:
      "Sugiere si la duración asignada a un examen es razonable dadas las preguntas (botón 'Evaluar tiempo con IA' en el editor del examen).",
    defaultPrompt:
      "Eres un experto en diseño de evaluaciones académicas. Recibes el listado de preguntas de un examen (con tipo, enunciado, puntaje y rúbrica esperada) y la duración actual asignada en minutos. Estima cuánto tiempo razonable necesita un estudiante PROMEDIO para resolver cada pregunta, suma los tiempos individuales agregando 10-15% de buffer, y devuelve suggested_minutes (entero), verdict (HOLGADA / AJUSTADA / CORTA / INSUFICIENTE) y explanation breve.",
  },
];

type PromptRow = {
  id: string;
  use_case: UseCase;
  course_id: string | null;
  system_prompt: string;
  updated_at: string;
};

export function AdminPromptsPanel() {
  const { user } = useAuth();
  const confirm = useConfirm();

  const [drafts, setDrafts] = useState<Record<UseCase, string>>(
    Object.fromEntries(USE_CASES.map((u) => [u.key, u.defaultPrompt])) as Record<UseCase, string>,
  );
  const [saved, setSaved] = useState<Record<UseCase, string>>(
    Object.fromEntries(USE_CASES.map((u) => [u.key, u.defaultPrompt])) as Record<UseCase, string>,
  );
  const [rows, setRows] = useState<Record<UseCase, PromptRow | null>>(
    Object.fromEntries(USE_CASES.map((u) => [u.key, null])) as Record<UseCase, PromptRow | null>,
  );
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<UseCase | null>(null);

  const load = async () => {
    setLoading(true);
    const { data, error } = await db
      .from("ai_prompts")
      .select("id, use_case, course_id, system_prompt, updated_at")
      .is("course_id", null);
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    const nextDrafts = { ...drafts };
    const nextSaved = { ...saved };
    const nextRows = { ...rows };
    for (const uc of USE_CASES) {
      const found = (data ?? []).find((r: PromptRow) => r.use_case === uc.key);
      if (found) {
        nextDrafts[uc.key] = found.system_prompt;
        nextSaved[uc.key] = found.system_prompt;
        nextRows[uc.key] = found;
      } else {
        nextDrafts[uc.key] = uc.defaultPrompt;
        nextSaved[uc.key] = uc.defaultPrompt;
        nextRows[uc.key] = null;
      }
    }
    setDrafts(nextDrafts);
    setSaved(nextSaved);
    setRows(nextRows);
    setLoading(false);
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSave = async (uc: UseCaseDef) => {
    if (!user) return;
    const text = drafts[uc.key].trim();
    if (!text) {
      toast.error("El prompt no puede estar vacío");
      return;
    }
    setSavingKey(uc.key);
    try {
      const existing = rows[uc.key];
      if (existing) {
        const { error } = await db
          .from("ai_prompts")
          .update({ system_prompt: text, updated_by: user.id })
          .eq("id", existing.id);
        if (error) {
          toast.error(error.message);
          return;
        }
      } else {
        const { error } = await db.from("ai_prompts").insert({
          use_case: uc.key,
          course_id: null,
          system_prompt: text,
          updated_by: user.id,
        });
        if (error) {
          toast.error(error.message);
          return;
        }
      }
      toast.success(`Prompt "${uc.label}" actualizado`);
      await load();
    } finally {
      setSavingKey(null);
    }
  };

  const handleRestoreDefault = async (uc: UseCaseDef) => {
    const ok = await confirm({
      title: `Restaurar default de "${uc.label}"`,
      description:
        "Volverás al prompt por defecto del sistema. Los overrides por curso (si existen) no se ven afectados.",
      confirmLabel: "Restaurar",
      tone: "warning",
    });
    if (!ok) return;
    setDrafts((d) => ({ ...d, [uc.key]: uc.defaultPrompt }));
    if (!user) return;
    setSavingKey(uc.key);
    try {
      const existing = rows[uc.key];
      if (existing) {
        const { error } = await db
          .from("ai_prompts")
          .update({ system_prompt: uc.defaultPrompt, updated_by: user.id })
          .eq("id", existing.id);
        if (error) {
          toast.error(error.message);
          return;
        }
      } else {
        const { error } = await db.from("ai_prompts").insert({
          use_case: uc.key,
          course_id: null,
          system_prompt: uc.defaultPrompt,
          updated_by: user.id,
        });
        if (error) {
          toast.error(error.message);
          return;
        }
      }
      toast.success(`"${uc.label}" restaurado al default`);
      await load();
    } finally {
      setSavingKey(null);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Cargando prompts…
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="grid gap-4">
      {USE_CASES.map((uc) => {
        const dirty = drafts[uc.key] !== saved[uc.key];
        const isDefault = saved[uc.key] === uc.defaultPrompt;
        return (
          <Card key={uc.key}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                {uc.label}
                {isDefault ? (
                  <Badge variant="secondary" className="text-[10px]">
                    Default
                  </Badge>
                ) : (
                  <Badge className="text-[10px] bg-indigo-500/15 text-indigo-700 border-indigo-500/25 dark:bg-indigo-400/15 dark:text-indigo-300 dark:border-indigo-400/25">
                    Personalizado
                  </Badge>
                )}
              </CardTitle>
              <p className="text-xs text-muted-foreground mt-1">{uc.description}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                rows={6}
                value={drafts[uc.key]}
                onChange={(e) => setDrafts((d) => ({ ...d, [uc.key]: e.target.value }))}
                placeholder={uc.defaultPrompt}
                className="font-mono text-xs leading-relaxed"
              />
              <p className="text-[11px] text-muted-foreground">
                Solo edita el rol/criterios del modelo. Los datos dinámicos (rúbrica, respuesta del
                estudiante, idioma, puntaje máximo) se inyectan automáticamente por la función — no
                necesitas placeholders.
              </p>
              <div className="flex flex-wrap gap-2 justify-end">
                {dirty && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDrafts((d) => ({ ...d, [uc.key]: saved[uc.key] }))}
                    disabled={savingKey === uc.key}
                  >
                    Cancelar
                  </Button>
                )}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleRestoreDefault(uc)}
                  disabled={savingKey === uc.key || isDefault}
                >
                  <RotateCcw className="h-4 w-4 mr-1" />
                  Restaurar default
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleSave(uc)}
                  disabled={savingKey === uc.key || !dirty}
                >
                  {savingKey === uc.key ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Guardar
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

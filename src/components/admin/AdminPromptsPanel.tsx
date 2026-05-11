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
import { logEvent } from "@/lib/audit";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { HelpHint } from "@/components/ui/help-hint";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, RotateCcw, Save, Palette } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/components/ConfirmDialog";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

type UseCase =
  | "workshop_full"
  | "workshop_question"
  | "project_file"
  | "project_full"
  | "exam_question"
  | "exam_time_evaluation"
  | "plagiarism_detection"
  | "ai_content_detection"
  | "project_description"
  | "project_questions"
  | "content_generation";

/** Categorización por módulo para el filtro de la UI. NO se persiste —
 * solo agrupa visualmente los prompts en el Select de filtro. Si se
 * agrega un nuevo use_case, hay que asignarle module aquí. */
type PromptModule = "exams" | "workshops" | "projects" | "fraud" | "contents";

type UseCaseDef = {
  key: UseCase;
  module: PromptModule;
  label: string;
  description: string;
  defaultPrompt: string;
};

const MODULE_LABELS: Record<PromptModule, string> = {
  exams: "Exámenes",
  workshops: "Talleres",
  projects: "Proyectos",
  fraud: "Detección de fraude",
  contents: "Contenidos",
};

// Sincronizado con seeds de la migración 20260508100000_ai_prompts.sql.
const USE_CASES: UseCaseDef[] = [
  {
    key: "workshop_full",
    module: "workshops",
    label: "Taller completo",
    description:
      "Calificación de un taller entero (todas las respuestas del estudiante en bloque).",
    defaultPrompt:
      "Eres un evaluador académico imparcial. Calificas entregas de talleres según las instrucciones y rúbrica proporcionadas. Das un puntaje numérico, retroalimentación detallada y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.",
  },
  {
    key: "workshop_question",
    module: "workshops",
    label: "Pregunta de taller",
    description: "Calificación pregunta por pregunta dentro de un taller.",
    defaultPrompt:
      "Eres un evaluador académico imparcial. Calificas la respuesta de un estudiante a UNA pregunta de taller. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA.",
  },
  {
    key: "project_file",
    module: "projects",
    label: "Archivo de proyecto",
    description: "Calificación de un archivo individual del proyecto (texto extraído).",
    defaultPrompt:
      "Eres un evaluador académico imparcial. Calificas el contenido textual de UN archivo del proyecto de un estudiante. Das un puntaje, retroalimentación útil y una estimación de probabilidad (0..1) de que el contenido haya sido generado por IA.",
  },
  {
    key: "project_full",
    module: "projects",
    label: "Proyecto completo",
    description: "Calificación holística del proyecto considerando todos los archivos.",
    defaultPrompt:
      "Eres un evaluador académico imparcial y experto. Calificas un proyecto académico basándote en sus archivos. Das nota, retroalimentación detallada y una estimación de probabilidad (0..1) de que el contenido fue generado por IA, con razones claras.",
  },
  {
    key: "exam_question",
    module: "exams",
    label: "Pregunta de examen",
    description: "Calificación de una pregunta abierta de examen (rúbrica + respuesta).",
    defaultPrompt:
      "Eres un evaluador imparcial. Calificas respuestas de exámenes según la rúbrica dada. Das un puntaje, una breve justificación y una estimación de probabilidad (0..1) de que la respuesta haya sido generada por IA con razones.",
  },
  {
    key: "exam_time_evaluation",
    module: "exams",
    label: "Evaluación de duración de examen",
    description:
      "Sugiere si la duración asignada a un examen es razonable dadas las preguntas (botón 'Evaluar tiempo con IA' en el editor del examen).",
    defaultPrompt:
      "Eres un experto en diseño de evaluaciones académicas. Recibes el listado de preguntas de un examen (con tipo, enunciado, puntaje y rúbrica esperada) y la duración actual asignada en minutos. Estima cuánto tiempo razonable necesita un estudiante PROMEDIO para resolver cada pregunta, suma los tiempos individuales agregando 10-15% de buffer, y devuelve suggested_minutes (entero), verdict (HOLGADA / AJUSTADA / CORTA / INSUFICIENTE) y explanation breve.",
  },
  {
    key: "plagiarism_detection",
    module: "fraud",
    label: "Detección de copia entre estudiantes",
    description:
      "Prompt que usa el botón 'Detectar copias' (FraudPanel) para comparar respuestas de la misma pregunta y reportar pares sospechosos.",
    defaultPrompt:
      "Eres un detector de copia académica entre estudiantes. Recibes el enunciado de la pregunta y una lista numerada de respuestas a la MISMA pregunta. Identifica pares cuyas similitudes NO se justifican por el enunciado (mismos nombres de variables no pedidos, mismos strings, mismos errores, mismos comentarios). Para cada par sospechoso devuelve idx_a, idx_b, score (0..1) y una razón breve citando los marcadores específicos.",
  },
  {
    key: "ai_content_detection",
    module: "fraud",
    label: "Detección de respuestas generadas por IA",
    description:
      "Reglas que se anexan a los prompts de calificación (talleres, proyectos, exámenes) para que el modelo estime la probabilidad de que la respuesta haya sido generada por IA y devuelva ai_likelihood + ai_reasons.",
    defaultPrompt:
      "Estima la probabilidad (0..1) de que la respuesta haya sido generada por IA. Considera prosa demasiado pulida, estructura genérica, terminología fuera de la rúbrica, ausencia de voz personal, repetición del enunciado y respuestas exhaustivas para preguntas cortas. En ai_reasons cita marcadores concretos de la respuesta. Si no hay señales fuertes, retorna probabilidad baja y explica brevemente por qué parece humana.",
  },
  {
    key: "project_description",
    module: "projects",
    label: "Descripción de proyecto (contexto global)",
    description:
      "Genera la descripción de un proyecto a partir de un tema. La descripción se usa como contexto global para que cada pregunta del proyecto tenga sentido por sí sola y en el conjunto. Disparado por 'Generar con IA' en el campo Descripción del editor de proyectos.",
    defaultPrompt:
      "Eres un docente experto que redacta la descripción de un proyecto académico. Sé concreto y conciso (3-6 oraciones). Indica el propósito, alcance y restricciones. NO listes entregables uno por uno (van en cada pregunta). NO uses encabezados Markdown — texto plano corrido. Devuelve solo la descripción.",
  },
  {
    key: "content_generation",
    module: "contents",
    label: "Generación de contenidos académicos",
    description:
      "Prompt usado por el módulo Contenidos para generar PRESENTACION.PPTX, GUIA_DOCENTE.MD y/o TALLER_PRACTICO.MD según la modalidad y duración indicadas. Acepta placeholders {{topic}}, {{n_classes}}, {{duration_minutes}}, {{modality_label}}, {{university_name}}, {{logo_url}}, {{primary_color}}, {{secondary_color}} y {{rag_context_documents}}.",
    defaultPrompt:
      "Eres un Arquitecto de Contenido Educativo. Tu objetivo es generar estructuras de datos pedagógicas y precisas para cualquier disciplina académica, las cuales la plataforma utilizará para crear archivos descargables (.pptx y .md). Devuelve EXCLUSIVAMENTE bloques [INICIO_ARCHIVO: X.PPTX|MD]…[FIN_ARCHIVO: X.PPTX|MD] sin texto fuera de las etiquetas. Respeta la duración (extensión proporcional) y la modalidad (qué archivos generar).",
  },
  {
    key: "project_questions",
    module: "projects",
    label: "Preguntas del proyecto (auto-generadas desde la descripción)",
    description:
      "A partir de la descripción del proyecto, genera el set de preguntas/entregables. Restricción dura: SIEMPRE 1 pregunta tipo 'codigo_zip' (ZIP del código fuente) + entre 2 y 5 preguntas adicionales (abierta/diagrama/cerrada) para evaluar análisis y diseño por separado. Disparado por 'Generar preguntas con IA' en el editor de preguntas del proyecto.",
    defaultPrompt:
      'Eres un docente experto que diseña la ESTRUCTURA DE EVALUACIÓN de un proyecto académico de programación. Recibes la descripción del proyecto (propósito, alcance, restricciones) y debes proponer el conjunto de preguntas/entregables que evalúen distintos aspectos del trabajo de forma SEPARADA.\n\nREGLAS OBLIGATORIAS:\n  1. Devuelve EXACTAMENTE UNA pregunta de tipo "codigo_zip" — ahí el estudiante subirá el ZIP con todo el código fuente del proyecto. Su título debe nombrar el entregable (ej: "Código fuente del proyecto") y la descripción debe enunciar el alcance esperado del código (qué módulos/funcionalidades debe incluir, qué lenguaje/stack se asume) sin repetir lo que ya está en la descripción global.\n  2. Genera entre 2 y 5 preguntas adicionales, todas con tipo distinto a "codigo_zip", que evalúen aspectos cualitativos del proyecto por separado. Cada pregunta debe ser INDEPENDIENTE — el estudiante la responde y la IA la califica sin necesidad de leer las demás.\n  3. Tipos permitidos para esas preguntas adicionales:\n       - "abierta": respuesta libre en texto (justificación, análisis, decisiones de diseño, manual de usuario, conclusiones).\n       - "diagrama": entrega de un diagrama (UML, arquitectura, flujo de datos) — el estudiante pega el código fuente del diagrama o adjunta una imagen.\n       - "cerrada": opción múltiple, solo cuando el aspecto a evaluar tiene una respuesta correcta clara y discreta.\n  4. Cada pregunta debe traer:\n       - title: corto (≤ 80 caracteres), descriptivo del entregable.\n       - description: instrucciones claras desde la perspectiva del estudiante (qué se le pide entregar y cómo).\n       - type: uno de "codigo_zip" | "abierta" | "diagrama" | "cerrada".\n       - expected_rubric: criterios objetivos para calificar (qué se considera respuesta completa vs incompleta vs incorrecta).\n  5. NO repitas en las preguntas información que ya esté en la descripción global. Cada pregunta agrega especificidad sobre QUÉ entregar y CÓMO se calificará, no re-explica el proyecto.\n  6. Equilibra los aspectos: incluye al menos una pregunta que pida JUSTIFICAR decisiones de diseño / análisis (tipo "abierta") y, si tiene sentido para el proyecto, una de "diagrama". No sobrecargues con preguntas redundantes.\n  7. Usa el idioma indicado en el mensaje del usuario.\n\nDevuelve solo el conjunto estructurado de preguntas vía la herramienta `build_project_questions`. NO escribas texto fuera de la herramienta.',
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
  // Configuración de marca (singleton row de `content_brand_config`).
  // Vive aquí en vez de en una pantalla separada: como solo se usa para
  // generar Contenidos, conviene editarla junto al prompt que la
  // consume. Cuando el filtro de módulo es "Contenidos" o "Todos",
  // mostramos un Card extra con estos campos antes del prompt.
  const [brand, setBrand] = useState<{
    id?: string;
    university_name: string;
    logo_url: string | null;
    primary_color: string;
    secondary_color: string;
    author_default: string | null;
  }>({
    university_name: "",
    logo_url: null,
    primary_color: "#1e40af",
    secondary_color: "#64748b",
    author_default: null,
  });
  const [savingBrand, setSavingBrand] = useState(false);
  // Filtro por módulo. "all" muestra todos los prompts; otros valores
  // filtran a una sola categoría (Exámenes / Talleres / Proyectos /
  // Detección de fraude). Solo visual — no afecta la BD.
  const [moduleFilter, setModuleFilter] = useState<PromptModule | "all">("all");
  const filteredUseCases = USE_CASES.filter(
    (uc) => moduleFilter === "all" || uc.module === moduleFilter,
  );

  const load = async () => {
    setLoading(true);
    const [{ data, error }, { data: brandRow }] = await Promise.all([
      db
        .from("ai_prompts")
        .select("id, use_case, course_id, system_prompt, updated_at")
        .is("course_id", null),
      db.from("content_brand_config").select("*").maybeSingle(),
    ]);
    if (error) {
      toast.error(error.message);
      setLoading(false);
      return;
    }
    if (brandRow) {
      setBrand({
        id: brandRow.id,
        university_name: brandRow.university_name ?? "",
        logo_url: brandRow.logo_url ?? null,
        primary_color: brandRow.primary_color ?? "#1e40af",
        secondary_color: brandRow.secondary_color ?? "#64748b",
        author_default: brandRow.author_default ?? null,
      });
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

  const handleSaveBrand = async () => {
    if (!user) return;
    setSavingBrand(true);
    try {
      const payload = {
        university_name: brand.university_name,
        logo_url: brand.logo_url,
        primary_color: brand.primary_color,
        secondary_color: brand.secondary_color,
        author_default: brand.author_default,
        updated_at: new Date().toISOString(),
        updated_by: user.id,
      };
      const { error } = brand.id
        ? await db.from("content_brand_config").update(payload).eq("id", brand.id)
        : await db.from("content_brand_config").insert(payload);
      if (error) {
        toast.error(error.message);
        return;
      }
      void logEvent({
        action: brand.id ? "branding.updated" : "branding.created",
        category: "system",
        severity: "warning",
        entityType: "branding",
        entityId: brand.id ?? undefined,
        entityName: brand.university_name ?? null,
        metadata: {
          university_name: brand.university_name,
          primary_color: brand.primary_color,
          secondary_color: brand.secondary_color,
          has_logo: !!brand.logo_url,
          author_default: brand.author_default,
        },
      });
      toast.success("Marca institucional actualizada");
      await load();
    } finally {
      setSavingBrand(false);
    }
  };

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
      const previousText = existing?.system_prompt ?? null;
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
      void logEvent({
        action: "ai_prompt.updated",
        category: "system",
        severity: "warning",
        entityType: "ai_prompt",
        entityId: existing?.id ?? undefined,
        entityName: uc.label,
        metadata: {
          use_case: uc.key,
          scope: "global",
          length_before: previousText?.length ?? null,
          length_after: text.length,
        },
      });
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
      void logEvent({
        action: "ai_prompt.restored_default",
        category: "system",
        severity: "warning",
        entityType: "ai_prompt",
        entityId: existing?.id ?? undefined,
        entityName: uc.label,
        metadata: { use_case: uc.key, scope: "global" },
      });
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
    <div className="space-y-4">
      {/* Filtro por módulo: agrupa visualmente los use_cases por área de
          la app (Exámenes / Talleres / Proyectos / Detección de fraude).
          Solo afecta el render — no toca la BD. */}
      <div className="flex flex-wrap items-end gap-3 rounded-md border bg-muted/30 p-3">
        <div className="flex-1 min-w-48">
          <Label className="text-xs">Módulo</Label>
          <Select
            value={moduleFilter}
            onValueChange={(v) => setModuleFilter(v as PromptModule | "all")}
          >
            <SelectTrigger className="mt-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos los módulos</SelectItem>
              {(["exams", "workshops", "projects", "fraud", "contents"] as const).map((m) => (
                <SelectItem key={m} value={m}>
                  {MODULE_LABELS[m]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Badge variant="outline" className="text-[11px] tabular-nums h-6">
          {filteredUseCases.length} de {USE_CASES.length} prompt(s)
        </Badge>
      </div>

      <div className="grid gap-4">
        {/* Campos especiales del módulo Contenidos: marca institucional
            (logo, colores, autor por defecto). Aparecen cuando el filtro
            es "all" o "contents" — son los datos que el prompt
            content_generation interpola en {{university_name}},
            {{logo_url}}, {{primary_color}}, {{secondary_color}} antes de
            llamar a la IA. Vivían en una página aparte; ahora están
            junto al prompt que los consume. */}
        {(moduleFilter === "all" || moduleFilter === "contents") && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2 flex-wrap">
                <Palette className="h-4 w-4 text-primary" />
                Marca institucional (Contenidos)
                <Badge variant="outline" className="text-[10px]">
                  Campos especiales
                </Badge>
                <HelpHint>
                  Estos valores se inyectan al prompt de Generación de contenidos como{" "}
                  <code>{`{{university_name}}`}</code>, <code>{`{{logo_url}}`}</code>,{" "}
                  <code>{`{{primary_color}}`}</code> y <code>{`{{secondary_color}}`}</code>.
                  Aparecen también en la portada del .pptx generado.
                </HelpHint>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Nombre de la institución</Label>
                  <Input
                    value={brand.university_name}
                    onChange={(e) => setBrand({ ...brand, university_name: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">URL del logo</Label>
                  <Input
                    type="url"
                    placeholder="https://…/logo.png"
                    value={brand.logo_url ?? ""}
                    onChange={(e) => setBrand({ ...brand, logo_url: e.target.value || null })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Color primario</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="color"
                      className="h-9 w-14 p-1"
                      value={brand.primary_color}
                      onChange={(e) => setBrand({ ...brand, primary_color: e.target.value })}
                    />
                    <Input
                      value={brand.primary_color}
                      onChange={(e) => setBrand({ ...brand, primary_color: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Color secundario</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="color"
                      className="h-9 w-14 p-1"
                      value={brand.secondary_color}
                      onChange={(e) => setBrand({ ...brand, secondary_color: e.target.value })}
                    />
                    <Input
                      value={brand.secondary_color}
                      onChange={(e) => setBrand({ ...brand, secondary_color: e.target.value })}
                    />
                  </div>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label className="text-xs">Autor por defecto</Label>
                  <Input
                    value={brand.author_default ?? ""}
                    onChange={(e) => setBrand({ ...brand, author_default: e.target.value || null })}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Aparece en la portada cuando el docente no indica autor.
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button onClick={handleSaveBrand} disabled={savingBrand}>
                  {savingBrand ? (
                    <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4 mr-1" />
                  )}
                  Guardar marca
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
        {filteredUseCases.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground text-center">
              No hay prompts en este módulo.
            </CardContent>
          </Card>
        ) : null}
        {filteredUseCases.map((uc) => {
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
                  <HelpHint>
                    {uc.description}
                    <br />
                    <br />
                    Solo edita el rol/criterios del modelo. Los datos dinámicos (rúbrica, respuesta
                    del estudiante, idioma, puntaje máximo) se inyectan automáticamente por la
                    función — no necesitas placeholders.
                  </HelpHint>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  rows={6}
                  value={drafts[uc.key]}
                  onChange={(e) => setDrafts((d) => ({ ...d, [uc.key]: e.target.value }))}
                  placeholder={uc.defaultPrompt}
                  className="font-mono text-xs leading-relaxed"
                />
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
    </div>
  );
}

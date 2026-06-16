/**
 * Editor reusable de plantillas de informe.
 *
 * Una columna izquierda con tabs Body / Header / Footer / CSS (textarea
 * con tipografía monospace) + sidebar derecho con el catálogo de
 * variables clickables (`REPORT_VARIABLE_CATALOG`). Click en una
 * variable inserta el snippet en la posición del cursor del tab activo.
 *
 * No es WYSIWYG a propósito — los docentes que llegan a este editor
 * saben pegar HTML; los demás usan las plantillas pre-armadas y solo
 * editan las variables. WYSIWYG real necesitaría un editor pesado
 * (TipTap, ProseMirror) y sigue sin resolver el problema de inyectar
 * `{{#each}}` correctamente. Esto es deliberadamente simple.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { HelpHint } from "@/components/ui/help-hint";
import { ChevronDown, ChevronRight, Code2, Eye, Sparkles } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
  reportCatalogForScope,
  variableSnippet,
  renderTemplate,
  buildSampleReportContext,
  type VariableNode,
  type TemplateContext,
} from "./template-engine";
import { RichTextEditor, type RichTextEditorHandle } from "./RichTextEditor";
import { PAGE_BREAK_HTML } from "./docx-import";

export interface TemplateDraft {
  name: string;
  description: string;
  scope: "estudiante" | "curso";
  body_html: string;
  header_html: string;
  footer_html: string;
  css: string;
  page_orientation: "portrait" | "landscape";
  page_size: "A4" | "letter";
}

interface Props {
  value: TemplateDraft;
  onChange: (next: TemplateDraft) => void;
  /** Solo el body es obligatorio. Header/Footer/CSS son opcionales. */
  showMetadata?: boolean;
  /** Nodos extra para el catálogo (ej. cuando el scope es 'curso' se
   *  habilita la sección {{#each estudiantes}}). Por default usa el catálogo
   *  completo y deja al docente decidir. */
  catalog?: VariableNode[];
  /**
   * Contexto de RESPALDO para la vista previa cuando aún no se cargó un curso
   * real (datos de muestra + marca del tenant). En cuanto el docente elige un
   * curso, el preview usa los datos REALES de `loadPreviewContext`.
   */
  previewContext?: TemplateContext;
  /** Cursos del docente — alimentan los selectores de curso (preview + IA). */
  courses?: { id: string; name: string }[];
  /**
   * Carga el contexto REAL (no mock) para previsualizar: notas, asistencia y
   * lista de estudiantes del curso (y de UN estudiante en scope 'estudiante').
   * Devuelve null si el curso no tiene datos (cae al contexto de muestra).
   */
  loadPreviewContext?: (args: {
    courseId: string;
    studentId?: string;
  }) => Promise<TemplateContext | null>;
  /** Estudiantes matriculados de un curso (para el selector en scope 'estudiante'). */
  loadCourseStudents?: (courseId: string) => Promise<{ id: string; full_name: string }[]>;
  /**
   * Si se provee, habilita la acción "Generación IA" en el panel de variables:
   * el docente sitúa el cursor, pide un prompt y la IA inserta el contenido
   * EXACTAMENTE donde está el cursor. Usa el curso/estudiante elegido en la
   * vista previa como fuente de datos reales. Devuelve el HTML generado (o null
   * si falló — el caller maneja el toast/fallback).
   */
  onAiGenerate?: (args: {
    instruction: string;
    courseId: string;
    studentId?: string;
  }) => Promise<string | null>;
}

type EditTab = "body" | "header" | "footer" | "css";
type Tab = EditTab | "preview";

export function TemplateEditor({
  value,
  onChange,
  showMetadata = true,
  catalog,
  previewContext,
  courses,
  loadPreviewContext,
  loadCourseStudents,
  onAiGenerate,
}: Props) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<Tab>("body");
  // Modo de edición del CUERPO: "visual" (WYSIWYG) por default, "html" para
  // avanzados (bloques {{#each}}/{{#if}}). Header/Footer/CSS siguen en textarea.
  const [bodyMode, setBodyMode] = useState<"visual" | "html">("visual");
  const richRef = useRef<RichTextEditorHandle>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLTextAreaElement>(null);
  const footerRef = useRef<HTMLTextAreaElement>(null);
  const cssRef = useRef<HTMLTextAreaElement>(null);

  const refFor = (tab: EditTab) =>
    tab === "body" ? bodyRef : tab === "header" ? headerRef : tab === "footer" ? footerRef : cssRef;

  const fieldFor = (tab: EditTab): keyof TemplateDraft =>
    tab === "body" ? "body_html"
      : tab === "header" ? "header_html"
        : tab === "footer" ? "footer_html"
          : "css";

  // ── Datos REALES para la vista previa (no mock) ──
  // El docente elige un curso (y un estudiante, en scope 'estudiante') y el
  // preview se renderiza con sus datos reales: notas, asistencia, lista de
  // estudiantes. Hasta que haya un curso elegido, cae a `previewContext`
  // (muestra + marca del tenant).
  const [pvCourseId, setPvCourseId] = useState<string>("");
  const [pvStudentId, setPvStudentId] = useState<string>("");
  const [pvStudents, setPvStudents] = useState<{ id: string; full_name: string }[]>([]);
  const [pvCtx, setPvCtx] = useState<TemplateContext | null>(null);
  const [pvLoading, setPvLoading] = useState(false);

  // Auto-seleccionar el primer curso al montar → datos reales de entrada.
  useEffect(() => {
    if (!pvCourseId && courses && courses.length > 0) setPvCourseId(courses[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses]);

  // Estudiantes del curso (solo scope 'estudiante', para "situar" las variables).
  useEffect(() => {
    if (!pvCourseId || value.scope !== "estudiante" || !loadCourseStudents) {
      setPvStudents([]);
      setPvStudentId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const list = await loadCourseStudents(pvCourseId);
      if (cancelled) return;
      setPvStudents(list);
      setPvStudentId((prev) => (list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? "")));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvCourseId, value.scope]);

  // Contexto REAL cuando cambia curso/estudiante.
  useEffect(() => {
    if (!pvCourseId || !loadPreviewContext) {
      setPvCtx(null);
      return;
    }
    if (value.scope === "estudiante" && !pvStudentId) {
      setPvCtx(null);
      return;
    }
    let cancelled = false;
    setPvLoading(true);
    void (async () => {
      const ctx = await loadPreviewContext({
        courseId: pvCourseId,
        studentId: value.scope === "estudiante" ? pvStudentId : undefined,
      });
      if (cancelled) return;
      setPvCtx(ctx);
      setPvLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pvCourseId, pvStudentId, value.scope]);

  // HTML compuesto para la vista previa. Se RENDERIZA con datos REALES del
  // curso/estudiante elegido (o la muestra/marca del tenant como respaldo) —
  // nunca se muestran los {{placeholders}} crudos.
  const previewHtml = useMemo(
    () => composePreviewHtml(value, pvCtx ?? previewContext),
    [value, pvCtx, previewContext],
  );

  // Número de páginas del cuerpo = saltos de página + 1. Sirve para mostrar
  // "N páginas" mientras se edita y los números de página en el preview.
  const pageCount = useMemo(
    () => (value.body_html || "").split(PAGE_BREAK_HTML).length,
    [value.body_html],
  );

  const insertAtCursor = (snippet: string, asHtml = false) => {
    // En la pestaña de vista previa no hay dónde insertar → pasamos al cuerpo.
    if (activeTab === "preview") {
      setActiveTab("body");
      // El cuerpo ya estaba montado en background (Tabs no desmonta), así que
      // la selección guardada del editor visual sigue válida.
    }
    // En el cuerpo en modo Visual, insertamos en el cursor del editor WYSIWYG.
    // El editor RESALTA todo token {{...}} en otro color por su cuenta (sólo en
    // el editor — el body_html guardado/exportado va limpio), así que acá
    // insertamos texto/markup PLANO. El contenido de IA sí se envuelve en un
    // bloque `.examlab-added` (es texto libre, no un token detectable).
    if ((activeTab === "preview" || activeTab === "body") && bodyMode === "visual") {
      if (asHtml) {
        // Contenido de IA = bloque resaltado.
        richRef.current?.insertHtml(`<div class="examlab-added">${snippet}</div>`);
      } else if (/\{\{[#/]/.test(snippet)) {
        // Bloque de control ({{#each}}/{{#if}}): insertarlo como un <span> inline
        // PARTE el par en contentEditable y rompe {{#each}}…{{/each}} → el
        // preview no itera. Lo insertamos como bloques: apertura / línea editable
        // / cierre, para que el par quede intacto y el docente escriba en medio.
        // Los tokens los colorea el editor automáticamente.
        const open = snippet.split("\n")[0];
        const close = snippet.trim().split("\n").pop() ?? "{{/each}}";
        richRef.current?.insertHtml(`<div>${open}</div><div><br></div><div>${close}</div>`);
      } else {
        // Variable escalar → texto plano; el editor la colorea como {{token}}.
        richRef.current?.insertText(snippet);
      }
      return;
    }
    const tab: EditTab = activeTab === "preview" ? "body" : activeTab;
    const field = fieldFor(tab);
    const ref = refFor(tab).current;
    if (!ref) return;
    const start = ref.selectionStart ?? 0;
    const end = ref.selectionEnd ?? 0;
    const current = (value[field] as string) ?? "";
    const next = current.slice(0, start) + snippet + current.slice(end);
    onChange({ ...value, [field]: next });
    // Re-posicionar cursor al final del snippet insertado (next tick).
    requestAnimationFrame(() => {
      const r = refFor(tab).current;
      if (!r) return;
      const newPos = start + snippet.length;
      r.focus();
      r.setSelectionRange(newPos, newPos);
    });
  };

  // ── Generación IA inline (insertar en el cursor) ──
  // Usa el MISMO curso/estudiante elegido para la vista previa como fuente de
  // datos reales (no un selector aparte).
  const [aiOpen, setAiOpen] = useState(false);
  const [aiInstruction, setAiInstruction] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const pvCourseName = courses?.find((c) => c.id === pvCourseId)?.name ?? "";
  const pvStudentName = pvStudents.find((s) => s.id === pvStudentId)?.full_name ?? "";

  const openAi = () => {
    setAiInstruction("");
    setAiOpen(true);
  };

  const runAi = async () => {
    if (!onAiGenerate || !pvCourseId || !aiInstruction.trim()) return;
    setAiBusy(true);
    const html = await onAiGenerate({
      instruction: aiInstruction,
      courseId: pvCourseId,
      studentId: value.scope === "estudiante" ? pvStudentId || undefined : undefined,
    });
    setAiBusy(false);
    if (html == null) return; // el caller ya mostró el error/fallback.
    setAiOpen(false);
    // Insertar tras cerrar el diálogo (el foco vuelve al editor; la selección
    // guardada al abrir el diálogo sigue válida → cae donde el docente estaba).
    setTimeout(() => insertAtCursor(html, true), 60);
  };

  // Las variables del panel derecho DEPENDEN del tipo de informe: por
  // estudiante muestra las del alumno único; por curso, el grupo consolidado
  // `{{#each estudiantes}}`. Un `catalog` explícito (prop) lo sobreescribe.
  const effectiveCatalog = useMemo(
    () => catalog ?? reportCatalogForScope(value.scope),
    [catalog, value.scope],
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3">
      <div className="space-y-3">
        {showMetadata && (
          <Card>
            <CardContent className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {/* PRIMERO el tipo de informe (scope): de él dependen las
                  variables del panel derecho y los datos que usa la IA
                  (curso completo vs un estudiante). */}
              <div className="space-y-1 sm:col-span-2">
                <Label required>
                  {t("hc_modulesReportsTemplateEditor.labelReportType")}{" "}
                  <HelpHint>{t("help.reportScopeHelp")}</HelpHint>
                </Label>
                <Select
                  value={value.scope}
                  onValueChange={(v) => onChange({ ...value, scope: v as "estudiante" | "curso" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="estudiante">{t("hc_modulesReportsTemplateEditor.scopeStudent")}</SelectItem>
                    <SelectItem value="curso">{t("hc_modulesReportsTemplateEditor.scopeCourse")}</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">
                  {t("hc_modulesReportsTemplateEditor.scopeFirstHint", {
                    defaultValue:
                      "Elígelo primero: define qué variables aparecen a la derecha y qué datos usa la IA (todo el curso o un estudiante).",
                  })}
                </p>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label required>{t("hc_modulesReportsTemplateEditor.labelName")}</Label>
                <Input
                  value={value.name}
                  onChange={(e) => onChange({ ...value, name: e.target.value })}
                  placeholder={t("hc_modulesReportsTemplateEditor.placeholderName")}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>{t("hc_modulesReportsTemplateEditor.labelDescription")}</Label>
                <Input
                  value={value.description}
                  onChange={(e) => onChange({ ...value, description: e.target.value })}
                  placeholder={t("hc_modulesReportsTemplateEditor.placeholderDescription")}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("hc_modulesReportsTemplateEditor.labelOrientation")}</Label>
                <Select
                  value={value.page_orientation}
                  onValueChange={(v) =>
                    onChange({ ...value, page_orientation: v as "portrait" | "landscape" })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="portrait">{t("hc_modulesReportsTemplateEditor.orientationPortrait")}</SelectItem>
                    <SelectItem value="landscape">{t("hc_modulesReportsTemplateEditor.orientationLandscape")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("hc_modulesReportsTemplateEditor.labelSize")}</Label>
                <Select
                  value={value.page_size}
                  onValueChange={(v) => onChange({ ...value, page_size: v as "A4" | "letter" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A4">A4</SelectItem>
                    <SelectItem value="letter">{t("hc_modulesReportsTemplateEditor.sizeLetter")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-3">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as typeof activeTab)}>
              <TabsList>
                <TabsTrigger value="body">
                  <Code2 className="h-3.5 w-3.5 mr-1" />
                  {t("hc_modulesReportsTemplateEditor.tabBody")}
                </TabsTrigger>
                <TabsTrigger value="header">{t("hc_modulesReportsTemplateEditor.tabHeader")}</TabsTrigger>
                <TabsTrigger value="footer">{t("hc_modulesReportsTemplateEditor.tabFooter")}</TabsTrigger>
                <TabsTrigger value="css">CSS</TabsTrigger>
                <TabsTrigger value="preview">
                  <Eye className="h-3.5 w-3.5 mr-1" />
                  {t("hc_modulesReportsTemplateEditor.tabPreview")}
                </TabsTrigger>
              </TabsList>
              <TabsContent value="body" className="mt-2 space-y-2">
                {/* Toggle Visual (WYSIWYG, default) / HTML (avanzado). El
                    docente escribe el informe como en Word; las variables se
                    insertan desde el panel derecho. HTML queda para bloques
                    {{#each}}/{{#if}} que no se pueden tipear visualmente. */}
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={bodyMode === "visual" ? "default" : "outline"}
                    className="h-7 text-xs"
                    onClick={() => setBodyMode("visual")}
                  >
                    <Eye className="h-3.5 w-3.5 mr-1" />
                    {t("hc_modulesReportsTemplateEditor.modeVisual")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={bodyMode === "html" ? "default" : "outline"}
                    className="h-7 text-xs"
                    onClick={() => setBodyMode("html")}
                  >
                    <Code2 className="h-3.5 w-3.5 mr-1" />
                    HTML
                  </Button>
                  {/* Conteo de páginas (= saltos de página + 1). Da el sentido
                      de cuántas páginas tiene el informe mientras se edita; los
                      números por página se ven en la pestaña Vista previa. */}
                  <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                    {t("hc_modulesReportsTemplateEditor.pageCount", {
                      count: pageCount,
                      defaultValue: "{{count}} página(s)",
                    })}
                  </span>
                </div>
                {bodyMode === "visual" ? (
                  <RichTextEditor
                    ref={richRef}
                    value={value.body_html}
                    onChange={(html) => onChange({ ...value, body_html: html })}
                    placeholder={t("hc_modulesReportsTemplateEditor.placeholderBodyVisual")}
                  />
                ) : (
                  <Textarea
                    ref={bodyRef}
                    value={value.body_html}
                    onChange={(e) => onChange({ ...value, body_html: e.target.value })}
                    className="font-mono text-sm min-h-[400px]"
                    placeholder={t("hc_modulesReportsTemplateEditor.placeholderBodyHtml")}
                    spellCheck={false}
                  />
                )}
              </TabsContent>
              <TabsContent value="header" className="mt-2">
                <Textarea
                  ref={headerRef}
                  value={value.header_html}
                  onChange={(e) => onChange({ ...value, header_html: e.target.value })}
                  className="font-mono text-sm min-h-[200px]"
                  placeholder={t("hc_modulesReportsTemplateEditor.placeholderHeader")}
                  spellCheck={false}
                />
              </TabsContent>
              <TabsContent value="footer" className="mt-2">
                <Textarea
                  ref={footerRef}
                  value={value.footer_html}
                  onChange={(e) => onChange({ ...value, footer_html: e.target.value })}
                  className="font-mono text-sm min-h-[200px]"
                  placeholder={t("hc_modulesReportsTemplateEditor.placeholderFooter")}
                  spellCheck={false}
                />
              </TabsContent>
              <TabsContent value="css" className="mt-2">
                <Textarea
                  ref={cssRef}
                  value={value.css}
                  onChange={(e) => onChange({ ...value, css: e.target.value })}
                  className="font-mono text-sm min-h-[200px]"
                  placeholder={t("hc_modulesReportsTemplateEditor.placeholderCss")}
                  spellCheck={false}
                />
              </TabsContent>
              {/* Vista previa en vivo: renderiza el documento (body + header/
                  footer + CSS) tal como se verá, con las variables YA RESUELTAS
                  con datos de muestra (logo, notas…) y dividido en hojas de
                  página numeradas. sandbox="" = solo HTML/CSS, sin scripts
                  (seguro para HTML de plantilla). */}
              <TabsContent value="preview" className="mt-2 space-y-2">
                {/* Selección de DATOS REALES: curso (+ estudiante en scope
                    'estudiante'). El preview se renderiza con esos datos. */}
                {courses && courses.length > 0 && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px]">
                        {t("hc_modulesReportsTemplateEditor.previewCourseLabel", { defaultValue: "Datos del curso" })}
                      </Label>
                      <Select value={pvCourseId} onValueChange={setPvCourseId}>
                        <SelectTrigger className="h-8 w-56 text-xs">
                          <SelectValue
                            placeholder={t("hc_modulesReportsTemplateEditor.aiCoursePlaceholder", { defaultValue: "Elige un curso" })}
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
                    {value.scope === "estudiante" && pvStudents.length > 0 && (
                      <div className="space-y-1">
                        <Label className="text-[11px]">
                          {t("hc_modulesReportsTemplateEditor.previewStudentLabel", { defaultValue: "Estudiante" })}
                        </Label>
                        <Select value={pvStudentId} onValueChange={setPvStudentId}>
                          <SelectTrigger className="h-8 w-56 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {pvStudents.map((s) => (
                              <SelectItem key={s.id} value={s.id}>
                                {s.full_name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {pvCtx
                    ? t("hc_modulesReportsTemplateEditor.previewRealNote", {
                        defaultValue:
                          "Vista previa con DATOS REALES del curso/estudiante elegido. Cambia la selección de arriba para ver otro caso.",
                      })
                    : t("hc_modulesReportsTemplateEditor.previewRenderedNote", {
                        defaultValue:
                          "Vista previa con datos de EJEMPLO (elige un curso arriba para ver datos reales). Al generar el informe se usan los datos reales del curso/estudiante.",
                      })}
                  {pvLoading
                    ? ` · ${t("hc_modulesReportsTemplateEditor.previewLoading", { defaultValue: "cargando datos…" })}`
                    : ""}
                </p>
                <iframe
                  srcDoc={previewHtml}
                  sandbox=""
                  title={t("hc_modulesReportsTemplateEditor.previewIframeTitle")}
                  className="w-full min-h-[440px] border rounded bg-white"
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <div>
        <Card className="lg:sticky lg:top-4">
          <CardContent className="p-3 space-y-1 max-h-[80dvh] overflow-y-auto">
            {/* Generación IA al cursor: el docente sitúa el cursor en el
                cuerpo, abre el prompt, y la IA inserta el contenido EXACTAMENTE
                donde está. Reemplaza el botón global de "Generar con IA". */}
            {onAiGenerate && (
              <div className="pb-2 mb-1 border-b">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="w-full justify-start h-8 text-xs border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-500/50 dark:text-violet-300 dark:hover:bg-violet-500/10"
                  onClick={openAi}
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                  {t("hc_modulesReportsTemplateEditor.aiInsertButton", { defaultValue: "Generación IA" })}
                </Button>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {t("hc_modulesReportsTemplateEditor.aiInsertHint", {
                    defaultValue: "Sitúa el cursor en el cuerpo y la IA inserta ahí lo que pidas.",
                  })}
                </p>
              </div>
            )}
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium pb-1">
              {t("hc_modulesReportsTemplateEditor.availableVariables")}
            </p>
            <p className="text-[11px] text-muted-foreground pb-1">
              {t("hc_modulesReportsTemplateEditor.clickToInsert")}
            </p>
            {/* Las variables dependen del tipo de informe (scope). */}
            <p className="text-[11px] font-medium text-violet-700 dark:text-violet-300 pb-2">
              {value.scope === "estudiante"
                ? t("hc_modulesReportsTemplateEditor.varsScopeStudent", {
                    defaultValue: "Informe por estudiante: variables del alumno.",
                  })
                : t("hc_modulesReportsTemplateEditor.varsScopeCourse", {
                    defaultValue: "Informe por curso: variables del curso + iterar estudiantes.",
                  })}
            </p>
            {effectiveCatalog.map((node) => (
              <CatalogNode key={node.path} node={node} onInsert={insertAtCursor} />
            ))}
          </CardContent>
        </Card>
      </div>

      {/* Diálogo de Generación IA inline (insertar en el cursor). */}
      {onAiGenerate && (
        <Dialog open={aiOpen} onOpenChange={(o) => !aiBusy && setAiOpen(o)}>
          <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-lg">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-1.5">
                <Sparkles className="h-4 w-4 text-violet-500" />
                {t("hc_modulesReportsTemplateEditor.aiDialogTitle", { defaultValue: "Generar con IA e insertar" })}
              </DialogTitle>
              <DialogDescription>
                {t("hc_modulesReportsTemplateEditor.aiDialogDesc", {
                  defaultValue:
                    "El contenido se insertará donde tienes el cursor en el cuerpo. Puede incluir variables {{...}} que se resuelven al generar el informe.",
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              {/* Fuente de datos = el curso/estudiante elegido en Vista previa. */}
              {pvCourseId ? (
                <p className="text-[11px] text-muted-foreground">
                  {t("hc_modulesReportsTemplateEditor.aiDataSource", { defaultValue: "Datos de:" })}{" "}
                  <span className="font-medium text-foreground">{pvCourseName}</span>
                  {value.scope === "estudiante" && pvStudentName ? ` · ${pvStudentName}` : ""}
                </p>
              ) : (
                <p className="text-[11px] text-amber-600">
                  {t("hc_modulesReportsTemplateEditor.aiNoCourse", {
                    defaultValue: "Elige un curso en la pestaña “Vista previa” para usar datos reales.",
                  })}
                </p>
              )}
              <div className="space-y-1">
                <Label required>
                  {t("hc_modulesReportsTemplateEditor.aiInstructionLabel", { defaultValue: "¿Qué quieres que genere?" })}
                </Label>
                <Textarea
                  value={aiInstruction}
                  onChange={(e) => setAiInstruction(e.target.value)}
                  className="min-h-[110px]"
                  placeholder={t("hc_modulesReportsTemplateEditor.aiInstructionPlaceholder", {
                    defaultValue:
                      "Ej.: un párrafo de observaciones del desempeño del estudiante usando su nombre y nota final.",
                  })}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAiOpen(false)} disabled={aiBusy}>
                {t("hc_modulesReportsTemplateEditor.aiCancel", { defaultValue: "Cancelar" })}
              </Button>
              <Button onClick={() => void runAi()} disabled={aiBusy || !pvCourseId || !aiInstruction.trim()}>
                {aiBusy ? <Spinner size="sm" className="mr-1" /> : <Sparkles className="h-4 w-4 mr-1" />}
                {aiBusy
                  ? t("hc_modulesReportsTemplateEditor.aiGenerating", { defaultValue: "Generando…" })
                  : t("hc_modulesReportsTemplateEditor.aiGenerateInsert", { defaultValue: "Generar e insertar" })}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function CatalogNode({
  node,
  onInsert,
  depth = 0,
}: {
  node: VariableNode;
  onInsert: (snippet: string) => void;
  depth?: number;
}) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = node.children && node.children.length > 0;
  const isClickable = node.kind !== "group";

  return (
    <div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          if (isClickable) onInsert(variableSnippet(node));
          else if (hasChildren) setOpen((o) => !o);
        }}
        className={cn(
          "w-full justify-start h-7 text-xs font-normal hover:bg-muted",
          isClickable && "font-mono text-[11px]",
        )}
        style={{ paddingLeft: depth * 8 + 8 }}
        title={node.hint}
      >
        {hasChildren ? (
          open ? <ChevronDown className="h-3 w-3 mr-1 shrink-0" /> : <ChevronRight className="h-3 w-3 mr-1 shrink-0" />
        ) : node.kind === "each" ? (
          <Eye className="h-3 w-3 mr-1 shrink-0 text-violet-500" />
        ) : (
          <span className="w-3 mr-1 shrink-0" />
        )}
        <span className="truncate text-left">{node.label}</span>
      </Button>
      {hasChildren && open && (
        <div>
          {node.children!.map((child) => (
            <CatalogNode key={child.path} node={child} onInsert={onInsert} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Compone el HTML completo a partir del draft. Lo usan el preview y el
 * generador de informe — devuelve un `<html>` listo para `srcdoc` de
 * iframe, ya con orientation/size declarados en `@page`.
 */
export function composeTemplateHtml(
  draft: Pick<TemplateDraft, "body_html" | "header_html" | "footer_html" | "css" | "page_orientation" | "page_size">,
): string {
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
@page { size: ${draft.page_size} ${draft.page_orientation}; margin: 18mm; }
body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; line-height: 1.4; }
/* Imágenes (logo de cabecera importada del .docx) nunca rebasan el ancho. */
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; }
td p { margin: 2px 0; }
header { margin-bottom: 10px; }
footer { margin-top: 12px; }
/* PDF (imprimir): la cabecera/pie van al ÁREA de encabezado/pie de cada página
   (no sólo al inicio del documento) vía position:fixed. Para informes de 1 página
   queda exacto; en multi-página se repite arriba/abajo. El padding de main evita
   que la primera línea quede tapada por la cabecera fija. En pantalla NO aplica
   (el preview es flujo normal). Para fidelidad total de encabezado, la descarga
   .docx lo pone en word/header1.xml (área de encabezado real de Word). */
@media print {
  header { position: fixed; top: 0; left: 0; right: 0; }
  footer { position: fixed; bottom: 0; left: 0; right: 0; }
  main { padding-top: 2.2cm; padding-bottom: 1.4cm; }
}
/* Salto de página explícito. En impresión/PDF fuerza un corte real; en
   pantalla (editor + generador) lo decoramos como un divisor visible para
   que el docente vea CLARAMENTE dónde termina una página y empieza otra
   (antes el .docx importado se veía como un bloque continuo). */
.examlab-page-break { break-after: page; page-break-after: always; }
@media screen {
  .examlab-page-break {
    display: block; height: 0; margin: 30px 0 10px; border: 0;
    border-top: 2px dashed #f59e0b; position: relative; break-after: auto;
  }
  .examlab-page-break::after {
    content: "Salto de página"; position: absolute; left: 50%; top: -0.8em;
    transform: translateX(-50%); background: #fffbeb; color: #92400e;
    font: 600 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 3px 12px; border: 1px solid #fcd34d; border-radius: 999px; white-space: nowrap;
  }
}
${draft.css ?? ""}
</style>
</head><body>
${draft.header_html ? `<header>${draft.header_html}</header>` : ""}
<main>${draft.body_html}</main>
${draft.footer_html ? `<footer>${draft.footer_html}</footer>` : ""}
</body></html>`;
}

/** Dimensiones de página en mm para el preview (portrait por defecto). */
function pageDimsMm(
  size: TemplateDraft["page_size"],
  orientation: TemplateDraft["page_orientation"],
): { w: number; h: number } {
  const base = size === "letter" ? { w: 216, h: 279 } : { w: 210, h: 297 };
  return orientation === "landscape" ? { w: base.h, h: base.w } : base;
}

/**
 * HTML para la VISTA PREVIA en vivo del editor. Se RENDERIZA con datos (de
 * muestra, o la marca real del tenant): las variables aparecen ya resueltas
 * (el logo institucional se ve, las notas se ven), NO como `{{placeholders}}`.
 * Y se dibuja como HOJAS DE PÁGINA separadas — una por bloque entre saltos —
 * con etiqueta "Página X de N", cabecera/pie repetidos y tamaño real de hoja,
 * para que el docente vea claramente qué cae en cada página.
 */
export function composePreviewHtml(
  draft: Pick<TemplateDraft, "body_html" | "header_html" | "footer_html" | "css" | "page_orientation" | "page_size">,
  ctx: TemplateContext = buildSampleReportContext(),
): string {
  const dims = pageDimsMm(draft.page_size, draft.page_orientation);
  // Render resiliente: una plantilla con un bloque sin cerrar no debe romper
  // el preview entero → cae al HTML crudo de ese fragmento.
  const render = (html: string): string => {
    if (!html) return "";
    try {
      return renderTemplate(html, ctx);
    } catch {
      return html;
    }
  };
  const header = draft.header_html ? `<header>${render(draft.header_html)}</header>` : "";
  const footer = draft.footer_html ? `<footer>${render(draft.footer_html)}</footer>` : "";
  // Partimos el cuerpo YA RENDERIZADO por los marcadores de salto → una hoja
  // por segmento. Sin saltos = una sola hoja.
  const segments = render(draft.body_html || "").split(PAGE_BREAK_HTML);
  const total = segments.length;
  const pages = segments
    .map(
      (seg, i) => `<div class="examlab-page-wrap">
  <div class="examlab-page-label">Página ${i + 1} de ${total}</div>
  <div class="examlab-page">${header}<main>${seg}</main>${footer}</div>
</div>`,
    )
    .join("\n");
  return `<!doctype html>
<html><head><meta charset="utf-8">
<style>
html, body { margin: 0; padding: 0; }
body { background: #e5e7eb; padding: 18px 0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #111; line-height: 1.4; }
.examlab-page-wrap { width: ${dims.w}mm; max-width: calc(100% - 24px); margin: 0 auto 26px; }
.examlab-page-label { display: inline-block; font: 700 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #fff; background: #6b7280; border-radius: 999px; padding: 4px 10px; margin: 0 0 6px 4px; }
.examlab-page { background: #fff; min-height: ${dims.h}mm; box-shadow: 0 1px 8px rgba(0,0,0,.18); padding: 18mm; box-sizing: border-box; overflow: hidden; }
.examlab-page img { max-width: 100%; height: auto; }
.examlab-page table { border-collapse: collapse; width: 100%; }
.examlab-page td p { margin: 2px 0; }
.examlab-page header { margin-bottom: 10px; }
.examlab-page footer { margin-top: 12px; border-top: 1px solid #eee; padding-top: 6px; font-size: .85em; color: #555; }
${draft.css ?? ""}
</style>
</head><body>${pages}</body></html>`;
}

/**
 * Hook utilitario para tener un draft default vacío. Lo usan tanto el
 * editor admin (al crear nueva) como el docente (al duplicar/override).
 */
export function emptyDraft(): TemplateDraft {
  return {
    name: "",
    description: "",
    scope: "estudiante",
    body_html: "",
    header_html: "",
    footer_html: "",
    css: "",
    page_orientation: "portrait",
    page_size: "A4",
  };
}

/** Hash de TemplateDraft (para detectar cambios sin guardar). */
export function draftEqual(a: TemplateDraft, b: TemplateDraft): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.scope === b.scope &&
    a.body_html === b.body_html &&
    a.header_html === b.header_html &&
    a.footer_html === b.footer_html &&
    a.css === b.css &&
    a.page_orientation === b.page_orientation &&
    a.page_size === b.page_size
  );
}


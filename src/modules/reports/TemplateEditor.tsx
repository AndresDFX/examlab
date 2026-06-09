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
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { HelpHint } from "@/components/ui/help-hint";
import { ChevronDown, ChevronRight, Code2, Eye } from "lucide-react";
import { cn } from "@/shared/lib/utils";
import {
  REPORT_VARIABLE_CATALOG,
  variableSnippet,
  type VariableNode,
} from "./template-engine";
import { RichTextEditor, type RichTextEditorHandle } from "./RichTextEditor";

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
}

type EditTab = "body" | "header" | "footer" | "css";
type Tab = EditTab | "preview";

export function TemplateEditor({ value, onChange, showMetadata = true, catalog }: Props) {
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

  // HTML compuesto para la vista previa en vivo (body + header/footer + CSS
  // + @page). Los {{placeholders}} se resaltan como "campos" para que se
  // distingan del contenido estático; se reemplazan por datos reales al
  // generar el informe (flujo "Generar").
  const previewHtml = useMemo(() => composePreviewHtml(value), [value]);

  const insertAtCursor = (snippet: string) => {
    // En la pestaña de vista previa no hay dónde insertar.
    if (activeTab === "preview") return;
    // En el cuerpo en modo Visual, insertamos el {{placeholder}} como texto
    // en el cursor del editor WYSIWYG.
    if (activeTab === "body" && bodyMode === "visual") {
      richRef.current?.insertText(snippet);
      return;
    }
    const tab: EditTab = activeTab;
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

  const effectiveCatalog = catalog ?? REPORT_VARIABLE_CATALOG;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-3">
      <div className="space-y-3">
        {showMetadata && (
          <Card>
            <CardContent className="p-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label required>Nombre</Label>
                <Input
                  value={value.name}
                  onChange={(e) => onChange({ ...value, name: e.target.value })}
                  placeholder="Boletín de notas"
                />
              </div>
              <div className="space-y-1">
                <Label>
                  Tipo de informe{" "}
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
                    <SelectItem value="estudiante">Por estudiante (individual)</SelectItem>
                    <SelectItem value="curso">Por curso (consolidado)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Descripción</Label>
                <Input
                  value={value.description}
                  onChange={(e) => onChange({ ...value, description: e.target.value })}
                  placeholder="Breve descripción de cuándo usar esta plantilla"
                />
              </div>
              <div className="space-y-1">
                <Label>Orientación</Label>
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
                    <SelectItem value="portrait">Vertical</SelectItem>
                    <SelectItem value="landscape">Horizontal</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Tamaño</Label>
                <Select
                  value={value.page_size}
                  onValueChange={(v) => onChange({ ...value, page_size: v as "A4" | "letter" })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="A4">A4</SelectItem>
                    <SelectItem value="letter">Carta</SelectItem>
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
                  Cuerpo
                </TabsTrigger>
                <TabsTrigger value="header">Encabezado</TabsTrigger>
                <TabsTrigger value="footer">Pie</TabsTrigger>
                <TabsTrigger value="css">CSS</TabsTrigger>
                <TabsTrigger value="preview">
                  <Eye className="h-3.5 w-3.5 mr-1" />
                  Vista previa
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
                    Visual
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
                </div>
                {bodyMode === "visual" ? (
                  <RichTextEditor
                    ref={richRef}
                    value={value.body_html}
                    onChange={(html) => onChange({ ...value, body_html: html })}
                    placeholder="Escribe el informe… usa la barra para dar formato y el panel derecho para insertar variables."
                  />
                ) : (
                  <Textarea
                    ref={bodyRef}
                    value={value.body_html}
                    onChange={(e) => onChange({ ...value, body_html: e.target.value })}
                    className="font-mono text-sm min-h-[400px]"
                    placeholder="<h1>Boletín de {{estudiante.nombre}}</h1>…"
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
                  placeholder="Aparece en cada página (impresión)"
                  spellCheck={false}
                />
              </TabsContent>
              <TabsContent value="footer" className="mt-2">
                <Textarea
                  ref={footerRef}
                  value={value.footer_html}
                  onChange={(e) => onChange({ ...value, footer_html: e.target.value })}
                  className="font-mono text-sm min-h-[200px]"
                  placeholder="Aparece en cada página al final (impresión)"
                  spellCheck={false}
                />
              </TabsContent>
              <TabsContent value="css" className="mt-2">
                <Textarea
                  ref={cssRef}
                  value={value.css}
                  onChange={(e) => onChange({ ...value, css: e.target.value })}
                  className="font-mono text-sm min-h-[200px]"
                  placeholder="Estilos del informe (h1 { font-size: 18pt; })"
                  spellCheck={false}
                />
              </TabsContent>
              {/* Vista previa en vivo: renderiza el documento (body + header/
                  footer + CSS) tal como se verá. Para un Word importado se ve
                  formateado; los {{campos}} se resaltan y se reemplazan por
                  datos reales al Generar. sandbox="" = solo HTML/CSS, sin
                  scripts (seguro para HTML de plantilla). */}
              <TabsContent value="preview" className="mt-2">
                <p className="text-[11px] text-muted-foreground mb-1.5">
                  Así se verá el informe. Los{" "}
                  <span className="font-mono bg-amber-100 text-amber-800 rounded px-1">
                    {"{{campos}}"}
                  </span>{" "}
                  resaltados se reemplazan por los datos reales al Generar.
                </p>
                <iframe
                  srcDoc={previewHtml}
                  sandbox=""
                  title="Vista previa del informe"
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
            <p className="text-xs uppercase tracking-wide text-muted-foreground font-medium pb-1">
              Variables disponibles
            </p>
            <p className="text-[11px] text-muted-foreground pb-2">
              Click → inserta en la pestaña activa.
            </p>
            {effectiveCatalog.map((node) => (
              <CatalogNode key={node.path} node={node} onInsert={insertAtCursor} />
            ))}
          </CardContent>
        </Card>
      </div>
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
${draft.css ?? ""}
</style>
</head><body>
${draft.header_html ? `<header>${draft.header_html}</header>` : ""}
<main>${draft.body_html}</main>
${draft.footer_html ? `<footer>${draft.footer_html}</footer>` : ""}
</body></html>`;
}

// Estilo del resaltado de placeholders en la vista previa.
const PH_PREVIEW_STYLE =
  ".examlab-ph{background:#fef3c7;color:#92400e;border-radius:3px;padding:0 2px;" +
  "font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.85em;white-space:nowrap;}";

/**
 * Resalta los `{{placeholders}}` que aparecen en CONTENIDO de texto (entre
 * `>` y `<`) — nunca dentro de atributos de tag (ej. `src="{{logo}}"`), para
 * no romper el HTML. Hace visibles los "campos" dinámicos sin necesidad de
 * scripts en el iframe (puede ir con sandbox="").
 */
function highlightPlaceholders(html: string): string {
  return html.replace(/>([^<]*)</g, (full: string, text: string) => {
    if (!text.includes("{{")) return full;
    const wrapped = text.replace(
      /\{\{\{?[^{}]+\}?\}\}/g,
      (tok: string) => `<span class="examlab-ph">${tok}</span>`,
    );
    return `>${wrapped}<`;
  });
}

/**
 * HTML para la VISTA PREVIA en vivo del editor: el documento compuesto, con
 * los placeholders resaltados como campos. Para un .docx importado (sin
 * placeholders todavía) se ve el documento formateado tal cual; a medida que
 * el docente inserta variables, se ven resaltadas. Se reemplazan por datos
 * reales al "Generar". Pensado para `<iframe srcDoc sandbox="">`.
 */
export function composePreviewHtml(
  draft: Pick<TemplateDraft, "body_html" | "header_html" | "footer_html" | "css" | "page_orientation" | "page_size">,
): string {
  const styled = composeTemplateHtml(draft).replace("</style>", `${PH_PREVIEW_STYLE}\n</style>`);
  return highlightPlaceholders(styled);
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


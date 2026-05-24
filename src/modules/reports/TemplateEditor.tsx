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
import { useRef, useState } from "react";
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

export function TemplateEditor({ value, onChange, showMetadata = true, catalog }: Props) {
  const [activeTab, setActiveTab] = useState<"body" | "header" | "footer" | "css">("body");
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const headerRef = useRef<HTMLTextAreaElement>(null);
  const footerRef = useRef<HTMLTextAreaElement>(null);
  const cssRef = useRef<HTMLTextAreaElement>(null);

  const refFor = (tab: typeof activeTab) =>
    tab === "body" ? bodyRef : tab === "header" ? headerRef : tab === "footer" ? footerRef : cssRef;

  const fieldFor = (tab: typeof activeTab): keyof TemplateDraft =>
    tab === "body" ? "body_html"
      : tab === "header" ? "header_html"
        : tab === "footer" ? "footer_html"
          : "css";

  const insertAtCursor = (snippet: string) => {
    const field = fieldFor(activeTab);
    const ref = refFor(activeTab).current;
    if (!ref) return;
    const start = ref.selectionStart ?? 0;
    const end = ref.selectionEnd ?? 0;
    const current = (value[field] as string) ?? "";
    const next = current.slice(0, start) + snippet + current.slice(end);
    onChange({ ...value, [field]: next });
    // Re-posicionar cursor al final del snippet insertado (next tick).
    requestAnimationFrame(() => {
      const r = refFor(activeTab).current;
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
                  <HelpHint>
                    &quot;Por estudiante&quot; = un informe por alumno. &quot;Por curso&quot; =
                    un consolidado iterando sobre {`{{#each estudiantes}}`}.
                  </HelpHint>
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
              </TabsList>
              <TabsContent value="body" className="mt-2">
                <Textarea
                  ref={bodyRef}
                  value={value.body_html}
                  onChange={(e) => onChange({ ...value, body_html: e.target.value })}
                  className="font-mono text-sm min-h-[400px]"
                  placeholder="<h1>Boletín de {{estudiante.nombre}}</h1>…"
                  spellCheck={false}
                />
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
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <div>
        <Card className="lg:sticky lg:top-4">
          <CardContent className="p-3 space-y-1 max-h-[80vh] overflow-y-auto">
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


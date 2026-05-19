import { useState, useEffect, useRef, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { Eye, Code, RotateCcw, ZoomIn, ZoomOut, AlertTriangle } from "lucide-react";

const TEMPLATES: Record<string, { label: string; code: string }> = {
  classDiagram: {
    label: "Clases",
    code: `classDiagram
    class Animal {
        +String nombre
        +int edad
        +hacerSonido() void
    }
    class Perro {
        +String raza
        +ladrar() void
    }
    class Gato {
        +ronronear() void
    }
    Animal <|-- Perro
    Animal <|-- Gato`,
  },
  sequenceDiagram: {
    label: "Secuencia",
    code: `sequenceDiagram
    participant C as Cliente
    participant S as Servidor
    participant DB as Base de Datos
    C->>S: Solicitud HTTP
    S->>DB: Consulta SQL
    DB-->>S: Resultados
    S-->>C: Respuesta JSON`,
  },
  erDiagram: {
    label: "Entidad-Relación",
    code: `erDiagram
    ESTUDIANTE ||--o{ MATRICULA : tiene
    CURSO ||--o{ MATRICULA : contiene
    CURSO ||--o{ EXAMEN : incluye
    ESTUDIANTE {
        string nombre
        string email
        int edad
    }
    CURSO {
        string nombre
        date fecha_inicio
        date fecha_fin
    }`,
  },
  flowchart: {
    label: "Flujo",
    code: `flowchart TD
    A[Inicio] --> B{¿Condición?}
    B -->|Sí| C[Proceso A]
    B -->|No| D[Proceso B]
    C --> E[Resultado]
    D --> E
    E --> F[Fin]`,
  },
  stateDiagram: {
    label: "Estados",
    code: `stateDiagram-v2
    [*] --> Inactivo
    Inactivo --> Activo : iniciar()
    Activo --> Pausado : pausar()
    Pausado --> Activo : reanudar()
    Activo --> Finalizado : completar()
    Pausado --> Finalizado : cancelar()
    Finalizado --> [*]`,
  },
  activityDiagram: {
    label: "Actividad",
    code: `flowchart TD
    A([Inicio]) --> B[Recibir solicitud]
    B --> C{¿Válida?}
    C -->|Sí| D[Procesar datos]
    C -->|No| E[Retornar error]
    D --> F{¿Exitoso?}
    F -->|Sí| G[Enviar respuesta]
    F -->|No| E
    G --> H([Fin])
    E --> H`,
  },
};

interface DiagramEditorProps {
  value: string;
  onChange: (code: string) => void;
  readOnly?: boolean;
}

/**
 * Mermaid v10/v11 monta elementos auxiliares en `document.body` mientras
 * renderiza (los usa para medir tamaños sin afectar el layout). Cuando
 * el código tiene error, esos elementos quedan huérfanos y a veces se
 * vuelven visibles fuera del componente — el alumno ve "Syntax error in
 * text · mermaid version 11.x.x" pegado en alguna esquina aún cuando
 * navega a otra ruta. Esta limpieza elimina los nodos que mermaid no
 * borró por sí mismo, identificándolos por id `dmermaid*` o `mermaid-*`.
 */
function cleanupMermaidArtifacts(): void {
  if (typeof document === "undefined") return;
  document
    .querySelectorAll<HTMLElement>('body > [id^="dmermaid"], body > [id^="mermaid-"]')
    .forEach((el) => {
      // No borrar el container del propio editor (vive dentro de un
      // elemento padre con su propio id, no como hijo directo de body).
      el.remove();
    });
}

export function DiagramEditor({ value, onChange, readOnly = false }: DiagramEditorProps) {
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [svgHtml, setSvgHtml] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const renderRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2, 9)}`);

  const renderDiagram = useCallback(async (code: string) => {
    if (!code.trim()) {
      setSvgHtml("");
      setError(null);
      // Mermaid deja elementos huérfanos (`#dmermaid-*`) en document.body
      // cuando una renderización previa falló. Si el diagrama queda vacío
      // y no limpiamos, esos elementos siguen visibles en algunas
      // pantallas mostrando "Syntax error in text mermaid version
      // 11.x.x" en la UI del estudiante.
      cleanupMermaidArtifacts();
      return;
    }
    try {
      const mermaid = (await import("mermaid")).default;
      mermaid.initialize({
        startOnLoad: false,
        theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
        securityLevel: "strict",
        fontFamily: "Inter, sans-serif",
      });
      const { svg } = await mermaid.render(idRef.current, code);
      // Mermaid v11 NO siempre throw cuando el código tiene error: en
      // ocasiones retorna un SVG con el mensaje "Syntax error in text".
      // Lo detectamos por contenido y lo tratamos como fallo en vez
      // de pintarlo (UX confusa, ensucia la pantalla del alumno).
      const looksLikeError =
        /syntax\s*error\s*in\s*text/i.test(svg) ||
        /aria-roledescription="error"/i.test(svg) ||
        svg.includes("mermaid version");
      if (looksLikeError) {
        setError("Sintaxis Mermaid inválida");
        setSvgHtml("");
        cleanupMermaidArtifacts();
        return;
      }
      setSvgHtml(svg);
      setError(null);
      // Generate a new ID for next render (mermaid reuses IDs)
      idRef.current = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    } catch (e: any) {
      setError(e.message ?? "Error de sintaxis en el diagrama");
      // Limpieza adicional: cuando mermaid throws, también deja restos
      // en el body. Sin esto, el alumno ve el error pegado al margen
      // inferior de la pantalla aún en otras rutas.
      cleanupMermaidArtifacts();
      // Don't clear SVG on error — keep last valid render
    }
  }, []);

  // Render on tab switch to preview or on value change while in preview
  useEffect(() => {
    if (tab === "preview") {
      renderDiagram(value);
    }
  }, [tab, value, renderDiagram]);

  // Also render initially if there's a value
  useEffect(() => {
    if (value.trim()) renderDiagram(value);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const applyTemplate = (key: string) => {
    const tmpl = TEMPLATES[key];
    if (tmpl) onChange(tmpl.code);
  };

  return (
    <div className="space-y-2">
      {/* Template buttons */}
      {!readOnly && (
        <div className="flex flex-wrap gap-1.5">
          <span className="text-xs text-muted-foreground self-center mr-1">Plantillas UML:</span>
          {Object.entries(TEMPLATES).map(([key, { label }]) => (
            <Button
              key={key}
              type="button"
              variant="outline"
              size="sm"
              className="h-6 text-[11px] px-2"
              onClick={() => applyTemplate(key)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}

      {/* Editor / Preview tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as "edit" | "preview")}>
        <TabsList className="h-8">
          <TabsTrigger value="edit" className="text-xs gap-1 h-7" disabled={readOnly}>
            <Code className="h-3 w-3" /> Código
          </TabsTrigger>
          <TabsTrigger value="preview" className="text-xs gap-1 h-7">
            <Eye className="h-3 w-3" /> Vista previa
          </TabsTrigger>
        </TabsList>

        <TabsContent value="edit" className="mt-2">
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && !readOnly) {
                e.preventDefault();
                const ta = e.currentTarget;
                const start = ta.selectionStart;
                const end = ta.selectionEnd;
                const indent = "    ";
                const next = value.slice(0, start) + indent + value.slice(end);
                onChange(next);
                // Restore caret right after the inserted indent
                requestAnimationFrame(() => {
                  ta.selectionStart = ta.selectionEnd = start + indent.length;
                });
              }
            }}
            readOnly={readOnly}
            rows={12}
            spellCheck={false}
            className={cn(
              "w-full rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed resize-y",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              readOnly && "opacity-70 cursor-not-allowed",
            )}
            placeholder="Escribe tu diagrama Mermaid aquí..."
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Usa sintaxis{" "}
            <a
              href="https://mermaid.js.org/syntax/classDiagram.html"
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Mermaid
            </a>{" "}
            para crear diagramas UML. Cambia a "Vista previa" para ver el resultado.
          </p>
        </TabsContent>

        <TabsContent value="preview" className="mt-2">
          <div className="rounded-md border bg-card min-h-[200px] relative overflow-hidden">
            {/* Zoom controls */}
            <div className="absolute top-2 right-2 z-10 flex gap-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setZoom((z) => Math.min(2, z + 0.2))}
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setZoom((z) => Math.max(0.4, z - 0.2))}
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setZoom(1)}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </div>

            {error && (
              <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5 bg-destructive/10 text-destructive text-xs px-2 py-1 rounded">
                <AlertTriangle className="h-3 w-3" /> {error.slice(0, 80)}
              </div>
            )}

            {svgHtml ? (
              <div
                ref={renderRef}
                className="p-4 flex items-center justify-center overflow-auto max-h-[400px]"
                style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}
                dangerouslySetInnerHTML={{ __html: svgHtml }}
              />
            ) : (
              <div className="flex items-center justify-center h-48 text-sm text-muted-foreground">
                {value.trim()
                  ? "Renderizando..."
                  : "Escribe código Mermaid y cambia a vista previa"}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

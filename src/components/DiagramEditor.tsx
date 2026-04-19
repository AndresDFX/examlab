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
      setSvgHtml(svg);
      setError(null);
      // Generate a new ID for next render (mermaid reuses IDs)
      idRef.current = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
    } catch (e: any) {
      setError(e.message ?? "Error de sintaxis en el diagrama");
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
            readOnly={readOnly}
            rows={12}
            spellCheck={false}
            className={cn(
              "w-full rounded-md border bg-muted/30 p-3 font-mono text-xs leading-relaxed resize-y",
              "focus:outline-none focus:ring-2 focus:ring-ring",
              readOnly && "opacity-70 cursor-not-allowed"
            )}
            placeholder="Escribe tu diagrama Mermaid aquí..."
          />
          <p className="text-[10px] text-muted-foreground mt-1">
            Usa sintaxis <a href="https://mermaid.js.org/syntax/classDiagram.html" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">Mermaid</a> para crear diagramas UML. Cambia a "Vista previa" para ver el resultado.
          </p>
        </TabsContent>

        <TabsContent value="preview" className="mt-2">
          <div className="rounded-md border bg-card min-h-[200px] relative overflow-hidden">
            {/* Zoom controls */}
            <div className="absolute top-2 right-2 z-10 flex gap-1">
              <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(z => Math.min(2, z + 0.2))}>
                <ZoomIn className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(z => Math.max(0.4, z - 0.2))}>
                <ZoomOut className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" variant="outline" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(1)}>
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
                {value.trim() ? "Renderizando..." : "Escribe código Mermaid y cambia a vista previa"}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/**
 * TextPageEditor — editor de hojas tipo texto (página markdown) para
 * pizarras multi-hoja. Contraparte de `WhiteboardEditor` (Excalidraw)
 * pero para `page_type='text'`.
 *
 * Mismo contrato que WhiteboardEditor para que `MultiPageWhiteboard`
 * pueda intercambiarlos por `page.page_type`:
 *   - `text`: string (markdown source) — equivalente a `scene` en el
 *     editor de dibujo.
 *   - `onPersist(text)`: callback con auto-save debounced.
 *   - `readOnly`: solo preview, sin textarea ni toolbar.
 *   - `className`: contenedor.
 *
 * Auto-save: mismo debounce 1500ms que WhiteboardEditor; flush en
 * unmount con `Promise.resolve(...).catch()` para evitar unhandled
 * promise rejections.
 *
 * Modos visuales:
 *   - Edit (default): editor a la izquierda con toolbar arriba +
 *     preview en vivo a la derecha (split). En mobile colapsa a tabs
 *     "Editor" / "Vista previa".
 *   - Read-only: solo MarkdownViewer ocupando el área completa.
 *   - Fullscreen: mismo Fullscreen API que WhiteboardEditor, ícono
 *     bottom-right.
 *
 * Toolbar: botones que insertan markdown en la posición del caret
 * (negritas, italic, encabezados, listas, código, link). Implementado
 * a mano con `textarea.setSelectionRange` — no se introduce ningún
 * editor pesado (Tiptap/Lexical/etc) porque markdown + preview ya
 * cumple la necesidad de "como un editor".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MarkdownViewer } from "@/shared/components/MarkdownViewer";
import { cn } from "@/shared/lib/utils";
import {
  Bold,
  Italic,
  Heading1,
  Heading2,
  List,
  ListOrdered,
  Code,
  Code2,
  Link2,
  Quote,
  Eye,
  Pencil,
  Maximize2,
  Minimize2,
} from "lucide-react";

interface Props {
  /** Markdown actual de la hoja. */
  text: string;
  /** Callback de auto-save con debounce. */
  onPersist?: (text: string) => void | Promise<void>;
  /** Si true, solo preview — sin textarea ni toolbar. */
  readOnly?: boolean;
  className?: string;
}

type ViewMode = "split" | "editor" | "preview";

const DEBOUNCE_MS = 1500;

/**
 * Inserta sintaxis markdown alrededor de la selección actual del
 * textarea. Si no hay selección, inserta el placeholder entre los
 * delimitadores. Mueve el caret al final del nuevo contenido para
 * que el usuario pueda seguir escribiendo.
 */
function wrapSelection(
  textarea: HTMLTextAreaElement,
  left: string,
  right: string,
  placeholder: string,
): { value: string; selectionStart: number; selectionEnd: number } {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  const selected = value.slice(start, end);
  const inner = selected || placeholder;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const newValue = `${before}${left}${inner}${right}${after}`;
  // Cursor: si había selección, dejarlo después del nuevo contenido;
  // si no, seleccionar el placeholder para que el usuario lo
  // sobreescriba escribiendo.
  const newStart = selected
    ? before.length + left.length + inner.length + right.length
    : before.length + left.length;
  const newEnd = selected ? newStart : newStart + placeholder.length;
  return { value: newValue, selectionStart: newStart, selectionEnd: newEnd };
}

/**
 * Inserta un prefijo de línea (ej. "# ", "- ", "> ") al inicio de la
 * línea actual o de cada línea de la selección multi-línea.
 */
function prefixLines(
  textarea: HTMLTextAreaElement,
  prefix: string,
): { value: string; selectionStart: number; selectionEnd: number } {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  // Expandir el rango hasta el inicio de la primera línea seleccionada.
  let lineStart = start;
  while (lineStart > 0 && value[lineStart - 1] !== "\n") lineStart -= 1;
  const selected = value.slice(lineStart, end);
  const prefixed = selected
    .split("\n")
    .map((l) => (l.startsWith(prefix) ? l : `${prefix}${l}`))
    .join("\n");
  const before = value.slice(0, lineStart);
  const after = value.slice(end);
  const newValue = `${before}${prefixed}${after}`;
  const newStart = lineStart + prefix.length;
  const newEnd = lineStart + prefixed.length;
  return { value: newValue, selectionStart: newStart, selectionEnd: newEnd };
}

export function TextPageEditor({ text, onPersist, readOnly, className }: Props) {
  // El value del textarea es controlled por estado local — escribir
  // re-renderiza inmediatamente y el debounce se encarga de persistir.
  // Si el `text` prop cambia (ej. usuario cambia de hoja y el padre
  // re-monta este componente con un nuevo key), el initialValue se
  // re-aplica via initialTextRef.
  const initialTextRef = useRef(text);
  const [value, setValue] = useState(text);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<ViewMode>("split");
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Auto-save con debounce. Mismo modelo que WhiteboardEditor: ref a
  // la última pieza de texto pendiente + Promise.resolve+catch en flush
  // para evitar unhandled rejections del setTimeout.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTextRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string>(text);
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  // Cleanup: si hay flush pendiente al desmontar, dispararlo
  // inmediatamente (mismo patrón que WhiteboardEditor).
  useEffect(() => {
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        const pending = pendingTextRef.current;
        const fn = onPersistRef.current;
        if (pending != null && fn) {
          Promise.resolve(fn(pending)).catch((err) => {
            console.error("[TextPageEditor] flush on unmount failed", err);
          });
        }
      }
    };
  }, []);

  // Si el padre re-monta el componente con un text distinto (clave
  // por pageId en MultiPageWhiteboard), sincronizar el value local.
  // Sin esto, cambiar de hoja mantendría el texto viejo en el
  // textarea hasta el primer onChange.
  useEffect(() => {
    if (text !== initialTextRef.current) {
      initialTextRef.current = text;
      setValue(text);
      lastSavedRef.current = text;
    }
  }, [text]);

  const scheduleSave = useCallback(
    (next: string) => {
      if (readOnly || !onPersistRef.current) return;
      if (next === lastSavedRef.current) return;
      pendingTextRef.current = next;
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        const fn = onPersistRef.current;
        const pending = pendingTextRef.current;
        pendingTextRef.current = null;
        persistTimerRef.current = null;
        if (pending == null || !fn) return;
        lastSavedRef.current = pending;
        Promise.resolve(fn(pending)).catch((err) => {
          console.error("[TextPageEditor] auto-save onPersist rejected", err);
        });
      }, DEBOUNCE_MS);
    },
    [readOnly],
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value;
    setValue(next);
    scheduleSave(next);
  };

  // Toolbar handlers: cada uno opera sobre el textarea ref + actualiza
  // el state local y dispara scheduleSave para que el cambio persista.
  const applyEdit = (
    fn: (ta: HTMLTextAreaElement) => {
      value: string;
      selectionStart: number;
      selectionEnd: number;
    },
  ) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const result = fn(ta);
    setValue(result.value);
    scheduleSave(result.value);
    // Re-foco + restaurar selección tras el re-render. requestAnimationFrame
    // garantiza que el DOM ya tenga el value nuevo cuando seteamos
    // selectionRange.
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  };

  const handleBold = () => applyEdit((ta) => wrapSelection(ta, "**", "**", "texto en negrita"));
  const handleItalic = () => applyEdit((ta) => wrapSelection(ta, "*", "*", "texto en cursiva"));
  const handleCode = () => applyEdit((ta) => wrapSelection(ta, "`", "`", "código"));
  const handleCodeBlock = () =>
    applyEdit((ta) => wrapSelection(ta, "\n```\n", "\n```\n", "// código"));
  const handleH1 = () => applyEdit((ta) => prefixLines(ta, "# "));
  const handleH2 = () => applyEdit((ta) => prefixLines(ta, "## "));
  const handleUnorderedList = () => applyEdit((ta) => prefixLines(ta, "- "));
  const handleOrderedList = () => applyEdit((ta) => prefixLines(ta, "1. "));
  const handleQuote = () => applyEdit((ta) => prefixLines(ta, "> "));
  const handleLink = () => {
    const url = window.prompt("URL del enlace:", "https://");
    if (!url) return;
    applyEdit((ta) => wrapSelection(ta, "[", `](${url})`, "texto del enlace"));
  };

  const toggleFullscreen = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      void el.requestFullscreen().catch((err) => {
        console.warn("[TextPageEditor] requestFullscreen failed", err);
      });
    } else {
      void document.exitFullscreen().catch(() => {});
    }
  }, []);
  useEffect(() => {
    const handler = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", handler);
    return () => document.removeEventListener("fullscreenchange", handler);
  }, []);

  // Read-only: solo MarkdownViewer ocupando el área completa.
  if (readOnly) {
    return (
      <div ref={containerRef} className={cn("relative bg-background overflow-auto", className)}>
        <div className="p-4 sm:p-6 max-w-4xl mx-auto">
          <MarkdownViewer>{value || "*(hoja sin contenido)*"}</MarkdownViewer>
        </div>
        <button
          type="button"
          onClick={toggleFullscreen}
          aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
          title={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
          className="absolute bottom-2 right-2 z-10 rounded-md border border-border bg-background/90 backdrop-blur-sm p-1.5 text-muted-foreground hover:text-foreground hover:bg-background transition-colors shadow-sm"
        >
          {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn("relative flex flex-col min-h-0", isFullscreen && "bg-background", className)}
    >
      {/* Toolbar: botones de markdown + selector de vista. flex-wrap
          para mobile (toolbar reflowing en lugar de overflow horizontal). */}
      <div className="flex items-center gap-1 border-b border-border bg-muted/30 px-2 py-1.5 flex-wrap shrink-0">
        <ToolbarButton label="Encabezado 1" icon={Heading1} onClick={handleH1} />
        <ToolbarButton label="Encabezado 2" icon={Heading2} onClick={handleH2} />
        <ToolbarDivider />
        <ToolbarButton label="Negrita (Ctrl+B)" icon={Bold} onClick={handleBold} />
        <ToolbarButton label="Cursiva (Ctrl+I)" icon={Italic} onClick={handleItalic} />
        <ToolbarDivider />
        <ToolbarButton label="Lista" icon={List} onClick={handleUnorderedList} />
        <ToolbarButton label="Lista numerada" icon={ListOrdered} onClick={handleOrderedList} />
        <ToolbarButton label="Cita" icon={Quote} onClick={handleQuote} />
        <ToolbarDivider />
        <ToolbarButton label="Código inline" icon={Code} onClick={handleCode} />
        <ToolbarButton label="Bloque de código" icon={Code2} onClick={handleCodeBlock} />
        <ToolbarButton label="Enlace" icon={Link2} onClick={handleLink} />
        <div className="ml-auto flex items-center gap-1">
          {/* Selector de vista. En desktop el default es split (50/50);
              el usuario puede cambiar a solo-editor o solo-preview.
              En mobile el split no cabe — collapse a "editor" o
              "preview" via los mismos botones. */}
          <ToolbarButton
            label="Editor"
            icon={Pencil}
            onClick={() => setView("editor")}
            active={view === "editor"}
          />
          <ToolbarButton
            label="Vista previa"
            icon={Eye}
            onClick={() => setView("preview")}
            active={view === "preview"}
          />
          <Button
            type="button"
            variant={view === "split" ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setView("split")}
            className="h-7 text-xs hidden md:inline-flex"
            title="Editor + Vista previa (lado a lado)"
          >
            Dividido
          </Button>
        </div>
      </div>

      {/* Cuerpo. En mobile (< md) NUNCA es split — fuerza editor o
          preview según `view`. En md+ respeta `view`. */}
      <div
        className={cn(
          "flex-1 min-h-0 flex flex-col md:flex-row",
          // Si está en split, ambos paneles visibles en md+.
        )}
      >
        {(view === "split" || view === "editor") && (
          <div
            className={cn(
              "flex-1 min-h-0 flex flex-col",
              view === "split" ? "md:border-r border-border" : "",
              // En mobile, si view es split, mostramos solo el editor
              // (mobile no soporta split-view).
              view === "split" ? "md:flex flex" : "flex",
            )}
          >
            <Textarea
              ref={textareaRef}
              value={value}
              onChange={handleChange}
              placeholder="Escribe acá tu contenido. Soporta **markdown**: # encabezados, listas, código, citas…"
              className={cn(
                "flex-1 min-h-0 resize-none font-mono text-sm leading-relaxed rounded-none border-0 focus-visible:ring-0 focus-visible:ring-offset-0",
                "p-4",
              )}
              onKeyDown={(e) => {
                // Atajos típicos: Ctrl/Cmd+B y Ctrl/Cmd+I.
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
                  e.preventDefault();
                  handleBold();
                } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "i") {
                  e.preventDefault();
                  handleItalic();
                }
              }}
            />
          </div>
        )}
        {(view === "split" || view === "preview") && (
          <div
            className={cn(
              "flex-1 min-h-0 overflow-auto bg-background",
              // Mobile: si view='split', oculta el preview (mostramos
              // solo editor en mobile). md+: muestra ambos.
              view === "split" ? "hidden md:block" : "block",
            )}
          >
            <div className="p-4 sm:p-6 max-w-4xl mx-auto">
              <MarkdownViewer>
                {value || "*(empieza a escribir para ver la vista previa)*"}
              </MarkdownViewer>
            </div>
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
        title={isFullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
        className="absolute bottom-2 right-2 z-10 rounded-md border border-border bg-background/90 backdrop-blur-sm p-1.5 text-muted-foreground hover:text-foreground hover:bg-background transition-colors shadow-sm"
      >
        {isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
      </button>
    </div>
  );
}

function ToolbarButton({
  label,
  icon: Icon,
  onClick,
  active,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="h-8 w-8 p-0 shrink-0"
    >
      <Icon className="h-3.5 w-3.5" />
    </Button>
  );
}

function ToolbarDivider() {
  return <span aria-hidden className="h-5 w-px bg-border mx-0.5 shrink-0" />;
}

/**
 * Lightweight Mermaid renderer used to preview diagrams that students paste
 * into per-file project text boxes. Renders silently — if the content is not
 * valid Mermaid the component shows nothing (callers can show their own
 * placeholder via `fallback`).
 *
 * Detection:
 *   `looksLikeMermaid(text)` — true when the trimmed text starts with one of
 *   the standard Mermaid diagram keywords (graph, flowchart, sequenceDiagram,
 *   classDiagram, stateDiagram, erDiagram, gantt, pie, journey, mindmap,
 *   timeline, gitGraph). Use this from callers to decide whether to mount
 *   the preview at all.
 */
import { useEffect, useRef, useState } from "react";

const MERMAID_KEYWORDS = [
  "graph",
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "pie",
  "journey",
  "mindmap",
  "timeline",
  "gitGraph",
  "C4Context",
  "C4Container",
  "C4Component",
  "quadrantChart",
  "requirementDiagram",
];

export function looksLikeMermaid(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const firstWord = trimmed.split(/\s+/)[0];
  return MERMAID_KEYWORDS.some(
    (kw) => firstWord === kw || firstWord.toLowerCase() === kw.toLowerCase(),
  );
}

interface MermaidPreviewProps {
  code: string;
  className?: string;
}

export function MermaidPreview({ code, className }: MermaidPreviewProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mermaid-prev-${Math.random().toString(36).slice(2, 9)}`);

  useEffect(() => {
    let cancelled = false;
    if (!code.trim()) {
      setSvg("");
      setError(null);
      return;
    }
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
          securityLevel: "strict",
          fontFamily: "Inter, sans-serif",
        });
        const { svg: rendered } = await mermaid.render(idRef.current, code);
        if (cancelled) return;
        setSvg(rendered);
        setError(null);
        idRef.current = `mermaid-prev-${Math.random().toString(36).slice(2, 9)}`;
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Error de sintaxis Mermaid");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className={`rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive ${className ?? ""}`}>
        Error en el diagrama: {error}
      </div>
    );
  }

  if (!svg) return null;

  return (
    <div
      className={`rounded-md border bg-background p-3 overflow-auto ${className ?? ""}`}
      // svg comes from mermaid (securityLevel: strict)
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

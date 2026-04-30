/**
 * SlotDeliverableView — review-side render of a single project file slot's
 * uploaded attachments.
 *
 * For each attachment:
 *   - Shows the filename, size and a Download button (signed URL).
 *   - For `.md` (or any text-like file): downloads its content and renders
 *     it as Markdown. Mermaid blocks (```mermaid ... ```) and any plain
 *     mermaid keyword content are rendered through `MermaidPreview`.
 *   - For source code files (`.java`, `.py`, …): downloads the text and
 *     shows it inside a monospace block with horizontal scroll.
 *   - For binary/unknown types: shows only the download button.
 *
 * The bucket id is hard-coded to `project-files` because that's the bucket
 * created by the project_attachments migration.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Download, FileText, Loader2 } from "lucide-react";
import { MermaidPreview, looksLikeMermaid } from "@/components/MermaidPreview";

const BUCKET = "project-files";

const TEXT_EXTS = new Set([
  "md",
  "markdown",
  "txt",
  "java",
  "py",
  "js",
  "mjs",
  "ts",
  "tsx",
  "jsx",
  "cs",
  "cpp",
  "c",
  "h",
  "hpp",
  "go",
  "rb",
  "php",
  "html",
  "htm",
  "css",
  "sql",
  "json",
  "xml",
  "yaml",
  "yml",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isTextLike(att: { file_name: string; mime_type: string | null }): boolean {
  if (att.mime_type?.startsWith("text/")) return true;
  return TEXT_EXTS.has(extOf(att.file_name));
}

function isMarkdown(att: { file_name: string; mime_type: string | null }): boolean {
  const e = extOf(att.file_name);
  return e === "md" || e === "markdown" || att.mime_type === "text/markdown";
}

/** Extracts ```mermaid``` fenced blocks from a Markdown string. Returns the
 *  list of code snippets in order; if none are found, returns []. */
function extractMermaidBlocks(md: string): string[] {
  const out: string[] = [];
  const re = /```mermaid\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md)) !== null) out.push(m[1].trim());
  return out;
}

interface AttachmentRow {
  id: string;
  file_name: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number;
}

interface Props {
  slot: { id: string; title: string; language: string | null };
  attachments: AttachmentRow[];
}

export function SlotDeliverableView({ slot, attachments }: Props) {
  if (!attachments.length) {
    return (
      <p className="text-xs text-muted-foreground italic">Sin archivos entregados.</p>
    );
  }
  return (
    <div className="space-y-3">
      {attachments.map((a) => (
        <AttachmentItem key={a.id} attachment={a} slotLanguage={slot.language} />
      ))}
    </div>
  );
}

function AttachmentItem({
  attachment,
  slotLanguage,
}: {
  attachment: AttachmentRow;
  slotLanguage: string | null;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const textLike = isTextLike(attachment);
  const markdown = isMarkdown(attachment);

  // Auto-fetch text content (only for text-like files, capped to skip giant uploads).
  useEffect(() => {
    if (!textLike || attachment.size_bytes > 1_000_000) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase.storage.from(BUCKET).download(attachment.storage_path);
      if (cancelled) return;
      if (error || !data) {
        setText(null);
        setLoading(false);
        return;
      }
      try {
        const t = await data.text();
        if (!cancelled) setText(t);
      } catch {
        if (!cancelled) setText(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.storage_path, attachment.size_bytes, textLike]);

  const onDownload = async () => {
    setDownloading(true);
    try {
      const { data } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(attachment.storage_path, 3600);
      if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    } finally {
      setDownloading(false);
    }
  };

  // For Mermaid slots or any Markdown file, prefer rendering Mermaid blocks.
  const mermaidBlocks = markdown && text ? extractMermaidBlocks(text) : [];
  const isDiagramSlot =
    slotLanguage === "mermaid" || slotLanguage === "diagrama" || slotLanguage === "diagram";
  const showWholeAsMermaid =
    isDiagramSlot && text && mermaidBlocks.length === 0 && looksLikeMermaid(text);

  return (
    <div className="rounded-md border bg-muted/20 overflow-hidden">
      <div className="flex items-center gap-2 p-2 border-b bg-muted/40">
        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="font-medium text-xs truncate flex-1" title={attachment.file_name}>
          {attachment.file_name}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums">
          {(attachment.size_bytes / 1024).toFixed(1)} KB
        </span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onDownload} disabled={downloading}>
          {downloading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Download className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {loading && (
        <p className="p-3 text-xs text-muted-foreground">
          <Loader2 className="inline h-3 w-3 animate-spin mr-1" /> Cargando…
        </p>
      )}

      {!loading && text != null && mermaidBlocks.length > 0 && (
        <div className="p-3 space-y-3">
          {mermaidBlocks.map((code, i) => (
            <MermaidPreview key={i} code={code} />
          ))}
          <details>
            <summary className="text-[11px] text-muted-foreground cursor-pointer">
              Ver fuente Markdown
            </summary>
            <pre className="text-[11px] whitespace-pre-wrap font-mono max-h-72 overflow-y-auto mt-2 p-2 rounded bg-background border">
              {text}
            </pre>
          </details>
        </div>
      )}

      {!loading && showWholeAsMermaid && text != null && (
        <div className="p-3">
          <MermaidPreview code={text} />
        </div>
      )}

      {!loading &&
        text != null &&
        mermaidBlocks.length === 0 &&
        !showWholeAsMermaid && (
          <pre className="text-[11px] whitespace-pre-wrap font-mono max-h-72 overflow-y-auto p-3 bg-background">
            {text}
          </pre>
        )}

      {!loading && text == null && !textLike && (
        <p className="p-3 text-xs text-muted-foreground">
          Archivo binario. Descarga para verlo localmente.
        </p>
      )}

      {!loading && text == null && textLike && (
        <p className="p-3 text-xs text-muted-foreground">
          Archivo demasiado grande para previsualizar. Usa el botón de descarga.
        </p>
      )}
    </div>
  );
}

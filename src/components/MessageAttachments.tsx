/**
 * MessageAttachments — render de adjuntos de UN message.
 *
 * Análogo a FeedbackCommentAttachments pero apunta al bucket
 * `message-attachments` y a la tabla `message_attachments`.
 *
 * - Botón descarga: genera signed URL al click.
 * - Botón quitar: solo si soy el uploader (rara vez se ofrece, pero la
 *   RLS lo permite — en mensajería no exponemos esta acción para
 *   mantener inmutabilidad post-envío; se controla via prop `canDelete`).
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import {
  Download,
  FileText,
  FileImage,
  FileArchive,
  FileCode,
  File as FileIcon,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  attachmentIconKind,
  formatAttachmentSize,
  type MessageAttachmentRow,
} from "@/lib/message-attachments";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

const ICON_BY_KIND: Record<ReturnType<typeof attachmentIconKind>, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  doc: FileText,
  zip: FileArchive,
  code: FileCode,
  file: FileIcon,
};

interface Props {
  attachments: MessageAttachmentRow[];
  /** Mostrar botón "Quitar" — solo se activa si el caller decide. */
  canDelete?: boolean;
  onChanged?: () => void;
  /** Aplica estilo "inverso" cuando el adjunto va dentro de un bubble
   *  con fondo primario (mi mensaje). Sin esto, los íconos quedan
   *  invisibles sobre el azul. */
  inverted?: boolean;
}

export function MessageAttachments({ attachments, canDelete, onChanged, inverted }: Props) {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const download = async (a: MessageAttachmentRow) => {
    setDownloadingId(a.id);
    try {
      const { data, error } = await supabase.storage
        .from("message-attachments")
        .createSignedUrl(a.path, 60);
      if (error || !data?.signedUrl) {
        toast.error(error?.message ?? "No se pudo generar el enlace de descarga.");
        return;
      }
      const link = document.createElement("a");
      link.href = data.signedUrl;
      link.download = a.name;
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } finally {
      setDownloadingId(null);
    }
  };

  const remove = async (a: MessageAttachmentRow) => {
    if (!confirm(`¿Quitar el adjunto "${a.name}"?`)) return;
    setDeletingId(a.id);
    try {
      await supabase.storage.from("message-attachments").remove([a.path]);
      const { error } = await db.from("message_attachments").delete().eq("id", a.id);
      if (error) {
        toast.error(error.message);
        return;
      }
      onChanged?.();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <ul className="space-y-1 mt-1.5" data-testid="message-attachments">
      {attachments.map((a) => {
        const kind = attachmentIconKind(a.mime_type, a.name);
        const Icon = ICON_BY_KIND[kind];
        const isDownloading = downloadingId === a.id;
        const isDeleting = deletingId === a.id;
        return (
          <li
            key={a.id}
            className={
              "flex items-center gap-2 rounded border px-2 py-1 text-[11px] " +
              (inverted
                ? "bg-primary-foreground/10 border-primary-foreground/20"
                : "bg-background/60")
            }
          >
            <Icon
              className={
                "h-3.5 w-3.5 shrink-0 " +
                (inverted ? "text-primary-foreground/80" : "text-muted-foreground")
              }
            />
            <span className="truncate flex-1" title={a.name}>
              {a.name}
            </span>
            <span
              className={
                "tabular-nums shrink-0 " +
                (inverted ? "text-primary-foreground/70" : "text-muted-foreground")
              }
            >
              {formatAttachmentSize(a.size_bytes)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-5 w-5 shrink-0"
              onClick={() => void download(a)}
              disabled={isDownloading || isDeleting}
              title="Descargar"
              aria-label={`Descargar ${a.name}`}
            >
              {isDownloading ? <Spinner size="xs" /> : <Download className="h-3 w-3" />}
            </Button>
            {canDelete && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0 text-destructive hover:text-destructive"
                onClick={() => void remove(a)}
                disabled={isDeleting || isDownloading}
                title="Quitar"
                aria-label={`Quitar ${a.name}`}
              >
                {isDeleting ? <Spinner size="xs" /> : <Trash2 className="h-3 w-3" />}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

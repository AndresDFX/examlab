/**
 * FeedbackCommentAttachments — lista de adjuntos de UN feedback_comment.
 *
 * - Recibe la fila ya cargada por el padre (FeedbackThread carga todos
 *   los adjuntos del thread en un solo round-trip al inicio).
 * - Por cada adjunto muestra: icono según MIME, nombre, tamaño, y un
 *   botón de descarga que genera un signed URL fresco (RLS-respetando)
 *   al hacer click.
 * - Si el adjunto es del autor del comment (uploaded_by === auth.uid())
 *   y el comment NO está cerrado, expone botón "Quitar" — borra del
 *   bucket + de la tabla.
 *
 * Pensado para insertarse DENTRO de cada burbuja de comment.
 */
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/use-auth";
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
import { friendlyError } from "@/shared/lib/db-errors";
import {
  attachmentIconKind,
  formatAttachmentSize,
  type AttachmentRow,
} from "@/modules/grading/feedback-attachments";

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
  attachments: AttachmentRow[];
  /** Cuando un adjunto se borra, el padre puede refrescar su lista. */
  onChanged?: () => void;
  /** Si el comment está cerrado, NO mostramos el botón "Quitar" — los
   *  adjuntos quedan como histórico. */
  closed?: boolean;
}

export function FeedbackCommentAttachments({ attachments, onChanged, closed }: Props) {
  const { user } = useAuth();
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  const download = async (a: AttachmentRow) => {
    setDownloadingId(a.id);
    try {
      const { data, error } = await supabase.storage
        .from("feedback-attachments")
        .createSignedUrl(a.path, 60); // 60s para que el navegador descargue
      if (error || !data?.signedUrl) {
        toast.error(friendlyError(error, "No se pudo generar el enlace de descarga."));
        return;
      }
      // Abre en nueva pestaña — el navegador descarga por Content-Disposition.
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

  const remove = async (a: AttachmentRow) => {
    if (!confirm(`¿Quitar el adjunto "${a.name}"?`)) return;
    setDeletingId(a.id);
    try {
      // Borra primero del bucket (idempotente — si no existe igual sigue).
      await supabase.storage.from("feedback-attachments").remove([a.path]);
      const { error } = await db.from("feedback_attachments").delete().eq("id", a.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      onChanged?.();
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <ul className="space-y-1 mt-1.5" data-testid="feedback-attachments">
      {attachments.map((a) => {
        const kind = attachmentIconKind(a.mime_type, a.name);
        const Icon = ICON_BY_KIND[kind];
        const mine = user?.id === a.uploaded_by;
        const isDownloading = downloadingId === a.id;
        const isDeleting = deletingId === a.id;
        return (
          <li
            key={a.id}
            className="flex items-center gap-2 rounded border bg-background/60 px-2 py-1 text-[11px]"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate flex-1" title={a.name}>
              {a.name}
            </span>
            <span className="text-muted-foreground tabular-nums shrink-0">
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
            {mine && !closed && (
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

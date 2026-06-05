/**
 * SessionWhiteboardDialog — wrapper de WhiteboardEditor para sesiones
 * presenciales (attendance_sessions).
 *
 * Diferente del whiteboard standalone:
 *  - No tiene tabla propia — persiste en
 *    `attendance_sessions.whiteboard_scene` (1:1 con la sesión).
 *  - No tiene nombre ni share toggle — heredan de la sesión: la pueden
 *    ver el docente del curso y los alumnos matriculados (RLS de
 *    attendance_sessions).
 *  - Se abre en un Dialog (no en una página) porque el docente está
 *    "en" la pantalla de asistencia y quiere volver al dropdown sin
 *    perder contexto.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { WhiteboardEditor, type WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";
import { Palette } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  /** Si null, el dialog está cerrado. Cuando se setea, abrimos +
   *  cargamos la escena. */
  sessionId: string | null;
  /** Etiqueta humana para el header — ej "Clase 3 · 28 sep". */
  sessionLabel?: string;
  onOpenChange: (open: boolean) => void;
}

export function SessionWhiteboardDialog({ sessionId, sessionLabel, onOpenChange }: Props) {
  const [scene, setScene] = useState<WhiteboardScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setScene(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const { data, error } = await db
        .from("attendance_sessions")
        .select("whiteboard_scene")
        .eq("id", sessionId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        toast.error(friendlyError(error, "No pudimos cargar la pizarra."));
        setLoading(false);
        return;
      }
      // Si la sesión nunca tuvo pizarra, scene = null → editor arranca
      // con escena vacía.
      setScene((data as { whiteboard_scene?: WhiteboardScene } | null)?.whiteboard_scene ?? null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const persistScene = async (next: WhiteboardScene) => {
    if (!sessionId) return;
    setAutoSaving(true);
    try {
      const { error } = await db
        .from("attendance_sessions")
        .update({ whiteboard_scene: next })
        .eq("id", sessionId);
      if (error) {
        toast.error(friendlyError(error, "No se pudo guardar la pizarra"));
        return;
      }
    } finally {
      setTimeout(() => setAutoSaving(false), 400);
    }
  };

  return (
    <Dialog open={Boolean(sessionId)} onOpenChange={onOpenChange}>
      {/* max-w[calc(100vw-2rem)] sm:max-w-6xl para usar todo el ancho
          razonable en desktop. h-[90vh] para que la pizarra tenga
          espacio vertical útil — Excalidraw rinde mal en alturas
          pequeñas (toolbar arriba + canvas abajo). */}
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-6xl h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Palette className="h-5 w-5 text-violet-500" />
            Pizarra {sessionLabel ? `· ${sessionLabel}` : ""}
            {autoSaving && (
              <span className="text-xs text-muted-foreground font-normal inline-flex items-center gap-1 ml-2">
                <Spinner size="xs" /> Guardando…
              </span>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" /> Cargando pizarra…
            </div>
          ) : (
            <WhiteboardEditor scene={scene} onPersist={persistScene} className="w-full h-full" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

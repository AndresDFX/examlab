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
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { HelpHint } from "@/components/ui/help-hint";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { WhiteboardEditor, type WhiteboardScene } from "@/modules/whiteboard/WhiteboardEditor";
import { Palette, Users } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  /** Si null, el dialog está cerrado. Cuando se setea, abrimos +
   *  cargamos la escena. */
  sessionId: string | null;
  /** Etiqueta humana para el header — ej "Clase 3 · 28 sep". */
  sessionLabel?: string;
  onOpenChange: (open: boolean) => void;
  /** Si true, el componente interno trata al usuario como ALUMNO:
   *   - No muestra el toggle de "compartir".
   *   - El UPDATE de la escena solo se acepta server-side si la sesión
   *     tiene whiteboard_shared=true (lo enforce la RPC).
   *   - El canal Realtime se activa automáticamente si shared=true.
   *  Si false (default), trata al usuario como DOCENTE — puede toggle. */
  studentMode?: boolean;
}

export function SessionWhiteboardDialog({
  sessionId,
  sessionLabel,
  onOpenChange,
  studentMode,
}: Props) {
  const { t } = useTranslation();
  const [scene, setScene] = useState<WhiteboardScene | null>(null);
  const [loading, setLoading] = useState(false);
  const [autoSaving, setAutoSaving] = useState(false);
  // Estado del flag whiteboard_shared. Solo el docente puede toggle vía
  // RPC. El alumno solo lo lee — si es false, su Editor queda en
  // readOnly (lo decidimos abajo en el render).
  const [shared, setShared] = useState(false);
  const [togglingShared, setTogglingShared] = useState(false);

  useEffect(() => {
    if (!sessionId) {
      setScene(null);
      setShared(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        setLoading(true);
        const { data, error } = await db
          .from("attendance_sessions")
          .select("whiteboard_scene, whiteboard_shared")
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
        const row = data as {
          whiteboard_scene?: WhiteboardScene;
          whiteboard_shared?: boolean;
        } | null;
        setScene(row?.whiteboard_scene ?? null);
        setShared(Boolean(row?.whiteboard_shared));
        setLoading(false);
      } catch (e) {
        // IIFE async sin try/catch dejaba rejections de la query como
        // unhandled (network throw, sesión expirada mientras se abre el
        // dialog). Acá toast amigable + reset loading.
        if (cancelled) return;
        toast.error(friendlyError(e, "No pudimos cargar la pizarra."));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const persistScene = async (next: WhiteboardScene) => {
    if (!sessionId) return;
    setAutoSaving(true);
    try {
      // Usamos la RPC `update_session_whiteboard_scene` (mig 20260815000000)
      // en lugar de UPDATE directo. La RPC enforce que solo el docente o
      // un alumno matriculado con shared=true pueda escribir. Único path
      // tanto para docente como alumno — sin condicionales en cliente.
      const { error } = await db.rpc("update_session_whiteboard_scene", {
        _session_id: sessionId,
        _scene: next,
      });
      if (error) {
        toast.error(friendlyError(error, "No se pudo guardar la pizarra"));
        return;
      }
    } catch (e) {
      // El supabase-js normalmente devuelve `{error}`; pero hay casos
      // donde el await rechaza (network throw, AbortError, sesión
      // expirada). Sin catch, la rejection sube al .catch del
      // WhiteboardEditor (que solo loguea consola) → el docente NO ve
      // toast amigable. Acá cerramos el contrato: usuario siempre
      // recibe feedback de que el guardado falló.
      toast.error(friendlyError(e, "No se pudo guardar la pizarra"));
    } finally {
      setTimeout(() => setAutoSaving(false), 400);
    }
  };

  const toggleShared = async (next: boolean) => {
    if (!sessionId || studentMode) return;
    setTogglingShared(true);
    // UI optimista — revertimos si la RPC falla.
    setShared(next);
    try {
      const { error } = await db.rpc("set_session_whiteboard_shared", {
        _session_id: sessionId,
        _shared: next,
      });
      if (error) {
        setShared(!next);
        toast.error(friendlyError(error, "No se pudo cambiar el modo compartido"));
      } else {
        toast.success(
          next
            ? i18n.t("toast.modules_whiteboard_SessionWhiteboardDialog.sharedEnabled", {
                defaultValue: "Pizarra compartida activada",
              })
            : i18n.t("toast.modules_whiteboard_SessionWhiteboardDialog.sharedDisabled", {
                defaultValue: "Pizarra compartida desactivada",
              }),
        );
      }
    } catch (e) {
      setShared(!next);
      toast.error(friendlyError(e, "No se pudo cambiar el modo compartido"));
    } finally {
      setTogglingShared(false);
    }
  };

  // El alumno solo puede ESCRIBIR si shared=true; sino la pizarra
  // queda visible en readOnly. El docente siempre puede escribir.
  const editorReadOnly = studentMode && !shared;
  // Canal Realtime solo cuando shared=true — sino broadcast inútil que
  // gasta cuota. Tanto docente como alumno se enchufan al mismo canal.
  const realtimeChannelName = shared && sessionId ? `wb_session:${sessionId}` : undefined;

  return (
    <Dialog open={Boolean(sessionId)} onOpenChange={onOpenChange}>
      {/* max-w[calc(100vw-2rem)] sm:max-w-6xl para usar todo el ancho
          razonable en desktop. h-[90vh] para que la pizarra tenga
          espacio vertical útil — Excalidraw rinde mal en alturas
          pequeñas (toolbar arriba + canvas abajo). */}
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-6xl h-[90vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-3 border-b">
          <DialogTitle className="flex items-center gap-2 text-base flex-wrap">
            <Palette className="h-5 w-5 text-violet-500" />
            Pizarra {sessionLabel ? `· ${sessionLabel}` : ""}
            {autoSaving && (
              <span className="text-xs text-muted-foreground font-normal inline-flex items-center gap-1 ml-2">
                <Spinner size="xs" /> Guardando…
              </span>
            )}
            {/* Toggle "Compartida" — solo el docente lo ve. El alumno
                ya recibe la propiedad shared del padre vía load() y se
                enchufa al canal Realtime automáticamente si está ON. */}
            {!studentMode && sessionId && (
              <div className="ml-auto flex items-center gap-2">
                <Users className="h-4 w-4 text-sky-600" />
                <Label
                  htmlFor="wb-shared-toggle"
                  className="text-xs font-normal cursor-pointer mb-0"
                >
                  Pizarra compartida
                </Label>
                <HelpHint side="left">{t("help.sharedWhiteboardHelp")}</HelpHint>
                <Switch
                  id="wb-shared-toggle"
                  checked={shared}
                  disabled={togglingShared}
                  onCheckedChange={(v) => void toggleShared(v)}
                />
              </div>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0">
          {loading ? (
            <div className="flex items-center justify-center h-full gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" /> Cargando pizarra…
            </div>
          ) : (
            <WhiteboardEditor
              scene={scene}
              onPersist={persistScene}
              className="w-full h-full"
              readOnly={editorReadOnly}
              // Viewport persistido en localStorage por sesión — al cerrar
              // y reabrir el dialog, el zoom/pan se mantienen donde quedaron.
              viewportStorageKey={`examlab_wb_view:session:${sessionId}`}
              // Canal Realtime activo solo cuando shared=true. Tanto el
              // docente como los alumnos se enchufan al mismo canal, y
              // los broadcasts se filtran por clientId para no eco.
              realtimeChannelName={realtimeChannelName}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

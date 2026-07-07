/**
 * SessionCodeSnippetsDialog — Dialog wrapper alrededor de
 * `SessionCodeSnippets`. Análogo al `SessionWhiteboardDialog` — un
 * `pollDialog` que abre con la sesión seleccionada.
 *
 * Se usa desde `app.teacher.attendance.tsx`: el docente clickea
 * "Snippets de código" en el dropdown de la sesión y se abre este
 * dialog. El componente interno hace todo el CRUD via session_id.
 */
import { useEffect, useState } from "react";
import i18n from "@/i18n";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { SessionCodeSnippets } from "@/modules/sessions/SessionCodeSnippets";
import { Code2, Users } from "lucide-react";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

interface Props {
  /** Si null, el dialog está cerrado. Cuando se setea, abrimos. */
  sessionId: string | null;
  /** Etiqueta humana para el header — ej "Clase 3 · 28 sep". */
  sessionLabel?: string;
  onOpenChange: (open: boolean) => void;
  /** Si true, el componente interno opera en modo lectura — usado
   *  para previews. En la práctica los docentes lo usan en write y
   *  los alumnos lo ven inline en su attendance (no en dialog). */
  readOnly?: boolean;
}

export function SessionCodeSnippetsDialog({
  sessionId,
  sessionLabel,
  onOpenChange,
  readOnly,
}: Props) {
  // Estado del flag code_shared. Solo el docente puede toggle vía RPC.
  // Espejo exacto del toggle de la pizarra (whiteboard_shared en
  // SessionWhiteboardDialog). Si false, los alumnos matriculados NO ven
  // los snippets (lo enforce la RLS de session_code_snippets).
  const [shared, setShared] = useState(false);
  const [togglingShared, setTogglingShared] = useState(false);

  // Cargar code_shared al abrir — solo en modo docente. En readOnly no
  // mostramos el toggle, así que no hace falta el SELECT.
  useEffect(() => {
    if (!sessionId || readOnly) {
      setShared(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await db
          .from("attendance_sessions")
          .select("code_shared")
          .eq("id", sessionId)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          toast.error(
            friendlyError(
              error,
              i18n.t("toast.modules_sessions_SessionCodeSnippetsDialog.loadSharedError", {
                defaultValue: "No pudimos cargar el estado de compartido.",
              }),
            ),
          );
          return;
        }
        const row = data as { code_shared?: boolean } | null;
        setShared(Boolean(row?.code_shared));
      } catch (e) {
        if (cancelled) return;
        toast.error(
          friendlyError(
            e,
            i18n.t("toast.modules_sessions_SessionCodeSnippetsDialog.loadSharedError", {
              defaultValue: "No pudimos cargar el estado de compartido.",
            }),
          ),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, readOnly]);

  const toggleShared = async (next: boolean) => {
    if (!sessionId || readOnly) return;
    setTogglingShared(true);
    // UI optimista — revertimos si la RPC falla.
    setShared(next);
    try {
      const { error } = await db.rpc("set_session_code_shared", {
        _session_id: sessionId,
        _shared: next,
      });
      if (error) {
        setShared(!next);
        toast.error(
          friendlyError(
            error,
            i18n.t("toast.modules_sessions_SessionCodeSnippetsDialog.toggleSharedError", {
              defaultValue: "No se pudo cambiar el modo compartido",
            }),
          ),
        );
      } else {
        toast.success(
          next
            ? i18n.t("toast.modules_sessions_SessionCodeSnippetsDialog.sharedEnabled", {
                defaultValue: "Código compartido con los alumnos",
              })
            : i18n.t("toast.modules_sessions_SessionCodeSnippetsDialog.sharedDisabled", {
                defaultValue: "Código oculto para los alumnos",
              }),
        );
      }
    } catch (e) {
      setShared(!next);
      toast.error(
        friendlyError(
          e,
          i18n.t("toast.modules_sessions_SessionCodeSnippetsDialog.toggleSharedError", {
            defaultValue: "No se pudo cambiar el modo compartido",
          }),
        ),
      );
    } finally {
      setTogglingShared(false);
    }
  };

  return (
    <Dialog open={Boolean(sessionId)} onOpenChange={onOpenChange}>
      {/* max-w-4xl para que el editor de código quepa cómodo. h-[85dvh]
          con flex-col para que los snippets sean scrolleables internamente. */}
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl h-[85dvh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base flex-wrap">
            <Code2 className="h-5 w-5 text-indigo-500" />
            {i18n.t("modules_sessions_SessionCodeSnippetsDialog.title", {
              defaultValue: "Snippets de código",
            })}{" "}
            {sessionLabel ? `· ${sessionLabel}` : ""}
            {/* Toggle "Compartir con alumnos" — solo el docente lo ve.
                El alumno ve los snippets inline en su attendance solo si
                code_shared=true (lo enforce la RLS). */}
            {!readOnly && sessionId && (
              <div className="ml-auto flex items-center gap-2">
                <Users className="h-4 w-4 text-sky-600" />
                <Label
                  htmlFor="code-shared-toggle"
                  className="text-xs font-normal cursor-pointer mb-0"
                >
                  {i18n.t("modules_sessions_SessionCodeSnippetsDialog.shareWithStudents", {
                    defaultValue: "Compartir con alumnos",
                  })}
                </Label>
                <Switch
                  id="code-shared-toggle"
                  checked={shared}
                  disabled={togglingShared}
                  onCheckedChange={(v) => void toggleShared(v)}
                />
              </div>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {sessionId && <SessionCodeSnippets sessionId={sessionId} readOnly={readOnly} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * SessionCodeSnippetsDialog — Dialog wrapper alrededor de
 * `SessionCodeSnippets`. Análogo al `SessionWhiteboardDialog` — un
 * `pollDialog` que abre con la sesión seleccionada.
 *
 * Se usa desde `app.teacher.attendance.tsx`: el docente clickea
 * "Snippets de código" en el dropdown de la sesión y se abre este
 * dialog. El componente interno hace todo el CRUD via session_id.
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SessionCodeSnippets } from "@/modules/sessions/SessionCodeSnippets";
import { Code2 } from "lucide-react";

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
  return (
    <Dialog open={Boolean(sessionId)} onOpenChange={onOpenChange}>
      {/* max-w-4xl para que el editor de código quepa cómodo. h-[85vh]
          con flex-col para que los snippets sean scrolleables internamente. */}
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl h-[85vh] flex flex-col p-0 gap-0">
        <DialogHeader className="p-3 border-b shrink-0">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Code2 className="h-5 w-5 text-indigo-500" />
            Snippets de código {sessionLabel ? `· ${sessionLabel}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto p-3">
          {sessionId && <SessionCodeSnippets sessionId={sessionId} readOnly={readOnly} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}

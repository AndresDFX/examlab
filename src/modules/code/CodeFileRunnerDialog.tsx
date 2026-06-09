/**
 * CodeFileRunnerDialog — visor + ejecutor de un archivo de código subido
 * (ej. un `.java` / `.py` que el docente cargó en Contenidos y asignó a una
 * sesión). El alumno (o docente) lo abre desde el tablero de la sesión, ve
 * el código, lo puede ajustar localmente para experimentar y ejecutarlo.
 *
 * Reusa el mismo pipeline que los snippets de sesión: el editor
 * [CodeEditor](./CodeEditor.tsx) + el edge `execute-code`
 * (`{ files:[{filename,content}], language, questionId }`). A diferencia de
 * los snippets, NO persiste nada: el código fuente es el del archivo subido
 * (read-only en DB) y los cambios + la salida son efímeros (playground).
 *
 * Idioma: se deriva de la extensión del archivo via `codeLanguageForFile`.
 * Solo se ofrece "Ejecutar" para extensiones que `execute-code` soporta de
 * forma estándar (java / python / javascript).
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { CodeEditor, type CodeLanguage } from "@/modules/code/CodeEditor";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FileCode2 } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { combineFilesForExec } from "@/modules/code/combine-files";

/** Mapea la extensión de un archivo a un lenguaje ejecutable. Devuelve null
 *  si la extensión no es código ejecutable por `execute-code`. */
export function codeLanguageForFile(name: string | null | undefined): CodeLanguage | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  return null;
}

interface CodeFileLike {
  name: string;
  /** Texto del archivo (los archivos de código subidos lo guardan inline
   *  en `body` al subirse — ver UploadExternalContentDialog). */
  body?: string;
}

interface Props {
  /** Archivo a mostrar/ejecutar. `null` cierra el dialog. */
  file: CodeFileLike | null;
  onOpenChange: (open: boolean) => void;
  /** Id opcional para el audit del run (típicamente el id del contenido).
   *  Solo se usa como metadata en `execute-code`. */
  auditId?: string;
}

export function CodeFileRunnerDialog({ file, onOpenChange, auditId }: Props) {
  const open = file !== null;
  const language = codeLanguageForFile(file?.name);

  const [value, setValue] = useState("");
  const [output, setOutput] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);

  // Reset al abrir con un archivo nuevo: cargamos su body, limpiamos salida.
  useEffect(() => {
    if (file) {
      setValue(file.body ?? "");
      setOutput(undefined);
      setRunning(false);
    }
  }, [file]);

  const run = async () => {
    if (!language) return;
    if (!value.trim()) {
      toast.error("El archivo está vacío.");
      return;
    }
    setRunning(true);
    try {
      const files = [{ filename: file?.name ?? `main.${language}`, content: value }];
      const { data, error } = await supabase.functions.invoke("execute-code", {
        body: {
          files,
          // `sourceCode` legacy para edges aún sin soporte multi-archivo.
          sourceCode: combineFilesForExec(files, language),
          language,
          // Solo metadata de audit (el edge no lo valida como FK).
          questionId: auditId,
        },
      });
      if (error || data?.error) {
        toast.error(friendlyError(error ?? data?.error, "Error ejecutando el código"));
        return;
      }
      const stdout = (data?.stdout as string) ?? "";
      const stderr = (data?.stderr as string) ?? "";
      setOutput([stdout, stderr ? `\n[stderr]\n${stderr}` : ""].filter(Boolean).join("") || "(sin salida)");
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <FileCode2 className="h-4 w-4 text-indigo-500" />
            {file?.name}
          </DialogTitle>
          <DialogDescription>
            {language
              ? "Podés ajustar el código y ejecutarlo. Los cambios y la salida son temporales (no se guardan)."
              : "Vista de solo lectura — este tipo de archivo no se puede ejecutar aquí."}
          </DialogDescription>
        </DialogHeader>

        <CodeEditor
          value={value}
          onChange={setValue}
          language={language ?? "java"}
          showLanguageSelector={false}
          showRunButton={!!language}
          onRun={() => void run()}
          isRunning={running}
          readOnly={!language}
          hideHints
          height="320px"
          output={output}
        />
      </DialogContent>
    </Dialog>
  );
}

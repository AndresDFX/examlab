/**
 * NotebookRunnerDialog — visor + ejecutor de un Jupyter notebook (.ipynb)
 * subido en Contenidos. Renderiza las celdas (markdown + código) y permite
 * EJECUTAR todo el código del notebook.
 *
 * Ejecución: `execute-code` (Python) es STATELESS — no hay kernel persistente
 * entre celdas. Por eso "ejecutar el notebook" concatena todas las celdas de
 * código en orden y las corre como un solo script (top-to-bottom), que es el
 * caso típico de un notebook didáctico. Limitaciones (se avisan en la UI):
 * las magics de Jupyter (`%matplotlib`, `!pip install`) se descartan y los
 * plots/figuras no se renderizan (el executor devuelve solo texto).
 *
 * El notebook se lee de `file.body` (el upload externo guarda el .ipynb
 * inline, con outputs limpiados — ver UploadExternalContentDialog).
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { MarkdownViewer } from "@/shared/components/MarkdownViewer";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { NotebookPen, Play, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import { parseNotebook, notebookCodeToScript, countCodeCells } from "@/modules/code/notebook";
import { combineFilesForExec } from "@/modules/code/combine-files";

interface NotebookFileLike {
  name: string;
  /** Contenido del .ipynb (JSON) inline. */
  body?: string;
}

interface Props {
  /** Archivo .ipynb a mostrar/ejecutar. `null` cierra el dialog. */
  file: NotebookFileLike | null;
  onOpenChange: (open: boolean) => void;
  /** Id opcional para el audit del run (típicamente el id del contenido). */
  auditId?: string;
}

export function NotebookRunnerDialog({ file, onOpenChange, auditId }: Props) {
  const open = file !== null;
  const notebook = useMemo(() => parseNotebook(file?.body), [file]);
  const codeCellCount = countCodeCells(notebook);

  const [output, setOutput] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (file) {
      setOutput(undefined);
      setRunning(false);
    }
  }, [file]);

  const runAll = async () => {
    const script = notebookCodeToScript(notebook);
    if (!script.trim()) {
      toast.error("El notebook no tiene celdas de código para ejecutar.");
      return;
    }
    setRunning(true);
    try {
      const files = [{ filename: "notebook.py", content: script }];
      const { data, error } = await supabase.functions.invoke("execute-code", {
        body: {
          files,
          // `sourceCode` legacy para edges aún sin soporte multi-archivo.
          sourceCode: combineFilesForExec(files, "python"),
          language: "python",
          questionId: auditId,
        },
      });
      if (error || data?.error) {
        toast.error(friendlyError(error ?? data?.error, "Error ejecutando el notebook"));
        return;
      }
      const stdout = (data?.stdout as string) ?? "";
      const stderr = (data?.stderr as string) ?? "";
      setOutput(
        [stdout, stderr ? `\n[stderr]\n${stderr}` : ""].filter(Boolean).join("") || "(sin salida)",
      );
    } finally {
      setRunning(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-3xl max-h-[90dvh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm font-semibold">
            <NotebookPen className="h-4 w-4 text-orange-500" />
            {file?.name}
          </DialogTitle>
          <DialogDescription className="text-[11px]">
            {notebook
              ? `Notebook con ${notebook.cells.length} celda(s), ${codeCellCount} de código. "Ejecutar" corre todo el código en orden (sin estado entre celdas; las magics y figuras no aplican).`
              : "No se pudo leer el notebook — puede estar dañado o ser muy grande. Descárgalo para abrirlo en Jupyter."}
          </DialogDescription>
        </DialogHeader>

        {notebook ? (
          <>
            <div className="flex items-center gap-2 border-b pb-2">
              <Button size="sm" onClick={() => void runAll()} disabled={running || codeCellCount === 0}>
                {running ? <Spinner size="sm" className="mr-1.5" /> : <Play className="h-4 w-4 mr-1.5" />}
                Ejecutar todo el código
              </Button>
              {codeCellCount === 0 && (
                <span className="text-[11px] text-muted-foreground">
                  Este notebook no tiene celdas de código.
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 pr-1">
              {notebook.cells.map((cell, idx) => {
                if (cell.cell_type === "markdown") {
                  if (!cell.source.trim()) return null;
                  return (
                    <div key={idx} className="text-sm px-1">
                      <MarkdownViewer>{cell.source}</MarkdownViewer>
                    </div>
                  );
                }
                if (cell.cell_type === "raw") {
                  if (!cell.source.trim()) return null;
                  return (
                    <pre
                      key={idx}
                      className="text-[12px] font-mono bg-muted/40 rounded-md p-2 whitespace-pre-wrap break-words"
                    >
                      {cell.source}
                    </pre>
                  );
                }
                // Celda de código.
                if (!cell.source.trim()) return null;
                return (
                  <div key={idx} className="rounded-md border overflow-hidden">
                    <div className="flex items-center gap-1.5 px-2 py-1 bg-muted/40 border-b">
                      <Badge variant="secondary" className="text-[9px]">
                        código
                      </Badge>
                    </div>
                    <pre className="text-[12px] font-mono p-2 overflow-x-auto whitespace-pre">
                      {cell.source}
                    </pre>
                  </div>
                );
              })}
            </div>

            {output !== undefined && (
              <div className="border-t pt-2">
                <div className="text-[11px] font-medium text-muted-foreground mb-1">Salida</div>
                <pre className="text-[12px] font-mono bg-foreground/[0.04] rounded-md p-2 max-h-48 overflow-auto whitespace-pre-wrap break-words">
                  {output}
                </pre>
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <AlertTriangle className="h-8 w-8 text-amber-500 opacity-70" />
            <p>No se pudo leer el notebook.</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

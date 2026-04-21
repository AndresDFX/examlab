import { useRef } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, Upload, FileDown, FileUp } from "lucide-react";
import { downloadCSV, parseCSV } from "@/lib/csv";
import { toast } from "sonner";

interface ImportExportMenuProps {
  /** Etiqueta del botón principal (ej: "Datos") */
  label?: string;
  /** Nombre base para el archivo (ej: "asistencia"). Se usa también para template-{name}.csv */
  resourceName: string;
  /** Plantilla CSV ya formateada (con header + ejemplo). */
  templateCsv: string;
  /** Genera el CSV de exportación bajo demanda. Devuelve string vacío si no hay datos. */
  onExport?: () => string | Promise<string>;
  /** Callback que recibe filas parseadas del CSV importado. Debe devolver un mensaje de éxito o lanzar error. */
  onImport?: (rows: Record<string, string>[]) => Promise<string | void>;
  disabled?: boolean;
}

export function ImportExportMenu({
  label = "Datos",
  resourceName,
  templateCsv,
  onExport,
  onImport,
  disabled,
}: ImportExportMenuProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDownloadTemplate = () => {
    downloadCSV(`template-${resourceName}.csv`, templateCsv);
    toast.success("Plantilla descargada");
  };

  const handleExport = async () => {
    if (!onExport) return;
    try {
      const csv = await onExport();
      if (!csv || csv.trim() === "") {
        toast.info("No hay datos para exportar");
        return;
      }
      downloadCSV(`${resourceName}-${Date.now()}.csv`, csv);
      toast.success("Archivo exportado correctamente");
    } catch (e: any) {
      toast.error(`Error exportando: ${e?.message ?? "desconocido"}`);
    }
  };

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onImport) return;
    try {
      const text = await file.text();
      const rows = parseCSV(text);
      if (!rows.length) {
        toast.error("El archivo no contiene datos");
        return;
      }
      const result = await onImport(rows);
      toast.success(typeof result === "string" ? result : `${rows.length} filas importadas`);
    } catch (err: any) {
      toast.error(`Error importando: ${err?.message ?? "desconocido"}`);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" disabled={disabled}>
            <Download className="h-4 w-4 mr-1" />
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Plantilla</DropdownMenuLabel>
          <DropdownMenuItem onClick={handleDownloadTemplate}>
            <FileDown className="h-4 w-4 mr-2" />
            Descargar plantilla
          </DropdownMenuItem>
          {(onImport || onExport) && <DropdownMenuSeparator />}
          {onImport && (
            <DropdownMenuItem onClick={handlePickFile}>
              <FileUp className="h-4 w-4 mr-2" />
              Importar desde CSV
            </DropdownMenuItem>
          )}
          {onExport && (
            <DropdownMenuItem onClick={handleExport}>
              <Upload className="h-4 w-4 mr-2 rotate-180" />
              Exportar a CSV
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={handleFileChange}
      />
    </>
  );
}

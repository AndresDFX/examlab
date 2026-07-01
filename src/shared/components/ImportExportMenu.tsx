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
import { Download, Upload, FileDown, FileUp, FileSpreadsheet } from "lucide-react";
import { downloadCSV, parseCSV } from "@/shared/lib/csv";
import { toXLSX, downloadXLSX } from "@/shared/lib/xlsx";
import { toast } from "sonner";
import { friendlyError } from "@/shared/lib/db-errors";
import i18n from "@/i18n";

interface ImportExportMenuProps {
  /** Etiqueta del botón principal (ej: "Datos") */
  label?: string;
  /** data-tour-id opcional para anclaje del onboarding tour (ej. "bulk-import-users"). */
  tourId?: string;
  /** Nombre base para el archivo (ej: "asistencia"). Se usa también para template-{name}.csv */
  resourceName: string;
  /** Plantilla CSV ya formateada (con header + ejemplo). Opcional cuando
   *  el módulo NO soporta import (solo export) — en ese caso, la opción
   *  "Descargar plantilla" no se muestra. */
  templateCsv?: string;
  /** Genera el CSV de exportación bajo demanda. Devuelve string vacío si no hay datos. */
  onExport?: () => string | Promise<string>;
  /** Callback que recibe filas parseadas del CSV importado.
   *  Puede devolver:
   *   - un string no vacío → se muestra como toast.success.
   *   - `undefined` → se muestra toast.success genérico con el conteo.
   *   - `""` (string vacío) → no se muestra ningún toast (el handler ya tosteó por su cuenta, ej. con warning + detalles). */
  onImport?: (rows: Record<string, string>[]) => Promise<string | void>;
  disabled?: boolean;
}

export function ImportExportMenu({
  label = "Datos",
  tourId,
  resourceName,
  templateCsv,
  onExport,
  onImport,
  disabled,
}: ImportExportMenuProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleDownloadTemplate = () => {
    if (!templateCsv) return;
    downloadCSV(`template-${resourceName}.csv`, templateCsv);
    toast.success(i18n.t("toast.shared_components_ImportExportMenu.templateDownloaded", { defaultValue: "Plantilla descargada" }));
  };

  const handleExport = async () => {
    if (!onExport) return;
    try {
      const csv = await onExport();
      if (!csv || csv.trim() === "") {
        toast.info(i18n.t("toast.shared_components_ImportExportMenu.noDataToExport", { defaultValue: "No hay datos para exportar" }));
        return;
      }
      downloadCSV(`${resourceName}-${Date.now()}.csv`, csv);
      toast.success(i18n.t("toast.shared_components_ImportExportMenu.fileExportedSuccess", { defaultValue: "Archivo exportado correctamente" }));
    } catch (e: any) {
      toast.error(i18n.t("toast.shared_components_ImportExportMenu.exportError", { defaultValue: "Error exportando: {{detail}}", detail: friendlyError(e, "desconocido") }));
    }
  };

  // Export a Excel (.xlsx): reusamos el MISMO `onExport` (que devuelve CSV) y
  // lo convertimos a xlsx parseando el CSV de vuelta a filas. Así CUALQUIER
  // export basado en este menú obtiene Excel sin tocar el call-site. Los
  // valores quedan como texto (preserva ceros a la izquierda, documentos,
  // UUIDs) — Excel igual los ordena/filtra.
  const handleExportXlsx = async () => {
    if (!onExport) return;
    try {
      const csv = await onExport();
      if (!csv || csv.trim() === "") {
        toast.info(i18n.t("toast.shared_components_ImportExportMenu.noDataToExport", { defaultValue: "No hay datos para exportar" }));
        return;
      }
      const rows = parseCSV(csv);
      downloadXLSX(`${resourceName}-${Date.now()}.xlsx`, toXLSX(rows));
      toast.success(i18n.t("toast.shared_components_ImportExportMenu.fileExportedSuccess", { defaultValue: "Archivo exportado correctamente" }));
    } catch (e: any) {
      toast.error(i18n.t("toast.shared_components_ImportExportMenu.exportError", { defaultValue: "Error exportando: {{detail}}", detail: friendlyError(e, "desconocido") }));
    }
  };

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !onImport) return;
    try {
      // Detección de charset: `file.text()` SIEMPRE decodifica como UTF-8, pero
      // Excel en Windows (es-CO) guarda "CSV delimitado por comas" en
      // Windows-1252/Latin-1 → tildes y ñ salían como mojibake (Cárdenas →
      // "CÃ¡rdenas") en profiles/certificados/actas. Intentamos UTF-8 estricto;
      // si los bytes NO son UTF-8 válido, es un CSV Latin-1 de Excel → windows-1252.
      const buf = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder("windows-1252").decode(buf);
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM defensivo
      const rows = parseCSV(text);
      if (!rows.length) {
        toast.error(i18n.t("toast.shared_components_ImportExportMenu.fileNoData", { defaultValue: "El archivo no contiene datos" }));
        return;
      }
      const result = await onImport(rows);
      // String vacío = el handler ya tosteó por su cuenta (ej. warning con
      // detalles de duplicados). undefined = mostrar toast genérico.
      if (result === "") return;
      toast.success(typeof result === "string" ? result : `${rows.length} filas importadas`);
    } catch (err: any) {
      toast.error(i18n.t("toast.shared_components_ImportExportMenu.importError", { defaultValue: "Error importando: {{detail}}", detail: friendlyError(err, "desconocido") }));
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            {...(tourId ? { "data-tour-id": tourId } : {})}
          >
            <Download className="h-4 w-4 mr-1" />
            {label}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {templateCsv && (
            <>
              <DropdownMenuLabel>Plantilla</DropdownMenuLabel>
              <DropdownMenuItem onClick={handleDownloadTemplate}>
                <FileDown className="h-4 w-4 mr-2" />
                Descargar plantilla
              </DropdownMenuItem>
              {(onImport || onExport) && <DropdownMenuSeparator />}
            </>
          )}
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
          {onExport && (
            <DropdownMenuItem onClick={handleExportXlsx}>
              <FileSpreadsheet className="h-4 w-4 mr-2" />
              Exportar a Excel
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

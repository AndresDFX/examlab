/**
 * Armar el ENCABEZADO institucional del informe y verlo antes de insertarlo.
 *
 * Calco de `SignatureBlockDialog`: mismos props, misma previa en un iframe con el
 * contexto REAL del curso elegido en «Vista previa». Eso último es lo que hace que
 * el docente descubra ACÁ —y no en el papel ya impreso— que su institución todavía
 * no tiene el logo cargado: la previa muestra la celda vacía, no un logo de
 * ejemplo.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ImageIcon, Info } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cssCorteEnCeldas } from "./document-css";
import { institutionalHeaderHtml } from "./header-block";
import { buildSampleReportContext, renderTemplate, type TemplateContext } from "./template-engine";

export function HeaderBlockDialog({
  open,
  onOpenChange,
  onInsert,
  context,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onInsert: (html: string) => void;
  /** Contexto del curso elegido en «Vista previa». Sin él, datos de muestra. */
  context?: TemplateContext | null;
}) {
  const { t } = useTranslation();
  const [titulo, setTitulo] = useState("");
  const [subtitulo, setSubtitulo] = useState("");
  const [codigoFormato, setCodigoFormato] = useState("");
  const [version, setVersion] = useState("");
  const [mostrarNombre, setMostrarNombre] = useState(false);
  const [mostrarFecha, setMostrarFecha] = useState(false);
  const [anchoLogo, setAnchoLogo] = useState(150);

  const html = useMemo(
    () =>
      institutionalHeaderHtml({
        titulo,
        subtitulo,
        codigoFormato,
        version,
        mostrarNombre,
        mostrarFecha,
        anchoLogo,
      }),
    [titulo, subtitulo, codigoFormato, version, mostrarNombre, mostrarFecha, anchoLogo],
  );

  const ctx = context ?? buildSampleReportContext();
  /** ¿La institución del contexto tiene logo? Decide si se avisa. */
  const sinLogo = String((ctx.institucion as { logo?: unknown } | undefined)?.logo ?? "") === "";

  const preview = useMemo(
    () =>
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#111;margin:12px;font-size:12px}' +
      "table{border-collapse:collapse;width:100%}p{margin:2px 0}img{max-width:100%;height:auto}" +
      cssCorteEnCeldas() +
      "</style></head><body>" +
      renderTemplate(html, ctx) +
      "</body></html>",
    [html, ctx],
  );

  const campos: Array<{ id: string; label: string; hint: string; valor: string; set: (v: string) => void }> = [
    {
      id: "titulo",
      label: t("headerBlock.titulo", { defaultValue: "Título" }),
      hint: t("headerBlock.tituloHint", { defaultValue: "Va grande y centrado (ej. ACUERDO PEDAGÓGICO)." }),
      valor: titulo,
      set: setTitulo,
    },
    {
      id: "subtitulo",
      label: t("headerBlock.subtitulo", { defaultValue: "Subtítulo" }),
      hint: t("headerBlock.subtituloHint", { defaultValue: "Una línea chica bajo el título. Opcional." }),
      valor: subtitulo,
      set: setSubtitulo,
    },
    {
      id: "codigo",
      label: t("headerBlock.codigo", { defaultValue: "Código del formato" }),
      hint: t("headerBlock.codigoHint", { defaultValue: "Arriba a la derecha, como en los formatos institucionales (ej. DO-F-021)." }),
      valor: codigoFormato,
      set: setCodigoFormato,
    },
    {
      id: "version",
      label: t("headerBlock.version", { defaultValue: "Versión" }),
      hint: t("headerBlock.versionHint", { defaultValue: "Ej. V – 1.0 – 2019. Opcional." }),
      valor: version,
      set: setVersion,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            {t("headerBlock.dialogTitle", { defaultValue: "Encabezado institucional" })}
          </DialogTitle>
          <DialogDescription>
            {t("headerBlock.dialogDesc", {
              defaultValue:
                "El logo de tu institución a la izquierda, el título al centro y el código del formato a la derecha, como en los formatos que ya usás.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="space-y-3">
            {campos.map((c) => (
              <div key={c.id} className="space-y-1">
                <Label htmlFor={`hb-${c.id}`}>{c.label}</Label>
                <Input
                  id={`hb-${c.id}`}
                  value={c.valor}
                  onChange={(e) => c.set(e.target.value)}
                />
                <p className="text-2xs text-muted-foreground">{c.hint}</p>
              </div>
            ))}

            <div className="rounded-md border p-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="hb-nombre" className="font-normal">
                  {t("headerBlock.optNombre", { defaultValue: "Nombre de la institución bajo el logo" })}
                </Label>
                <Switch id="hb-nombre" checked={mostrarNombre} onCheckedChange={setMostrarNombre} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="hb-fecha" className="font-normal">
                  {t("headerBlock.optFecha", { defaultValue: "Fecha de emisión a la derecha" })}
                </Label>
                <Switch id="hb-fecha" checked={mostrarFecha} onCheckedChange={setMostrarFecha} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="hb-ancho">
                  {t("headerBlock.anchoLogo", { defaultValue: "Ancho del logo (px)" })}
                </Label>
                <Input
                  id="hb-ancho"
                  type="number"
                  min={40}
                  max={400}
                  value={anchoLogo}
                  onChange={(e) => setAnchoLogo(Number(e.target.value) || 150)}
                />
                <p className="text-2xs text-muted-foreground">
                  {t("headerBlock.anchoLogoHint", {
                    defaultValue: "El alto se calcula solo, con la proporción real de la imagen.",
                  })}
                </p>
              </div>
            </div>

            {sinLogo && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2.5">
                <Info className="h-4 w-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                <p className="text-2xs">
                  {t("headerBlock.sinLogo", {
                    defaultValue:
                      "Tu institución todavía no tiene logo cargado, así que esa celda va a salir vacía. Se sube en Configuración → Mi institución. El encabezado igual sirve: el logo aparece solo cuando esté.",
                  })}
                </p>
              </div>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-2xs text-muted-foreground">
              {context
                ? t("headerBlock.previewReal", {
                    defaultValue: "Con la marca del curso elegido en «Vista previa».",
                  })
                : t("headerBlock.previewSample", { defaultValue: "Con datos de muestra." })}
            </p>
            <iframe
              title={t("headerBlock.previewLabel", { defaultValue: "Cómo va a quedar" })}
              sandbox=""
              srcDoc={preview}
              className="w-full h-[32dvh] border rounded bg-white"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel", { defaultValue: "Cancelar" })}
          </Button>
          <Button
            onClick={() => {
              onInsert(html);
              onOpenChange(false);
            }}
          >
            <ImageIcon className="h-4 w-4 mr-1" />
            {t("headerBlock.insert", { defaultValue: "Insertar" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Caja de FIRMAS del editor de plantillas: se configura el bloque, se ve cómo
 * queda, y se inserta donde está el cursor.
 *
 * ── Por qué una caja y no el botón que había ──────────────────────────
 * `signatureTableHtml` acepta seis opciones (título, columnas de código y
 * documento, fila del docente, total de asistentes, vocero) y el editor no
 * exponía ninguna: el botón insertaba SIEMPRE la misma tabla con los valores por
 * defecto. Quien necesitaba el formato institucional completo —con el total y
 * las filas de vocero y teléfono, que el DO-F-021 pide— tenía que dibujar esas
 * filas a mano en el editor, que es justo el trabajo que el bloque existe para
 * evitar. Y quien tenía un curso con códigos sin llenar no podía cambiar esa
 * columna por la de documento sin editar HTML.
 *
 * ── La vista previa no es decorativa ──────────────────────────────────
 * Es donde se ve que una columna sale vacía. El bloque imprime `{{codigo}}` y
 * `{{documento}}` de cada matriculado, y en los cursos reales esos campos están
 * llenos a medias: si el docente no lo ve ANTES de insertar, lo descubre cuando
 * ya imprimió el acuerdo. Por eso la previa se renderiza con datos —de muestra,
 * o del curso elegido en "Vista previa" si hay uno— y no como HTML crudo.
 */
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { PenLine } from "lucide-react";
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
import { HelpHint } from "@/components/ui/help-hint";
import { cssCorteEnCeldas } from "./document-css";
import { signatureTableHtml, type OpcionesFirmas } from "./signature-block";
import { buildSampleReportContext, renderTemplate, type TemplateContext } from "./template-engine";

interface Props {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Inserta el HTML del bloque en el cuerpo, donde está el cursor. */
  onInsert: (html: string) => void;
  /**
   * Contexto real del curso elegido en "Vista previa", si hay uno. Con esto la
   * previa muestra los estudiantes DE VERDAD (y sus columnas vacías); sin él,
   * datos de muestra.
   */
  context?: TemplateContext | null;
}

export function SignatureBlockDialog({ open, onOpenChange, onInsert, context }: Props) {
  const { t } = useTranslation();
  const [titulo, setTitulo] = useState("Listado de estudiantes");
  const [incluirCodigo, setIncluirCodigo] = useState(true);
  const [incluirDocumento, setIncluirDocumento] = useState(false);
  const [incluirDocente, setIncluirDocente] = useState(true);
  const [incluirTotal, setIncluirTotal] = useState(false);
  const [incluirVocero, setIncluirVocero] = useState(false);

  const opciones: OpcionesFirmas = useMemo(
    () => ({
      titulo,
      incluirCodigo,
      incluirDocumento,
      incluirDocente,
      incluirTotal,
      incluirVocero,
    }),
    [titulo, incluirCodigo, incluirDocumento, incluirDocente, incluirTotal, incluirVocero],
  );
  const html = useMemo(() => signatureTableHtml(opciones), [opciones]);

  /** La previa se renderiza RESUELTA: el `{{codigo}}` en crudo no delata una columna vacía. */
  const preview = useMemo(() => {
    const ctx = context ?? buildSampleReportContext();
    const cuerpo = renderTemplate(html, ctx);
    return (
      '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'body{font-family:-apple-system,"Segoe UI",Roboto,sans-serif;color:#111;margin:12px;font-size:12px}' +
      "table{border-collapse:collapse;width:100%}p{margin:2px 0}" +
      // Misma regla que el resto de las superficies: un correo largo en una celda
      // angosta desborda el recuadro si no se le permite partir.
      cssCorteEnCeldas() +
      "</style></head><body>" +
      cuerpo +
      "</body></html>"
    );
  }, [html, context]);

  /**
   * Cuántos de los estudiantes de la previa tienen el campo lleno. Es el dato
   * que decide qué columna conviene, y contarlo a ojo en la previa de un curso
   * de 21 no es viable.
   */
  const cobertura = useMemo(() => {
    const lista = (context?.estudiantes ?? []) as Array<Record<string, unknown>>;
    if (lista.length === 0) return null;
    const lleno = (campo: string) =>
      lista.filter((e) => String(e[campo] ?? "").trim() !== "").length;
    return { total: lista.length, codigo: lleno("codigo"), documento: lleno("documento") };
  }, [context]);

  const filas: Array<{
    id: string;
    label: string;
    hint: string;
    valor: boolean;
    set: (v: boolean) => void;
    aviso?: string | null;
  }> = [
    {
      id: "codigo",
      label: t("hc_modulesReportsSignatureBlock.optCodigo", { defaultValue: "Columna Código" }),
      hint: t("hc_modulesReportsSignatureBlock.optCodigoHint", {
        defaultValue: "Código del estudiante, como está en su perfil.",
      }),
      valor: incluirCodigo,
      set: setIncluirCodigo,
      aviso:
        cobertura && incluirCodigo && cobertura.codigo < cobertura.total
          ? t("hc_modulesReportsSignatureBlock.coverageWarn", {
              defaultValue: "{{con}} de {{total}} lo tienen: el resto sale en blanco.",
              con: cobertura.codigo,
              total: cobertura.total,
            })
          : null,
    },
    {
      id: "documento",
      label: t("hc_modulesReportsSignatureBlock.optDocumento", {
        defaultValue: "Columna Documento",
      }),
      hint: t("hc_modulesReportsSignatureBlock.optDocumentoHint", {
        defaultValue: "Documento de identidad. Útil cuando el código está sin llenar.",
      }),
      valor: incluirDocumento,
      set: setIncluirDocumento,
      aviso:
        cobertura && incluirDocumento && cobertura.documento < cobertura.total
          ? t("hc_modulesReportsSignatureBlock.coverageWarn", {
              defaultValue: "{{con}} de {{total}} lo tienen: el resto sale en blanco.",
              con: cobertura.documento,
              total: cobertura.total,
            })
          : null,
    },
    {
      id: "total",
      label: t("hc_modulesReportsSignatureBlock.optTotal", {
        defaultValue: "Fila con el total",
      }),
      hint: t("hc_modulesReportsSignatureBlock.optTotalHint", {
        defaultValue:
          "Cuenta los matriculados, no quiénes asistieron: la plataforma no sabe quién estaba en el salón.",
      }),
      valor: incluirTotal,
      set: setIncluirTotal,
    },
    {
      id: "vocero",
      label: t("hc_modulesReportsSignatureBlock.optVocero", {
        defaultValue: "Filas de vocero y teléfono",
      }),
      hint: t("hc_modulesReportsSignatureBlock.optVoceroHint", {
        defaultValue: "Van en blanco: el vocero se elige en la reunión.",
      }),
      valor: incluirVocero,
      set: setIncluirVocero,
    },
    {
      id: "docente",
      label: t("hc_modulesReportsSignatureBlock.optDocente", {
        defaultValue: "Firma del docente y fecha",
      }),
      hint: t("hc_modulesReportsSignatureBlock.optDocenteHint", {
        defaultValue: "Recuadro aparte, debajo del listado.",
      }),
      valor: incluirDocente,
      set: setIncluirDocente,
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <PenLine className="h-4 w-4 text-primary" />
            {t("hc_modulesReportsSignatureBlock.title", { defaultValue: "Caja de firmas" })}
          </DialogTitle>
          <DialogDescription>
            {t("hc_modulesReportsSignatureBlock.desc", {
              defaultValue:
                "Una fila por estudiante matriculado, con la celda de firma en blanco para firmar sobre el papel. Se inserta donde tienes el cursor en el cuerpo.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>
                {t("hc_modulesReportsSignatureBlock.titleLabel", { defaultValue: "Título" })}
                <HelpHint>
                  {t("hc_modulesReportsSignatureBlock.titleHint", {
                    defaultValue: "Vacío ⇒ la tabla se inserta sin encabezado.",
                  })}
                </HelpHint>
              </Label>
              <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} className="h-8" />
            </div>

            {/* Cinco interruptores: bajo el umbral de 9 controles del design
                system, así que no hace falta agruparlos en secciones. */}
            <div className="rounded-md border p-3 space-y-3">
              {filas.map((f) => (
                <div key={f.id} className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Label htmlFor={`firmas-${f.id}`} className="text-xs">
                      {f.label}
                    </Label>
                    <p className="text-2xs text-muted-foreground">{f.hint}</p>
                    {f.aviso && (
                      <p className="text-2xs text-amber-600 dark:text-amber-400 mt-0.5">
                        {f.aviso}
                      </p>
                    )}
                  </div>
                  <Switch
                    id={`firmas-${f.id}`}
                    checked={f.valor}
                    onCheckedChange={f.set}
                    className="shrink-0 mt-0.5"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-1 min-w-0">
            <p className="text-xs font-medium">
              {t("hc_modulesReportsSignatureBlock.previewLabel", {
                defaultValue: "Cómo va a quedar",
              })}
            </p>
            <p className="text-2xs text-muted-foreground">
              {context
                ? t("hc_modulesReportsSignatureBlock.previewReal", {
                    defaultValue: "Con los estudiantes del curso elegido en «Vista previa».",
                  })
                : t("hc_modulesReportsSignatureBlock.previewSample", {
                    defaultValue:
                      "Con datos de muestra. Elige un curso en «Vista previa» para ver los estudiantes reales.",
                  })}
            </p>
            <iframe
              title={t("hc_modulesReportsSignatureBlock.previewLabel", {
                defaultValue: "Cómo va a quedar",
              })}
              sandbox=""
              srcDoc={preview}
              className="w-full h-[48dvh] border rounded bg-white"
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
            <PenLine className="h-4 w-4 mr-1" />
            {t("hc_modulesReportsSignatureBlock.insert", { defaultValue: "Insertar" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

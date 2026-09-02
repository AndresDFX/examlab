/**
 * Botón "Imprimir" de los resultados de una encuesta (rol Docente).
 *
 * ── Por qué un componente y no el botón repetido en cada diálogo ──────
 * Hay DOS diálogos de resultados —el de opciones (`single`/`multiple`/`slot`) y
 * el de encuestas mixtas con preguntas propias— y los dos necesitan imprimir. Un
 * botón copiado en cada uno derivaría en lo de siempre: se arregla el encabezado
 * en uno y el otro sigue saliendo sin logo.
 *
 * ── Por qué dos opciones y no un interruptor ──────────────────────────
 * La hoja impresa CIRCULA: se lleva a una reunión, se adjunta a un acta, queda
 * sobre un escritorio. En una encuesta de bienestar o de salud, los nombres al
 * lado de las respuestas abiertas son justo lo que no debería circular, y en una
 * de cupos los nombres son EL contenido (quién quedó en qué horario). No hay un
 * default correcto para las dos, así que el docente elige en el momento de
 * imprimir, con las dos opciones a la vista y nombrando lo que hace cada una.
 * Un interruptor "incluir nombres" recordado entre encuestas sería peor: se
 * imprime lo que quedó marcado la vez anterior.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { printReportHtml } from "@/modules/reports/report-download";
import { formatDateTime } from "@/shared/lib/format";
import { anonimizarDatos, buildPollResultsHtml, type DatosImpresion } from "./print-results";
import { usePrintBrand } from "./use-print-brand";

/** Lo que el diálogo aporta; la marca, los textos y la fecha las pone este componente. */
export type DatosParaImprimir = Omit<
  DatosImpresion,
  "marca" | "textos" | "generadoEl" | "conNombres"
>;

export function PrintPollResultsButton({
  datos,
  /** Si la encuesta no tiene nombres que mostrar, se ofrece una sola acción. */
  sinNombresDisponibles = false,
  disabled = false,
}: {
  datos: () => DatosParaImprimir;
  sinNombresDisponibles?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const marca = usePrintBrand();
  const [preparando, setPreparando] = useState(false);

  const imprimir = (conNombres: boolean) => {
    setPreparando(true);
    try {
      const pedido = datos();
      // En modo anónimo la identidad se BORRA acá, antes de armar el HTML: el
      // módulo de impresión no decide sobre privacidad, solo pinta lo que recibe.
      // Así el anonimato no depende de que el armador se acuerde. La limpieza es
      // `anonimizarDatos`, que está probada.
      const base = conNombres ? pedido : anonimizarDatos(pedido);
      const html = buildPollResultsHtml({
        ...base,
        marca,
        conNombres,
        generadoEl: formatDateTime(new Date()),
        textos: {
          tituloDoc: t("pollPrint.docTitle"),
          curso: t("pollPrint.course"),
          estado: t("pollPrint.status"),
          abierta: t("pollPrint.open"),
          cerrada: t("pollPrint.closed"),
          generado: t("pollPrint.generated"),
          respuesta: t("pollPrint.answer"),
          respuestas: t("pollPrint.answers"),
          sinRespuestas: t("pollPrint.noAnswers"),
          cupo: t("pollPrint.quota"),
          cupoLleno: t("pollPrint.quotaFull"),
          participante: t("pollPrint.participant"),
          participantes: t("pollPrint.participants"),
          preguntaAbierta: t("pollPrint.openQuestion"),
          sinNombresNota: t("pollPrint.withoutNamesNote"),
          conNombresNota: t("pollPrint.withNamesNote"),
          variasMarcasNota: t("pollPrint.multiNote"),
          faltanTitulo: t("pollPrint.faltanTitulo"),
          faltanResumen: t("pollPrint.faltanResumen"),
          faltanNadie: t("pollPrint.faltanNadie"),
        },
      });
      printReportHtml(html);
    } finally {
      // El diálogo de impresión es modal del navegador y bloquea el hilo; se
      // libera el spinner en el próximo tick para que no quede girando detrás.
      setTimeout(() => setPreparando(false), 800);
    }
  };

  const icono = preparando ? (
    <Spinner size="sm" className="mr-1" />
  ) : (
    <Printer className="h-4 w-4 mr-1" />
  );

  if (sinNombresDisponibles) {
    return (
      <Button
        variant="outline"
        size="sm"
        onClick={() => imprimir(false)}
        disabled={disabled || preparando}
      >
        {icono}
        {t("pollPrint.print")}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled || preparando}>
          {icono}
          {t("pollPrint.print")}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="text-2xs font-normal text-muted-foreground">
          {t("pollPrint.chooseHint")}
        </DropdownMenuLabel>
        {/* Sin íconos a propósito. Los candidatos ya significan otra cosa en
            esta app —`UserX` es "desactivar usuario" en Usuarios, `EyeOff` es
            "mostrar/ocultar un valor" en los campos de contraseña y secretos— y
            reusarlos acá le daría dos significados al mismo ícono, que es
            justamente lo que la regla de consistencia evita. "Con nombres" y
            "Sin nombres" no necesitan ayuda visual: dos palabras alcanzan. */}
        <DropdownMenuItem onClick={() => imprimir(true)}>
          {t("pollPrint.withNames")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => imprimir(false)}>
          {t("pollPrint.withoutNames")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

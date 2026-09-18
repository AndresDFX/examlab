/**
 * Las opciones de una pregunta de selección, con la correcta marcada, para las
 * listas de autoría del docente (taller, proyecto y examen).
 *
 * ── Por qué un componente y no el bloque copiado en cada lista ────────
 * Estaba solo en la lista de exámenes. La del taller y la del proyecto pintaban
 * tipo, puntos y enunciado, y nada más: el docente abría «Preguntas (10)», veía
 * «Selección única» sobre un enunciado y NO podía revisar las opciones ni cuál
 * quedó marcada como correcta sin entrar a editar pregunta por pregunta. Que es
 * exactamente lo que se reportó.
 *
 * La lectura de la clave de respuesta vive en `opciones-preview.ts`, que la toma
 * de los mismos normalizadores que usa el calificador. Acá solo se pinta.
 */
import { useTranslation } from "react-i18next";
import { AlertTriangle, Check } from "lucide-react";

import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { cn } from "@/shared/lib/utils";
import { previsualizarOpciones } from "./opciones-preview";

export function QuestionOptionsPreview({
  type,
  options,
  className,
}: Readonly<{
  type: string;
  options: unknown;
  className?: string;
}>) {
  const { t } = useTranslation();
  const preview = previsualizarOpciones(type, options);
  if (!preview) return null;

  const { opciones, multiple, sinClave, minSelecciones, maxSelecciones } = preview;

  const limites =
    minSelecciones != null && maxSelecciones != null
      ? t("questionOptions.minMax", { min: minSelecciones, max: maxSelecciones })
      : minSelecciones != null
        ? t("questionOptions.min", { min: minSelecciones })
        : maxSelecciones != null
          ? t("questionOptions.max", { max: maxSelecciones })
          : null;

  return (
    <div className={cn("mt-2 space-y-1", className)}>
      {multiple && (
        <p className="text-3xs text-muted-foreground">
          {t("questionOptions.selectMultiple")}
          {limites ? ` · ${limites}` : ""}
        </p>
      )}
      <ul className="space-y-0.5">
        {opciones.map((o) => (
          <li
            key={o.letra}
            className={cn(
              "flex items-start gap-1.5 text-xs",
              o.correcta ? "text-success font-medium" : "text-muted-foreground",
            )}
          >
            {/* El ícono ocupa lugar siempre: sin eso las opciones no arrancan a
                la misma altura y la lista se lee escalonada. */}
            <Check
              className={cn("h-3.5 w-3.5 shrink-0 mt-px", o.correcta ? "opacity-100" : "opacity-0")}
              aria-hidden
            />
            <span className="shrink-0 tabular-nums">{o.letra}.</span>
            {/* Las opciones traen código entre acentos graves con frecuencia
                (`dias.length`, `size()`); sin markdown se leen con los acentos
                a la vista, que es justo lo que el enunciado de al lado ya evita. */}
            {/* `div` y no `span`: MarkdownInline renderiza contenido de bloque,
                que dentro de un `span` es HTML inválido. */}
            <div className="min-w-0">
              <MarkdownInline>{o.texto}</MarkdownInline>
            </div>
            {o.correcta && <span className="sr-only">{t("questionOptions.correct")}</span>}
          </li>
        ))}
      </ul>
      {sinClave && (
        <p className="flex items-start gap-1.5 text-3xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" aria-hidden />
          <span>{t("questionOptions.noAnswerKey")}</span>
        </p>
      )}
    </div>
  );
}

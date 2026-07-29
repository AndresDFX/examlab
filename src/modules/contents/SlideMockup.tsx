/**
 * SlideMockup — render "tipo diapositiva" (mockup HTML/CSS 16:9) de una
 * `ParsedSlide`.
 *
 * Por qué existe como componente propio: el mismo mockup se usa en DOS
 * lugares y tiene que verse IGUAL en los dos —
 *   1. `PptxViewerDialog` (vista previa slide-by-slide del material de IA),
 *   2. `SlideAnnotationsDialog` (fondo de la capa de anotación: lo que el
 *      docente raya en clase).
 * Si divergen, el docente anota sobre un layout distinto al que ve/descarga.
 *
 * NO es un embed binario: el `.pptx` de la IA es texto estructurado y el
 * binario real se construye recién al descargar (`buildPptxBlob`). El
 * `className` lo controla el caller porque cada uso tiene su caja: el visor
 * usa `aspect-video w-full`; el escenario de anotación usa una caja de
 * tamaño CANÓNICO fijo (SLIDE_W x SLIDE_H) escalada por transform, para que
 * las coordenadas de las anotaciones no dependan del tamaño de pantalla.
 */
import { useTranslation } from "react-i18next";
import { stripInlineMarkdown, type ParsedSlide } from "@/modules/contents/contents-pptx";
import { cn } from "@/shared/lib/utils";

interface Props {
  slide: ParsedSlide;
  /** Índice 0-based dentro del deck (para el "N / total" del pie). */
  index: number;
  total: number;
  /** Clases de la CAJA exterior (tamaño/borde). El fondo blanco y el
   *  recorte los pone el componente. */
  className?: string;
}

export function SlideMockup({ slide, index, total, className }: Readonly<Props>) {
  const { t } = useTranslation();
  return (
    <div className={cn("bg-white text-slate-900 overflow-hidden", className)}>
      <div className="p-5 flex flex-col h-full">
        {slide.isCover ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
            <h2 className="text-2xl font-bold text-primary leading-tight">
              {stripInlineMarkdown(slide.title) || t("pptxViewer.cover")}
            </h2>
            {slide.bullets.filter(Boolean).length > 0 && (
              <p className="text-sm text-slate-600 max-w-md">
                {slide.bullets.map(stripInlineMarkdown).filter(Boolean).join(" · ")}
              </p>
            )}
          </div>
        ) : (
          <>
            <h3 className="text-lg font-bold text-primary border-b border-primary/30 pb-1.5 mb-2 leading-tight">
              {stripInlineMarkdown(slide.title) || t("pptxViewer.untitled")}
            </h3>
            <div className="flex-1 overflow-y-auto space-y-1.5 text-sm pr-1">
              {slide.bullets.filter(Boolean).length > 0 && (
                <ul className="list-disc pl-5 space-y-1">
                  {slide.bullets
                    .map(stripInlineMarkdown)
                    .filter((b) => b.trim().length > 0)
                    .map((b, bi) => (
                      <li key={bi}>{b}</li>
                    ))}
                </ul>
              )}
              {(slide.codeBlocks ?? []).map((cb, ci) => (
                <pre
                  key={ci}
                  className="rounded bg-slate-100 border border-slate-200 p-2 text-[10px] font-mono whitespace-pre overflow-x-auto text-slate-800"
                >
                  {cb.lang ? (
                    <div className="text-[9px] uppercase tracking-wide text-slate-500 mb-1">
                      {cb.lang}
                    </div>
                  ) : null}
                  <code>{cb.code}</code>
                </pre>
              ))}
              {slide.bullets.filter(Boolean).length === 0 &&
                (slide.codeBlocks?.length ?? 0) === 0 && (
                  <p className="text-xs text-slate-400 italic">{t("pptxViewer.noBullets")}</p>
                )}
            </div>
          </>
        )}
        <div className="text-[10px] text-slate-400 text-right mt-2 tabular-nums">
          {index + 1} / {total}
        </div>
      </div>
    </div>
  );
}

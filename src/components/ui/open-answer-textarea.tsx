/**
 * El `Textarea` de una respuesta ABIERTA, con su tope de caracteres y el
 * contador que avisa ANTES de chocarse contra él.
 *
 * ── Por qué es un componente ──────────────────────────────────────────
 * El tope existía solo en la pantalla de examen. El taller y el proyecto
 * pintaban un `Textarea` pelado, sin límite y sin contador, así que la misma
 * pregunta abierta se comportaba de tres formas distintas según dónde cayera —
 * y el estudiante descubría el muro justo en el examen, que es la peor
 * situación para enterarse. Acá vive una sola vez.
 *
 * ── El contador no es decoración ──────────────────────────────────────
 * Al llegar al `maxLength` el navegador ignora las teclas EN SILENCIO: sin un
 * contador a la vista, el estudiante cree que se le trabó el teclado. Por eso
 * el aviso ámbar arranca al 90% y el rojo al tope, con el texto que dice que
 * llegó al límite.
 */
import { useTranslation } from "react-i18next";

import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/shared/lib/utils";
import { useMaxOpenAnswerChars } from "@/hooks/use-max-open-answer-chars";

export function OpenAnswerTextarea({
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 4,
  max,
  disabled,
  className,
}: Readonly<{
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  /** Tope explícito. Sin esto lo resuelve del ajuste de la institución. */
  max?: number;
  disabled?: boolean;
  className?: string;
}>) {
  const { t } = useTranslation();
  const delAjuste = useMaxOpenAnswerChars();
  const tope = max ?? delAjuste;

  const len = value.length;
  const cerca = len >= Math.floor(tope * 0.9);
  const enTope = len >= tope;

  return (
    <div className={cn("space-y-1", className)}>
      <Textarea
        rows={rows}
        placeholder={placeholder}
        value={value}
        maxLength={tope}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      <div
        className={cn(
          "text-2xs text-right tabular-nums",
          enTope
            ? "text-destructive"
            : cerca
              ? "text-amber-600 dark:text-amber-400"
              : "text-muted-foreground",
        )}
      >
        {len.toLocaleString("es-CO")} / {tope.toLocaleString("es-CO")}
        {enTope ? ` · ${t("openAnswer.limitReached")}` : ""}
      </div>
    </div>
  );
}

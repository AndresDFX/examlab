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
import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { Textarea } from "@/components/ui/textarea";
import { CharacterBar } from "@/components/ui/character-bar";
import { insertarCaracter } from "@/modules/exams/caracteres-especiales";
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
  caracteresRapidos,
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
  /**
   * Caracteres que se pueden insertar con un toque (`ñ`, tildes, `¿`). Ver
   * `@/modules/exams/caracteres-especiales`: en un examen el portapapeles está
   * bloqueado, así que un teclado sin la tecla dejaba al alumno buscando el
   * carácter en otra ventana para copiarlo — justo lo que el proctoring le
   * marca como intento de trampa. Sin la prop, no se dibuja nada.
   */
  caracteresRapidos?: readonly string[];
}>) {
  const { t } = useTranslation();
  const areaRef = useRef<HTMLTextAreaElement>(null);
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
        ref={areaRef}
      />
      {caracteresRapidos && caracteresRapidos.length > 0 && !disabled ? (
        <CharacterBar
          characters={caracteresRapidos}
          label={t("codeEditor.quickChars")}
          onInsert={(ch) => {
            const el = areaRef.current;
            // Sin el elemento no se sabe dónde está el cursor; se agrega al
            // final, que es mejor que no hacer nada.
            const inicio = el?.selectionStart ?? value.length;
            const fin = el?.selectionEnd ?? inicio;
            const r = insertarCaracter(value, inicio, fin, ch);
            // El tope del campo también vale para lo que inserta la barra: si
            // no, se puede pasar del límite por un camino lateral.
            if (r.valor.length > tope) return;
            onChange(r.valor);
            // El `value` llega por props, así que el cursor hay que reponerlo
            // DESPUÉS del re-render o salta al final del texto.
            requestAnimationFrame(() => {
              const campo = areaRef.current;
              if (!campo) return;
              campo.focus();
              campo.setSelectionRange(r.cursor, r.cursor);
            });
          }}
        />
      ) : null}
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

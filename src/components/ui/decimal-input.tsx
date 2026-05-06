import { forwardRef, useEffect, useState, type KeyboardEvent } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * DecimalInput — input numérico que SIEMPRE muestra/acepta coma como
 * separador decimal a nivel de UI, mientras que la `value` lógica que
 * recibe el padre es un `number` con punto (lo que la DB y el JSON
 * esperan). Es un wrapper `<Input type="text" inputMode="decimal">`
 * porque `type="number"` nativo:
 *  - NO se puede forzar a coma en algunos browsers (depende del
 *    locale del SO; el usuario de es-CO ya escribe coma, pero el
 *    navegador en es-MX o en-US a veces fuerza punto)
 *  - permite caracteres como `e`, `+`, `-` que confunden la edición
 *  - el spinner deja escribir cosas raras
 *
 * Reglas que aplica:
 *  - Bloquea la tecla `.` (preventDefault en keyDown)
 *  - Si el usuario pega "4.5" (CSV, otro sitio), reemplaza punto por
 *    coma automáticamente — no rechaza el paste para no frustrar
 *  - Permite solo: dígitos + UNA coma + signo `-` opcional al inicio
 *  - Al hacer blur, normaliza visualmente ("4," → "4", "00,5" → "0,5")
 *
 * Mantenemos un estado de texto interno para no perder el estado
 * intermedio "4," mientras el usuario sigue tecleando — si solo
 * tuviéramos `value` numérica, "4," se parsearía a 4 y la UI volvería
 * a renderizar "4", borrando la coma justo cuando el usuario está
 * tecleando.
 */

interface DecimalInputProps {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** Si se da, se valida que value <= max. En blur se recorta al rango. */
  step?: number;
  /** Atributo aria para accesibilidad. */
  "aria-label"?: string;
}

/** Convierte un number lógico a la representación visual con coma. */
function toDisplay(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "";
  return String(value).replace(".", ",");
}

/** Convierte el texto visual (con coma) a un number lógico. */
function fromDisplay(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === ",") return null;
  const normalized = trimmed.replace(",", ".");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}

export const DecimalInput = forwardRef<HTMLInputElement, DecimalInputProps>(function DecimalInput(
  { value, onChange, min, max, placeholder, disabled, className, id, step, ...aria },
  ref,
) {
  const [text, setText] = useState<string>(() => toDisplay(value));

  // Sincroniza el texto cuando el value externo cambia desde fuera
  // (p. ej. el padre carga datos asincrónicos). Solo si el value
  // realmente cambió respecto al texto actual — sin esta guarda,
  // cada keystroke disparaba re-render del padre y el texto local
  // se sobrescribía borrando la coma a medio teclear.
  useEffect(() => {
    const parsed = fromDisplay(text);
    if (parsed !== value && !(parsed === null && value == null)) {
      setText(toDisplay(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Bloquea explícitamente el punto. El usuario debe usar coma.
    if (e.key === ".") {
      e.preventDefault();
      // Si quería un decimal, le inyectamos la coma — UX más amable
      // que solo bloquear sin más feedback.
      const target = e.currentTarget;
      const start = target.selectionStart ?? text.length;
      const end = target.selectionEnd ?? text.length;
      const next = text.slice(0, start) + "," + text.slice(end);
      // Solo si no hay ya una coma en el texto (regla "una sola coma")
      if (!text.includes(",")) {
        setText(next);
        const parsed = fromDisplay(next);
        onChange(parsed);
        // Reposiciona el cursor después de la coma insertada
        requestAnimationFrame(() => {
          target.setSelectionRange(start + 1, start + 1);
        });
      }
    }
    // Bloquea `e`/`E` (notación científica) y `+` que el browser permite
    // a veces incluso en text inputs si el inputMode es decimal.
    if (e.key === "e" || e.key === "E" || e.key === "+") {
      e.preventDefault();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value;
    // Normaliza punto pegado a coma (paste de un CSV, otra app, etc.).
    raw = raw.replace(/\./g, ",");
    // Permite solo: signo opcional al inicio, dígitos, UNA coma, dígitos.
    // Si entra basura, ignoramos el cambio (mantenemos texto previo).
    if (raw !== "" && !/^-?\d*,?\d*$/.test(raw)) return;
    // No permitir más de una coma (regex ya lo previene, doble check)
    if ((raw.match(/,/g) ?? []).length > 1) return;
    setText(raw);
    const parsed = fromDisplay(raw);
    onChange(parsed);
  };

  const handleBlur = () => {
    const parsed = fromDisplay(text);
    let final = parsed;
    if (final != null) {
      if (min != null && final < min) final = min;
      if (max != null && final > max) final = max;
    }
    setText(toDisplay(final));
    if (final !== parsed) onChange(final);
  };

  return (
    <Input
      ref={ref}
      type="text"
      inputMode="decimal"
      // Hint de teclado nativo en algunos navegadores móviles que
      // respetan el atributo `pattern` para mostrar el numérico
      // con coma. No es una validación dura — esa la hacemos en
      // handleChange / handleBlur.
      pattern="[0-9]*[,]?[0-9]*"
      id={id}
      value={text}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      placeholder={placeholder ?? "0,00"}
      disabled={disabled}
      className={cn("tabular-nums", className)}
      step={step}
      {...aria}
    />
  );
});

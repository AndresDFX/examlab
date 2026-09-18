/**
 * El tope de caracteres de una respuesta ABIERTA, leído de
 * `app_settings.max_open_answer_chars` (ajuste por institución).
 *
 * ── Por qué es un hook y no la lectura repetida en cada pantalla ──────
 * El tope estaba aplicado SOLO en la pantalla de examen. El taller y el
 * proyecto no lo miraban, así que sus `Textarea` iban sin límite: la misma
 * pregunta abierta se podía responder de tres formas distintas según dónde
 * cayera, y el estudiante solo descubría el muro en el examen, que es la
 * situación de mayor presión y la peor para enterarse.
 *
 * ── El default de 500 hacía daño medible ──────────────────────────────
 * Medido en producción: donde NO hay tope (talleres), la mediana de una
 * respuesta abierta es 459 caracteres, el percentil 90 es 1.095 y el máximo
 * histórico sobre 91 respuestas es 2.460 — nadie ha pasado nunca de 3.000. Con
 * el tope en 500 —y peor, una institución que lo tenía en 300— el estudiante
 * se choca contra el límite en una respuesta de cada dos. En un quiz real de
 * 11 entregas, 10 tocaron el tope en al menos una pregunta y una persona en 4
 * de sus 8: las respuestas quedaban cortadas a mitad de frase y así se
 * calificaban.
 *
 * `DEFAULT_MAX_OPEN_ANSWER_CHARS` es 5.000 porque duplica ese máximo histórico
 * —así que no trunca a nadie— y porque ya era el valor que 6 de las 7
 * instituciones habían elegido a mano: se vuelve el estándar, no un número
 * inventado. Sigue acotando el costo de tokens de la IA (5.000 caracteres son
 * ~1.250 tokens), que es la razón por la que el tope existe.
 */
import { useEffect, useState } from "react";

import { supabase } from "@/integrations/supabase/client";

/**
 * INVARIANTE: mismo valor que el `DEFAULT` de la columna
 * `app_settings.max_open_answer_chars` (mig 20262280000000). Es el que se usa
 * mientras la consulta viaja y si el ajuste no se puede leer — nunca deja al
 * estudiante con un límite más chico que el configurado.
 */
export const DEFAULT_MAX_OPEN_ANSWER_CHARS = 5000;

export function useMaxOpenAnswerChars(): number {
  // Constante determinista: NO leer nada del navegador en el initializer
  // (regla de hidratación React #418 del proyecto).
  const [max, setMax] = useState(DEFAULT_MAX_OPEN_ANSWER_CHARS);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await (
          supabase as unknown as {
            from: (t: string) => {
              select: (c: string) => {
                limit: (n: number) => { maybeSingle: () => Promise<{ data: unknown }> };
              };
            };
          }
        )
          .from("app_settings")
          .select("max_open_answer_chars")
          .limit(1)
          .maybeSingle();
        if (cancelled) return;
        const v = (data as { max_open_answer_chars?: number } | null)?.max_open_answer_chars;
        if (typeof v === "number" && v > 0) setMax(v);
      } catch {
        // Sin ajuste legible se queda el default. Bloquear la pantalla de
        // entrega por no poder leer un tope sería mucho peor que el tope.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return max;
}

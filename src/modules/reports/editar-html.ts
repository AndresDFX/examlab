/**
 * Editar a mano el HTML de un informe ya generado — reglas PURAS.
 *
 * `generated_reports` dejó de ser inmutable (mig 20262510000000) porque el
 * Acuerdo Pedagógico es un documento vivo: se corrige un nombre, se ajusta una
 * fecha. Pero "editable" no puede significar "cualquier cambio vale", y el
 * límite no es estético: dentro del HTML viven las RANURAS de firma, cada una
 * anclada al uid de una persona (`signature-slots.ts`). Si una ranura
 * desaparece, la firma que ya estaba puesta queda huérfana — existe en
 * `report_signatures` y no tiene dónde dibujarse, así que el documento pierde
 * una firma real sin decirlo. Es el mismo destrozo que evita el guard de la
 * mig 20262230000000, pero por la puerta del editor.
 *
 * Por eso el editor valida ANTES de guardar y no después: un borrado de
 * ranuras se rechaza entero. Quitar a alguien de un documento es otra
 * operación, con su propio flujo; no puede pasar como efecto colateral de
 * arreglar una tilde.
 */
import { uidsDeRanuras } from "./signature-slots";

/**
 * Las ranuras que estaban en el original y ya no están en lo editado.
 *
 * Vacío = el cambio es seguro. Se compara por uid y no por cantidad: cortar y
 * pegar una fila cambia el orden sin perder a nadie, y eso debe pasar.
 */
export function ranurasPerdidas(
  htmlOriginal: string | null | undefined,
  htmlEditado: string | null | undefined,
): string[] {
  const antes = uidsDeRanuras(htmlOriginal);
  const despues = new Set(uidsDeRanuras(htmlEditado));
  // `antes` ya viene sin repetidos desde `uidsDeRanuras`.
  return antes.filter((uid) => !despues.has(uid));
}

/** ¿El HTML editado conserva todas las ranuras del original? */
export function conservaLasRanuras(
  htmlOriginal: string | null | undefined,
  htmlEditado: string | null | undefined,
): boolean {
  return ranurasPerdidas(htmlOriginal, htmlEditado).length === 0;
}

/**
 * El documento a firmar, con la firma EN EL RENGLÓN de cada persona.
 *
 * Lo usan las dos vías por las que un estudiante llega a firmar —el enlace
 * público (`/acuerdo/$token`) y la pantalla dentro de la app— para que las dos se
 * vean y se comporten igual.
 *
 * ── Por qué `sandbox="allow-same-origin"` y no el sandbox vacío ────────
 * El documento se pinta en un iframe porque es HTML compuesto con sus propios
 * estilos: sin el iframe, un `<style>` del documento se derrama sobre la
 * aplicación. El sandbox VACÍO aísla tanto que el padre tampoco puede tocar el
 * contenido, y `allow-same-origin` es lo que permite LEER el documento (para
 * inyectar estilos, escanear texto) y llevar la vista al renglón de quien firma.
 *
 * Se agrega SOLO `allow-same-origin`: no le da ninguna capacidad nueva al
 * documento en sí — lo que haría peligroso el mismo origen son los SCRIPTS, y
 * `allow-scripts` sigue sin estar. `allow-forms` también sigue fuera.
 *
 * Los dos juntos —`allow-same-origin` y `allow-scripts`— sí anularían el sandbox.
 * No agregar `allow-scripts` acá.
 *
 * ── Por qué NO hay un botón "Firmar" dentro del documento ──────────────
 * Lo hubo. Emitía un `<button>` (HTML puro de `signature-slots.ts`, no un
 * componente de React) y el padre lo atrapaba con un listener por delegación
 * sobre `doc.addEventListener("click", …)`, apoyado en `allow-same-origin`.
 * Medido con WebKit (el motor de Safari): un iframe `sandbox` SIN
 * `allow-scripts` no entrega NINGÚN evento a esos listeners —ni `click` ni
 * `pointerdown` ni `touchstart`, con un tap real o uno sintético—, así que el
 * botón funcionaba en Chromium/Android y estaba MUERTO en cualquier iPhone.
 * Agregar `allow-scripts` anularía el sandbox (ver arriba), así que no hay
 * forma de arreglarlo sin sacarlo del iframe.
 *
 * Por eso hoy la ranura del renglón propio SOLO se resalta y dice "Tu firma va
 * aquí" (`marcaTuFirmaHtml` en `signature-slots.ts`) — no hay ningún elemento
 * pulsable dentro del iframe. El gesto de firmar (abrir el lienzo) lo dispara
 * un botón REAL de la pantalla que envuelve este componente — ver
 * `acuerdo.$token.tsx` y `app.student.signatures.tsx`, que ya lo tenían o lo
 * agregaron para esto.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { conEstilosDeDocumento } from "./document-css";
import { ATTR_UID, renderizarRanuras, type FirmaDeInforme } from "./signature-slots";

export function SignableDocument({
  html,
  firmas,
  /** Quién mira. Su ranura pendiente se resalta con "Tu firma va aquí". */
  firmanteId,
  /**
   * `null`/ausente ⇒ el documento es de solo lectura: la ranura propia, si
   * está pendiente, se deja en blanco sin resaltar. Con una función ⇒ se
   * resalta y marca "Tu firma va aquí" — pero esta función YA NO se invoca
   * desde acá (no hay nada pulsable dentro del iframe, ver la cabecera del
   * archivo). El caller sigue siendo quien la usa, en SU PROPIO botón externo.
   */
  onFirmar,
  className = "w-full h-[70dvh]",
  title,
}: {
  html: string;
  firmas?: readonly FirmaDeInforme[];
  firmanteId?: string | null;
  onFirmar?: (() => void) | null;
  className?: string;
  title: string;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLIFrameElement>(null);

  const htmlFinal = useMemo(
    () =>
      // El snapshot guardado no se toca (es lo que se firmó y sobre lo que se
      // calculó el hash): la regla de corte se inyecta al MOSTRARLO, igual que
      // las firmas se dibujan encima sin modificarlo.
      conEstilosDeDocumento(
        renderizarRanuras(html, {
          firmas,
          // Sin `onFirmar` no se resalta la ranura propia: es el caso de un
          // documento ya firmado o de una vista de lectura.
          firmanteId: onFirmar ? firmanteId : null,
          etiquetaFirmar: t("publicSignature.signHere", { defaultValue: "Tu firma va aquí" }),
          etiquetaPropia: t("publicSignature.yourSignature", { defaultValue: "◀ Tu firma" }),
        }),
      ),
    // `onFirmar` entra como booleano: lo que cambia el render es si HAY acción,
    // no la identidad de la función (que cambia en cada render del padre y
    // recargaría el iframe entero).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, firmas, firmanteId, !!onFirmar, t],
  );

  const alCargar = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    // Llevar la vista al renglón de quien firma. Es la diferencia entre "acá está
    // tu firma" y "buscá tu nombre en tres páginas". `block: center` y no `start`
    // para que se vea la fila anterior y la siguiente, y quede claro que la ranura
    // es la de su renglón y no la de otro.
    if (firmanteId) {
      doc
        .querySelector(`[${ATTR_UID}="${CSS.escape(firmanteId)}"]`)
        ?.scrollIntoView({ block: "center" });
    }
  }, [firmanteId]);

  // Si el documento ya estaba cargado cuando cambió el html (el caso de firmar:
  // el iframe se recarga con el nuevo srcDoc), `onLoad` vuelve a disparar solo.
  useEffect(() => {
    const iframe = ref.current;
    if (iframe?.contentDocument?.readyState === "complete") alCargar();
  }, [htmlFinal, alCargar]);

  return (
    <iframe
      ref={ref}
      title={title}
      srcDoc={htmlFinal}
      onLoad={alCargar}
      // Ver la cabecera: `allow-scripts` NO va acá.
      sandbox="allow-same-origin"
      className={className}
    />
  );
}

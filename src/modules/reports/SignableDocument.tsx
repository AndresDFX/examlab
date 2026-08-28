/**
 * El documento a firmar, con la firma EN EL RENGLÓN de cada persona.
 *
 * Lo usan las dos vías por las que un estudiante llega a firmar —el enlace
 * público (`/acuerdo/$token`) y la pantalla dentro de la app— para que las dos se
 * vean y se comporten igual. Antes cada una pintaba el documento por su cuenta y
 * el botón de firmar vivía al pie, después de tres páginas de acuerdo.
 *
 * ── Por qué `sandbox="allow-same-origin"` y no el sandbox vacío ────────
 * El documento se pinta en un iframe porque es HTML compuesto con sus propios
 * estilos: sin el iframe, un `<style>` del documento se derrama sobre la
 * aplicación. Hasta acá el sandbox estaba VACÍO, que aísla tanto que el padre
 * tampoco puede tocar el contenido — y sin eso un botón dentro del documento no es
 * clickeable de ninguna forma: no hay scripts adentro que avisen y no hay acceso
 * afuera para escuchar.
 *
 * Se agrega SOLO `allow-same-origin`, y eso no le da ninguna capacidad nueva al
 * documento: lo que haría peligroso el mismo origen son los scripts, y
 * `allow-scripts` sigue sin estar. Sin scripts el documento no puede leer nada del
 * padre; el permiso sirve para lo contrario, para que el padre pueda escuchar el
 * clic. `allow-forms` también sigue fuera.
 *
 * Los dos juntos —`allow-same-origin` y `allow-scripts`— sí anularían el sandbox.
 * No agregar `allow-scripts` acá.
 *
 * ── El clic se atrapa por delegación ──────────────────────────────────
 * El botón lo emite `signature-slots.ts` como HTML, no como un componente de
 * React, así que no tiene `onClick`. Se escucha UN clic en el documento del iframe
 * y se resuelve con `closest`. Es lo que permite que la firma viva dentro del
 * documento en vez de al lado.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ATTR_ACCION, ATTR_UID, renderizarRanuras, type FirmaDeInforme } from "./signature-slots";

export function SignableDocument({
  html,
  firmas,
  /** Quién mira. Su ranura pendiente se vuelve el botón de firmar. */
  firmanteId,
  /** Se llama al pulsar la ranura. `null` ⇒ el documento es solo de lectura. */
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
  // El handler se guarda en un ref para que el listener del iframe siempre llame
  // a la versión actual sin tener que re-adjuntarlo (re-adjuntar en cada render
  // recarga el documento y le mueve el scroll al estudiante).
  const alFirmar = useRef(onFirmar);
  alFirmar.current = onFirmar;

  const htmlFinal = useMemo(
    () =>
      renderizarRanuras(html, {
        firmas,
        // Sin `onFirmar` no se ofrece el botón: es el caso de un documento ya
        // firmado o de una vista de lectura.
        firmanteId: onFirmar ? firmanteId : null,
        etiquetaFirmar: t("publicSignature.signHere", { defaultValue: "Firmar aquí" }),
      }),
    // `onFirmar` entra como booleano: lo que cambia el render es si HAY acción,
    // no la identidad de la función (que cambia en cada render del padre y
    // recargaría el iframe entero).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, firmas, firmanteId, !!onFirmar, t],
  );

  const alCargar = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const onClick = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(`[${ATTR_ACCION}]`)) {
        e.preventDefault();
        alFirmar.current?.();
      }
    };
    doc.addEventListener("click", onClick);
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

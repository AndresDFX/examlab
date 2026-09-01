/**
 * DiagramPageEditor — hoja de DIAGRAMA de una pizarra
 * (`whiteboard_pages.page_type='diagram'`, mig 20262020000000).
 *
 * Reusa `DiagramEditor` TAL CUAL — el MISMO editor (motor mermaid, mismas
 * plantillas, mismo manejo del error de sintaxis) que la pregunta de tipo
 * `diagrama`. Eso es el punto de la hoja: el docente enseña frente al curso
 * con la sintaxis exacta con la que después va a evaluar, y no hay dos
 * editores de diagrama que se desincronicen. Mismo patrón con el que
 * `SqlPageEditor` envuelve a `SqlRunner`.
 *
 * Entonces, ¿para qué el envoltorio? Porque `DiagramEditor` está pensado para
 * vivir DENTRO de una pregunta, no para ocupar una hoja completa:
 *   - No acepta `className` y su raíz es `space-y-2` sin `h-full`, mientras el
 *     despacho del padre le pasa `w-full h-full` a todos los editores de hoja.
 *   - Tiene alto INTRÍNSECO (textarea `rows={12}` + la tira de plantillas + la
 *     vista previa), así que necesita su propio `overflow-y-auto` o el borde
 *     inferior queda inalcanzable — el mismo recorte que ya se pagó con xterm
 *     en la hoja de consola.
 *   - No tiene autoguardado: es controlado y emite `onChange` en CADA tecla.
 *
 * El padre (`MultiPageWhiteboard`) persiste vía `onPersist(patch)`, que escribe
 * en `whiteboard_pages` Y sincroniza su state (`persistCodePage`).
 *
 * Modo readOnly (alumno viendo una pizarra compartida ajena): `DiagramEditor`
 * entra en su pestaña de vista previa y muestra el diagrama RENDERIZADO, no su
 * código — mismo criterio que la hoja de texto, que en lectura muestra solo el
 * markdown ya renderizado. Las plantillas se ocultan solas y `schedulePatch`
 * corta antes de tocar la base.
 *
 * NOTA para el próximo tipo de hoja: este es el CUARTO archivo con el mismo
 * autoguardado (code 1200 ms, sql 1200 ms con acumulación por spread, text
 * 1500 ms). Cuando llegue la quinta hoja, el refactor correcto es extraer un
 * hook `usePageAutosave` y migrar las cuatro — no copiarlo una quinta vez.
 */
import { useEffect, useRef, useState } from "react";

import { DiagramEditor } from "@/modules/code/DiagramEditor";
import { cn } from "@/shared/lib/utils";

/** Ventana del debounce, alineada con las hojas de código y SQL. */
const DEBOUNCE_MS = 1200;

interface Props {
  pageId: string;
  /** Código del diagrama guardado en la fila (`diagram_source`). */
  diagramSource: string | null;
  readOnly?: boolean;
  /** El padre persiste el patch en `whiteboard_pages` + actualiza su state. */
  onPersist: (patch: Record<string, unknown>) => void;
  className?: string;
}

export function DiagramPageEditor({
  pageId,
  diagramSource,
  readOnly,
  onPersist,
  className,
}: Props) {
  // Estado LOCAL del código, no el valor de la fila: `DiagramEditor` es
  // controlado y emite por tecla, así que pasarle el valor persistido con
  // 1200 ms de retraso haría saltar el caret mientras se escribe.
  const [code, setCode] = useState<string>(diagramSource ?? "");

  // Debounce con FLUSH al desmontar — mismo patrón que SqlPageEditor (la
  // variante que acumula con spread, para que dos campos que cambian dentro de
  // la misma ventana no se pisen). El flush no es opcional: cada hoja re-monta
  // por `key={activePage.id}`, así que cambiar de hoja antes de que venza el
  // timer perdería el último cambio.
  const pendingRef = useRef<Record<string, unknown> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Espejo de la prop: el cleanup tiene deps `[]` y sin el espejo capturaría la
  // primera versión de `onPersist`, que apunta a la hoja que estaba activa al
  // montar.
  const onPersistRef = useRef(onPersist);
  useEffect(() => {
    onPersistRef.current = onPersist;
  }, [onPersist]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (pendingRef.current) onPersistRef.current(pendingRef.current);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const schedulePatch = (patch: Record<string, unknown>) => {
    if (readOnly) return;
    pendingRef.current = { ...pendingRef.current, ...patch };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      if (pendingRef.current) onPersistRef.current(pendingRef.current);
      pendingRef.current = null;
      saveTimer.current = null;
    }, DEBOUNCE_MS);
  };

  const onCodeChange = (next: string) => {
    setCode(next);
    schedulePatch({ diagram_source: next });
  };

  return (
    <div className={cn("flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-3", className)}>
      <DiagramEditor key={pageId} value={code} onChange={onCodeChange} readOnly={readOnly} />
    </div>
  );
}

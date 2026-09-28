/**
 * Lo que se ve mientras baja el editor de código.
 *
 * Reemplaza al literal `"Loading..."` que `@monaco-editor/react` pinta por
 * defecto, que tiene tres problemas a la vez: está sin traducir, no dice qué
 * está pasando y —el grave— **no se va nunca si la carga falla**. La librería
 * atrapa el error del loader y solo hace `console.error`, así que deja ese nodo
 * puesto para siempre (ver `use-monaco-listo.ts`).
 *
 * Sin borde a propósito: los editores ya envuelven a Monaco en una caja con
 * borde y este nodo se renderiza DENTRO de ella. Quien necesite el borde —la
 * pregunta de SQL, que no monta Monaco hasta tenerlo— lo pasa por `className`.
 */
import type { CSSProperties, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/shared/lib/utils";

export function EditorCargando({
  texto,
  className,
  style,
  children,
}: {
  /** Por defecto, «Cargando el editor de código…». */
  texto?: string;
  className?: string;
  /** Alto de runtime, para que la caja no cambie de tamaño al llegar el editor. */
  style?: CSSProperties;
  /** Salida alternativa, cuando la haya (la caja de texto de las preguntas SQL). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 p-4 text-center",
        className,
      )}
      style={style}
    >
      <Spinner size="md" />
      <p className="text-2xs text-muted-foreground">{texto ?? t("codeEditor.loadingEditor")}</p>
      {children}
    </div>
  );
}

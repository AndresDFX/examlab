import { Button } from "@/components/ui/button";
import { cn } from "@/shared/lib/utils";

/**
 * `CharacterBar` — fila de caracteres que se insertan con un toque.
 *
 * Existe para el teclado que no tiene la tecla: uno en inglés no trae `ñ` ni
 * tildes, y uno con una tecla rota se queda sin `;`. Como el examen bloquea el
 * portapapeles, ese alumno terminaba buscando el carácter en otra ventana para
 * copiarlo — justo lo que el proctoring le marca como intento de trampa.
 *
 * **Inserta por código, nunca por portapapeles**: el caller recibe el carácter
 * y lo escribe en el campo, así que no se disparan `copy`/`paste`/`cut` ni
 * queda ninguna señal de proctoring. Y como solo puede insertar los caracteres
 * que recibe, no sirve para traer texto de ningún otro lado.
 *
 * Los botones son `type="button"`: dentro de un `<form>`, el default es
 * `submit` y tocar una `ñ` entregaría el examen.
 */
interface CharacterBarProps {
  /** Qué caracteres ofrecer. Ver `caracteresParaTipo`. */
  characters: readonly string[];
  onInsert: (character: string) => void;
  /** Rótulo corto a la izquierda. Se oculta en pantallas angostas. */
  label?: string;
  disabled?: boolean;
  className?: string;
}

export function CharacterBar({
  characters,
  onInsert,
  label,
  disabled,
  className,
}: CharacterBarProps) {
  if (characters.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-1", className)}>
      {label ? (
        <span className="hidden sm:inline text-2xs text-muted-foreground mr-0.5">{label}</span>
      ) : null}
      {characters.map((ch) => (
        <Button
          key={ch}
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          // `h-8 w-8` = 32 px, el piso táctil del proyecto. Un carácter suelto
          // en un botón del tamaño de un Badge es intocable en un teléfono, que
          // es justo donde más falta hace.
          className="h-8 w-8 p-0 font-mono text-sm"
          // `onMouseDown` con `preventDefault` conserva el foco y la posición
          // del cursor en el campo: sin esto, el clic se lleva el foco y el
          // carácter aterriza al final del texto en vez de donde estaba
          // escribiendo.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onInsert(ch)}
          aria-label={ch}
          title={ch}
        >
          {ch}
        </Button>
      ))}
    </div>
  );
}

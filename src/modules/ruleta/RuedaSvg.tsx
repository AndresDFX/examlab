import {
  colorDeGajo,
  etiquetaCorta,
  gajosConNombre,
  tamanoDeLetra,
  type Participante,
} from "./ruleta";

interface Props {
  participantes: readonly Participante[];
  /** Grados en sentido horario. Crece en cada giro. */
  rotacion: number;
  /** Duración del giro en curso; 0 = sin animación (al reacomodar gajos). */
  duracionMs: number;
  ariaLabel: string;
  onClick?: () => void;
  deshabilitada?: boolean;
  className?: string;
}

const C = 200; // centro del dibujo (viewBox 400 × 400)
const R = 190; // radio de la rueda

/** Punto del borde a `grados` desde las 12, en sentido horario. */
function punto(grados: number, radio = R): [number, number] {
  const a = (grados * Math.PI) / 180;
  return [C + radio * Math.sin(a), C - radio * Math.cos(a)];
}

/**
 * La rueda: gajos con su nombre, un puntero fijo arriba y el giro por CSS. El
 * cálculo de dónde se detiene NO vive acá (ver `rotacionParaCaerEn`): este
 * componente solo dibuja la rotación que le dan.
 */
export function RuedaSvg({
  participantes,
  rotacion,
  duracionMs,
  ariaLabel,
  onClick,
  deshabilitada,
  className,
}: Props) {
  const n = participantes.length;
  const s = n > 0 ? 360 / n : 360;
  const letra = tamanoDeLetra(n);

  return (
    <div className={`relative aspect-square w-full ${className ?? ""}`}>
      {/* Puntero fijo, afuera de lo que gira. */}
      <svg
        viewBox="0 0 40 30"
        className="pointer-events-none absolute left-1/2 top-0 z-10 h-8 w-10 -translate-x-1/2 -translate-y-1 drop-shadow"
        aria-hidden
      >
        <path d="M2 2 H38 L20 28 Z" className="fill-foreground stroke-background" strokeWidth={2} />
      </svg>
      <button
        type="button"
        onClick={onClick}
        disabled={deshabilitada || n === 0}
        aria-label={ariaLabel}
        className="block h-full w-full rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-default enabled:cursor-pointer"
      >
        {/* `pointer-events-none`: girado, el cuadrado del dibujo saca sus esquinas
            (transparentes) del círculo y taparía los botones de abajo. El clic lo
            recibe el botón, que no gira. */}
        <svg
          viewBox="0 0 400 400"
          className="pointer-events-none h-full w-full"
          // Transformación que cambia en cada giro: valor de ejecución, no de diseño.
          style={{
            transform: `rotate(${rotacion}deg)`,
            transition:
              duracionMs > 0 ? `transform ${duracionMs}ms cubic-bezier(0.12, 0.8, 0.2, 1)` : "none",
          }}
          aria-hidden
        >
          <circle cx={C} cy={C} r={R + 6} className="fill-muted stroke-border" strokeWidth={2} />
          {n === 0 && <circle cx={C} cy={C} r={R} className="fill-muted" />}
          {n === 1 && <circle cx={C} cy={C} r={R} fill={colorDeGajo(0, 1).fondo} />}
          {n > 1 &&
            participantes.map((p, i) => {
              const [x0, y0] = punto(i * s);
              const [x1, y1] = punto((i + 1) * s);
              const grande = s > 180 ? 1 : 0;
              return (
                <path
                  key={p.id}
                  d={`M${C},${C} L${x0},${y0} A${R},${R} 0 ${grande} 1 ${x1},${y1} Z`}
                  fill={colorDeGajo(i, n).fondo}
                  className="stroke-background"
                  strokeWidth={n > 60 ? 0.5 : 1.5}
                />
              );
            })}
          {/* Con muchos gajos el nombre no se lee: va solo en el resultado. */}
          {gajosConNombre(n) && participantes.map((p, i) => {
            const medio = i * s + s / 2;
            return (
              <text
                key={`t-${p.id}`}
                x={R - 14}
                y={0}
                transform={`translate(${C} ${C}) rotate(${medio - 90})`}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize={letra}
                fontWeight={600}
                fill={colorDeGajo(i, n).texto}
              >
                {etiquetaCorta(p.etiqueta, n)}
              </text>
            );
          })}
          <circle cx={C} cy={C} r={30} className="fill-background stroke-border" strokeWidth={2} />
          <circle cx={C} cy={C} r={20} className="fill-primary" />
        </svg>
      </button>
    </div>
  );
}

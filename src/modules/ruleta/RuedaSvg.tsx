import { useId, useLayoutEffect, type RefObject } from "react";

import { cn } from "@/shared/lib/utils";
import {
  colorDeGajo,
  etiquetaCorta,
  gajosConNombre,
  tamanoDeLetra,
  type Participante,
} from "./ruleta";

interface Props {
  participantes: readonly Participante[];
  /** Posición de la rueda quieta, en grados (sentido horario). Crece en cada giro. */
  rotacion: number;
  /**
   * Mientras gira, la mueve cuadro a cuadro quien anima (por `ruedaRef`) y este
   * componente no la toca: si la reescribiera en un render, la rueda saltaría.
   */
  animando: boolean;
  ruedaRef: RefObject<SVGSVGElement | null>;
  /** El puntero, para que quien anima lo haga rebotar con cada gajo. */
  punteroRef: RefObject<SVGSVGElement | null>;
  /** Índice del elegido en `participantes`: se resalta y el resto se apaga. */
  ganador?: number | null;
  ariaLabel: string;
  onClick?: () => void;
  deshabilitada?: boolean;
  className?: string;
}

const C = 200; // centro del dibujo (viewBox 400 × 400)
const R = 190; // radio de la rueda
/** Hasta cuántos gajos se dibujan las clavijas del borde (las que hacen «clac»). */
const MAX_GAJOS_CON_CLAVIJAS = 60;
/** Cuánto sale el gajo elegido hacia afuera, en unidades del dibujo. */
const SALIDA_GANADOR = 7;

/** Punto del borde a `grados` desde las 12, en sentido horario. */
function punto(grados: number, radio = R): [number, number] {
  const a = (grados * Math.PI) / 180;
  return [C + radio * Math.sin(a), C - radio * Math.cos(a)];
}

/**
 * La rueda: gajos con su nombre, clavijas en el borde, un puntero fijo arriba.
 * El cálculo de dónde se detiene NO vive acá (ver `rotacionParaCaerEn`) ni el
 * movimiento (ver `animacion-giro.ts`): este componente dibuja y resalta.
 */
export function RuedaSvg({
  participantes,
  rotacion,
  animando,
  ruedaRef,
  punteroRef,
  ganador,
  ariaLabel,
  onClick,
  deshabilitada,
  className,
}: Props) {
  // `useId` puede traer caracteres que no sirven dentro de `url(#…)`.
  const filtroId = `brillo-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const n = participantes.length;
  const s = n > 0 ? 360 / n : 360;
  const letra = tamanoDeLetra(n);
  const resaltar = ganador != null && ganador >= 0 && ganador < n && n > 1;

  // La posición de reposo se aplica a mano (y no como estilo de React) para que
  // un render durante el giro no la pise.
  useLayoutEffect(() => {
    if (!animando && ruedaRef.current) ruedaRef.current.style.transform = `rotate(${rotacion}deg)`;
  }, [rotacion, animando, ruedaRef, n]);

  const gajo = (i: number) => {
    const [x0, y0] = punto(i * s);
    const [x1, y1] = punto((i + 1) * s);
    const grande = s > 180 ? 1 : 0;
    return `M${C},${C} L${x0},${y0} A${R},${R} 0 ${grande} 1 ${x1},${y1} Z`;
  };
  /** Hacia afuera, por la mitad del gajo: así «sale» el elegido. */
  const salida = (i: number): [number, number] => {
    const medio = ((i + 0.5) * s * Math.PI) / 180;
    return [SALIDA_GANADOR * Math.sin(medio), -SALIDA_GANADOR * Math.cos(medio)];
  };
  // El elegido se dibuja al final para que su borde y su brillo queden encima.
  const orden = participantes.map((_, i) => i).filter((i) => !(resaltar && i === ganador));
  if (resaltar && ganador != null) orden.push(ganador);
  const colorGanador = resaltar && ganador != null ? colorDeGajo(ganador, n).fondo : "transparent";

  return (
    <div className={`relative aspect-square w-full ${className ?? ""}`}>
      {/* Puntero fijo, afuera de lo que gira. Pivota en su base: con cada gajo
          que pasa, quien anima lo tuerce y vuelve solo. */}
      <svg
        ref={punteroRef}
        viewBox="0 0 40 30"
        className="pointer-events-none absolute left-1/2 top-0 z-10 h-8 w-10 origin-top -translate-x-1/2 -translate-y-1 drop-shadow"
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
        <svg ref={ruedaRef} viewBox="0 0 400 400" className="pointer-events-none h-full w-full" aria-hidden>
          <defs>
            <filter id={filtroId} x="-30%" y="-30%" width="160%" height="160%">
              <feDropShadow dx="0" dy="0" stdDeviation="6" floodColor={colorGanador} floodOpacity="0.95" />
            </filter>
          </defs>
          <circle cx={C} cy={C} r={R + 6} className="fill-muted stroke-border" strokeWidth={2} />
          {n === 0 && <circle cx={C} cy={C} r={R} className="fill-muted" />}
          {n === 1 && <circle cx={C} cy={C} r={R} fill={colorDeGajo(0, 1).fondo} />}
          {n > 1 &&
            orden.map((i) => {
              const esGanador = resaltar && i === ganador;
              const [dx, dy] = esGanador ? salida(i) : [0, 0];
              return (
                <path
                  key={participantes[i].id}
                  d={gajo(i)}
                  fill={colorDeGajo(i, n).fondo}
                  className={cn(
                    "transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none",
                    esGanador ? "stroke-foreground" : "stroke-background",
                    resaltar && !esGanador && "opacity-35",
                  )}
                  strokeWidth={esGanador ? 3 : n > 60 ? 0.5 : 1.5}
                  filter={esGanador ? `url(#${filtroId})` : undefined}
                  // Desplazamiento calculado del gajo elegido: valor de ejecución.
                  style={{ transform: `translate(${dx}px, ${dy}px)` }}
                />
              );
            })}
          {/* Con muchos gajos el nombre no se lee: va solo en el resultado. */}
          {gajosConNombre(n) &&
            participantes.map((p, i) => {
              const medio = i * s + s / 2;
              const esGanador = resaltar && i === ganador;
              const [dx, dy] = esGanador ? salida(i) : [0, 0];
              // El grupo sale con su gajo (misma transición); el texto solo rota.
              return (
                <g
                  key={`t-${p.id}`}
                  className={cn(
                    "transition-[opacity,transform] duration-500 ease-out motion-reduce:transition-none",
                    resaltar && !esGanador && "opacity-35",
                  )}
                  style={{ transform: `translate(${dx}px, ${dy}px)` }}
                >
                  <text
                    x={R - 14}
                    y={0}
                    transform={`translate(${C} ${C}) rotate(${medio - 90})`}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fontSize={letra}
                    fontWeight={esGanador ? 800 : 600}
                    fill={colorDeGajo(i, n).texto}
                  >
                    {etiquetaCorta(p.etiqueta, n)}
                  </text>
                </g>
              );
            })}
          {/* Las clavijas del borde: lo que golpea el puntero en cada gajo. */}
          {n > 1 &&
            n <= MAX_GAJOS_CON_CLAVIJAS &&
            participantes.map((p, i) => {
              const [x, y] = punto(i * s, R + 1);
              return (
                <circle
                  key={`c-${p.id}`}
                  cx={x}
                  cy={y}
                  r={n > 30 ? 2.5 : 3.5}
                  className="fill-background stroke-border"
                  strokeWidth={1}
                />
              );
            })}
          <circle cx={C} cy={C} r={30} className="fill-background stroke-border" strokeWidth={2} />
          <circle cx={C} cy={C} r={20} className="fill-primary" />
        </svg>
      </button>
    </div>
  );
}

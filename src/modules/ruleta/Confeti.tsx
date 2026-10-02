import { useEffect, useRef } from "react";

import { PALETA } from "./ruleta";

interface Pieza {
  x: number;
  y: number;
  vx: number;
  vy: number;
  giro: number;
  velocidadGiro: number;
  ancho: number;
  alto: number;
  color: string;
}

const DURACION_MS = 2200;
const PIEZAS = 130;
/** Gravedad y roce, en px/s² y por segundo: el papel cae lento y se frena. */
const GRAVEDAD = 900;
const ROCE = 1.6;

/**
 * Lluvia de papelitos cuando la ruleta elige. Cada vez que `disparo` cambia
 * (y es > 0) sale una ráfaga desde el puntero. Se dibuja en un lienzo que no
 * recibe clics, así que no tapa los botones de abajo.
 *
 * Con `activo` en falso (sin animación o «reducir movimiento») no dispara: es
 * puro adorno, y es justamente lo que esa preferencia pide quitar.
 */
export function Confeti({ disparo, activo }: { disparo: number; activo: boolean }) {
  const lienzo = useRef<HTMLCanvasElement | null>(null);
  // El valor con el que se montó NO dispara: al reabrir la ruleta después de un
  // giro, el contador ya es mayor que cero y no hay nada que festejar.
  const alMontar = useRef(disparo);

  useEffect(() => {
    if (!disparo || !activo || disparo === alMontar.current) return;
    const canvas = lienzo.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === 0 || height === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Salen de debajo del puntero, abriéndose hacia los costados.
    const origenX = width / 2;
    const origenY = Math.min(height * 0.12, 60);
    const piezas: Pieza[] = Array.from({ length: PIEZAS }, (_, i) => {
      const angulo = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.6;
      const rapidez = 380 + Math.random() * 620;
      return {
        x: origenX,
        y: origenY,
        vx: Math.cos(angulo) * rapidez,
        vy: Math.sin(angulo) * rapidez,
        giro: Math.random() * Math.PI,
        velocidadGiro: (Math.random() - 0.5) * 14,
        ancho: 6 + Math.random() * 5,
        alto: 9 + Math.random() * 7,
        color: PALETA[i % PALETA.length].fondo,
      };
    });

    let cuadro = 0;
    const inicio = performance.now();
    let anterior = inicio;
    const paso = (ahora: number) => {
      const dt = Math.min(0.05, (ahora - anterior) / 1000);
      anterior = ahora;
      const transcurrido = ahora - inicio;
      ctx.clearRect(0, 0, width, height);
      // Se desvanece en el último tercio.
      ctx.globalAlpha = Math.min(1, Math.max(0, (DURACION_MS - transcurrido) / (DURACION_MS / 3)));
      for (const p of piezas) {
        p.vx -= p.vx * ROCE * dt;
        p.vy += GRAVEDAD * dt - p.vy * ROCE * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.giro += p.velocidadGiro * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.giro);
        // El ancho «respira» con el giro: es lo que hace que el papel parezca girar en 3D.
        ctx.scale(Math.cos(p.giro * 1.7), 1);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.ancho / 2, -p.alto / 2, p.ancho, p.alto);
        ctx.restore();
      }
      if (transcurrido < DURACION_MS) cuadro = requestAnimationFrame(paso);
      else ctx.clearRect(0, 0, width, height);
    };
    cuadro = requestAnimationFrame(paso);
    return () => {
      cancelAnimationFrame(cuadro);
      ctx.clearRect(0, 0, width, height);
    };
  }, [disparo, activo]);

  return (
    <canvas
      ref={lienzo}
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 h-full w-full"
    />
  );
}

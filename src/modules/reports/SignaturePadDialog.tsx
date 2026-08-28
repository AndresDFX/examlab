/**
 * Lienzo para TRAZAR la firma.
 *
 * Se abre al pulsar la ranura del propio renglón en el documento. Ese es el orden
 * que importa: primero el estudiante ve dónde va a quedar su firma, después la
 * dibuja. Al revés —dibujar primero y después buscar dónde cayó— es lo que hacía
 * que el botón al pie del documento se sintiera desconectado.
 *
 * ── Puntero y no ratón ni tacto ────────────────────────────────────────
 * Los eventos de puntero cubren ratón, dedo y lápiz con un solo camino, y
 * `setPointerCapture` mantiene el trazo aunque el dedo se salga del lienzo — sin
 * eso, salirse un milímetro corta la firma en dos.
 *
 * ── El lienzo se dimensiona en píxeles del dispositivo ─────────────────
 * Si el `<canvas>` se deja en el tamaño CSS, en un teléfono con densidad 3 el
 * trazo sale pixelado. El buffer se crea multiplicado por `devicePixelRatio` y el
 * contexto se escala, así que las coordenadas siguen siendo las de la pantalla.
 *
 * ── Se recorta a la tinta antes de exportar ────────────────────────────
 * El lienzo es ancho y una firma ocupa una parte; sin recortar, el PNG llega a la
 * celda del documento con transparencia alrededor y el navegador escala la imagen
 * completa, así que el trazo se ve diminuto. La aritmética del recorte vive en
 * `signature-pad.ts`, con tests.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Eraser, PenLine } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cajaDelTrazo, conMargen, trazoDemasiadoChico } from "./signature-pad";

/** Tamaño lógico del lienzo. Proporción parecida a un renglón de firma. */
const ANCHO = 600;
const ALTO = 200;
const MARGEN_RECORTE = 8;

export function SignaturePadDialog({
  open,
  onOpenChange,
  /** Recibe el PNG en data URL, o `null` si se firmó sin trazo. */
  onConfirmar,
  firmando = false,
  /** Nombre de quien firma, para que el diálogo diga de quién es la firma. */
  nombre,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirmar: (dibujo: string | null) => void;
  firmando?: boolean;
  nombre?: string | null;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLCanvasElement>(null);
  const dibujando = useRef(false);
  const [hayTrazo, setHayTrazo] = useState(false);

  const ctx = () => ref.current?.getContext("2d") ?? null;

  const preparar = useCallback(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    c.width = ANCHO * dpr;
    c.height = ALTO * dpr;
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, ANCHO, ALTO);
    g.lineWidth = 2.4;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.strokeStyle = "#111827";
  }, []);

  // Se prepara al ABRIR y no al montar: el diálogo monta su contenido recién
  // cuando se abre, y un lienzo dimensionado antes queda en 0×0.
  useEffect(() => {
    if (!open) return;
    setHayTrazo(false);
    // Un frame de espera para que el diálogo ya tenga layout.
    const id = requestAnimationFrame(preparar);
    return () => cancelAnimationFrame(id);
  }, [open, preparar]);

  const puntoDe = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = ref.current;
    if (!c) return { x: 0, y: 0 };
    const r = c.getBoundingClientRect();
    // Se pasa de píxeles de pantalla a coordenadas lógicas del lienzo: el elemento
    // se estira con CSS (`w-full`) y sin esta regla el trazo va corrido.
    return {
      x: ((e.clientX - r.left) / r.width) * ANCHO,
      y: ((e.clientY - r.top) / r.height) * ALTO,
    };
  };

  const abajo = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = ctx();
    if (!g) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dibujando.current = true;
    const p = puntoDe(e);
    g.beginPath();
    g.moveTo(p.x, p.y);
    // Un punto solo también deja marca: sin esto, tocar y levantar no dibuja nada
    // y parece que el lienzo no responde.
    g.lineTo(p.x + 0.01, p.y);
    g.stroke();
    setHayTrazo(true);
  };

  const mover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dibujando.current) return;
    const g = ctx();
    if (!g) return;
    const p = puntoDe(e);
    g.lineTo(p.x, p.y);
    g.stroke();
  };

  const arriba = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dibujando.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* el puntero ya se soltó */
    }
  };

  const limpiar = () => {
    preparar();
    setHayTrazo(false);
  };

  /** Recorta a la tinta y exporta. `null` si no hay trazo utilizable. */
  const exportar = (): string | null => {
    const c = ref.current;
    const g = ctx();
    if (!c || !g) return null;
    const dpr = c.width / ANCHO;
    const img = g.getImageData(0, 0, c.width, c.height);
    const caja = cajaDelTrazo(img.data, c.width, c.height);
    if (trazoDemasiadoChico(caja, 12 * dpr)) return null;
    const rec = conMargen(caja!, MARGEN_RECORTE * dpr, c.width, c.height);

    const salida = document.createElement("canvas");
    salida.width = rec.w;
    salida.height = rec.h;
    const gs = salida.getContext("2d");
    if (!gs) return null;
    gs.drawImage(c, rec.x, rec.y, rec.w, rec.h, 0, 0, rec.w, rec.h);
    return salida.toDataURL("image/png");
  };

  /**
   * Firmar CON trazo.
   *
   * `hayTrazo` se enciende con el primer contacto, así que un toque suelto lo pone
   * en true pero deja una mancha de 2×2 que `exportar()` descarta. Sin este aviso,
   * ese caso firmaba EN SILENCIO sin trazo: la persona creía haber firmado con su
   * puño y en el documento aparecía su nombre tipeado. Mejor decirlo y no firmar.
   */
  const confirmarConTrazo = () => {
    const dibujo = exportar();
    if (!dibujo) {
      toast.error(t("signaturePad.tooSmall"));
      return;
    }
    onConfirmar(dibujo);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !firmando && onOpenChange(o)}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("signaturePad.title")}</DialogTitle>
          <DialogDescription>
            {nombre ? t("signaturePad.descWithName", { name: nombre }) : t("signaturePad.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          {/* `touch-none` es obligatorio: sin él, arrastrar el dedo hace scroll de
              la página en vez de dibujar. */}
          <canvas
            ref={ref}
            onPointerDown={abajo}
            onPointerMove={mover}
            onPointerUp={arriba}
            onPointerLeave={arriba}
            onPointerCancel={arriba}
            className="w-full touch-none rounded-md border-2 border-dashed bg-white cursor-crosshair aspect-[3/1]"
            aria-label={t("signaturePad.canvasLabel")}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs text-muted-foreground">{t("signaturePad.hint")}</p>
            <Button variant="ghost" size="sm" onClick={limpiar} disabled={!hayTrazo || firmando}>
              <Eraser className="h-4 w-4 mr-1" />
              {t("signaturePad.clear")}
            </Button>
          </div>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
          {/* Sigue existiendo el camino SIN trazo: quien firma desde un equipo
              donde dibujar con el ratón le sale mal no queda bloqueado, y la marca
              es su nombre tipeado como antes. */}
          <Button variant="ghost" onClick={() => onConfirmar(null)} disabled={firmando}>
            {t("signaturePad.signWithoutDrawing")}
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={firmando}>
              {t("common.cancel")}
            </Button>
            <Button onClick={confirmarConTrazo} disabled={!hayTrazo || firmando}>
              {firmando ? (
                <Spinner size="sm" className="mr-1" />
              ) : (
                <PenLine className="h-4 w-4 mr-1" />
              )}
              {t("signaturePad.confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

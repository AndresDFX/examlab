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
 * ── También se puede ADJUNTAR una foto de la firma ─────────────────────
 * Quien firma desde el teléfono casi siempre ya tiene su firma hecha en un papel.
 * La foto se procesa acá mismo, en el navegador: se le quita el fondo
 * (`signature-image.ts`), se recorta a la tinta y se escala. Nada sale del
 * equipo, no cuesta una llamada a ningún servicio y funciona sin red.
 *
 * El resultado se PINTA en el mismo lienzo antes de confirmar. Eso no es un
 * detalle: separar la tinta del papel es una estimación, y con una foto muy
 * despareja puede salir regular. Verlo antes de firmar deja decidir; adjuntar a
 * ciegas convertiría un documento firmado en una lotería.
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
import { Eraser, ImageUp, PenLine } from "lucide-react";
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
import { cajaDelTrazo, conMargen, dimensionesExportacion, trazoDemasiadoChico } from "./signature-pad";
import {
  dimensionesDeAnalisis,
  firmaCabeEnColumna,
  LADOS_DE_REINTENTO,
  quitarFondoDeFirma,
} from "./signature-image";

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
  const [procesando, setProcesando] = useState(false);

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

  /**
   * Adjuntar una FOTO de la firma: se le quita el fondo, se recorta a la tinta y
   * se pinta en el lienzo para que quien firma la vea antes de confirmar.
   *
   * Todo ocurre en el navegador. El `URL.createObjectURL` se revoca siempre —
   * también si la imagen falla al decodificar—, porque el objeto queda retenido
   * hasta que se revoque o se cierre la pestaña.
   */
  const adjuntar = async (archivo: File) => {
    setProcesando(true);
    const url = URL.createObjectURL(archivo);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const i = new Image();
        i.onload = () => resolve(i);
        i.onerror = () => reject(new Error("decode"));
        i.src = url;
      });

      // Se analiza a tamaño acotado: una foto de teléfono son doce megapíxeles y
      // recorrerla varias veces en JavaScript se siente, sin aportar nada.
      const an = dimensionesDeAnalisis(img.naturalWidth, img.naturalHeight);
      if (an.w === 0 || an.h === 0) {
        toast.error(t("signaturePad.imageUnreadable"));
        return;
      }
      const tmp = document.createElement("canvas");
      tmp.width = an.w;
      tmp.height = an.h;
      const gt = tmp.getContext("2d", { willReadFrequently: true });
      if (!gt) return;
      gt.drawImage(img, 0, 0, an.w, an.h);

      const datos = gt.getImageData(0, 0, an.w, an.h);
      const res = quitarFondoDeFirma(datos.data, an.w, an.h);
      if (!res.ok) {
        // Se dice QUÉ pasó y qué hacer, no «error al procesar»: la causa casi
        // siempre es una foto de una hoja sin firma o con muy poca luz.
        toast.error(
          res.motivo === "sin_contraste"
            ? t("signaturePad.noContrast")
            : t("signaturePad.imageUnreadable"),
        );
        return;
      }
      gt.putImageData(datos, 0, 0);

      // Recorte a la tinta: ya vale el mismo helper del trazo dibujado, porque
      // mira el alfa y el papel quedó transparente.
      const caja = cajaDelTrazo(datos.data, an.w, an.h);
      if (trazoDemasiadoChico(caja, 12)) {
        toast.error(t("signaturePad.noContrast"));
        return;
      }
      const rec = conMargen(caja!, MARGEN_RECORTE, an.w, an.h);

      // Se pinta CENTRADA y sin deformar en el lienzo, que es 3:1 y la foto no.
      preparar();
      const c = ref.current;
      const g = ctx();
      if (!c || !g) return;
      const escala = Math.min((ANCHO * 0.94) / rec.w, (ALTO * 0.94) / rec.h);
      const w = rec.w * escala;
      const h = rec.h * escala;
      g.drawImage(tmp, rec.x, rec.y, rec.w, rec.h, (ANCHO - w) / 2, (ALTO - h) / 2, w, h);
      setHayTrazo(true);
      toast.success(t("signaturePad.attached"));
    } catch {
      toast.error(t("signaturePad.imageUnreadable"));
    } finally {
      URL.revokeObjectURL(url);
      setProcesando(false);
    }
  };

  /**
   * Recorta a la tinta y exporta. `null` si no hay trazo utilizable.
   *
   * El recorte llega en píxeles de DISPOSITIVO (el buffer es `ANCHO/ALTO × dpr`,
   * hasta 3 en un teléfono), así que a densidad 3 el PNG a resolución completa
   * pesa ~3× lo que en un computador. Ese PNG va a `signed_drawing`, acotada a
   * 120 000 caracteres por `chk_report_signatures_drawing` — sin capar, una firma
   * completa desde el celular supera el tope y `sign_report`/`sign_report_public`
   * la rechazan con `invalid_drawing` ANTES de guardar. Esa era la firma "que no
   * funciona en el celular": andaba en la compu (dpr 1) y fallaba en el teléfono
   * (dpr 3) con el mismo trazo. Como la firma se muestra a lo sumo a 34px de alto
   * (`firmaHtml` en `signature-slots.ts`), capar el lado mayor no cuesta calidad.
   */
  const exportar = (): { dibujo: string } | { error: "vacio" | "muy_grande" } => {
    const c = ref.current;
    const g = ctx();
    if (!c || !g) return { error: "vacio" };
    const dpr = c.width / ANCHO;
    const img = g.getImageData(0, 0, c.width, c.height);
    const caja = cajaDelTrazo(img.data, c.width, c.height);
    if (trazoDemasiadoChico(caja, 12 * dpr)) return { error: "vacio" };
    const rec = conMargen(caja!, MARGEN_RECORTE * dpr, c.width, c.height);

    // Se baja el lado máximo hasta que el PNG entre en la columna. Un trazo
    // dibujado entra siempre en el primer intento; una FOTO no necesariamente:
    // trae muchísimo más alfa parcial —todo el borde del trazo real— y el PNG
    // comprime peor. Sin este bucle, adjuntar una foto reproduciría el fallo que
    // ya tuvo la firma dibujada en el celular: `sign_report` la rechaza con
    // `invalid_drawing` DESPUÉS de que la persona creyó haber firmado.
    for (const lado of LADOS_DE_REINTENTO) {
      const dim = dimensionesExportacion(rec.w, rec.h, lado);
      const salida = document.createElement("canvas");
      salida.width = dim.w;
      salida.height = dim.h;
      const gs = salida.getContext("2d");
      if (!gs) return { error: "vacio" };
      gs.drawImage(c, rec.x, rec.y, rec.w, rec.h, 0, 0, dim.w, dim.h);
      const dibujo = salida.toDataURL("image/png");
      if (firmaCabeEnColumna(dibujo)) return { dibujo };
    }
    return { error: "muy_grande" };
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
    const r = exportar();
    if ("error" in r) {
      toast.error(
        r.error === "muy_grande" ? t("signaturePad.tooBig") : t("signaturePad.tooSmall"),
      );
      return;
    }
    onConfirmar(r.dibujo);
  };

  return (
        // Tampoco se cierra mientras se procesa una foto: `adjuntar()` termina
    // leyendo `ref.current`, y si el diálogo se cerró y se volvió a abrir en el
    // medio, ese ref ya apunta al lienzo de la sesión NUEVA — la promesa vieja
    // pintaría encima de lo que la persona acaba de empezar a dibujar.
    <Dialog open={open} onOpenChange={(o) => !firmando && !procesando && onOpenChange(o)}>
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 text-2xs text-muted-foreground">
              {t("signaturePad.hint")} {t("signaturePad.attachHint")}
            </p>
            <div className="flex shrink-0 items-center gap-1">
              {/* Adjuntar la foto de una firma hecha en papel. Es un `<label>`
                  con el input escondido y no un Button que dispare un click
                  sintético: así el control nativo queda alcanzable por teclado y
                  el hit zone es el del rótulo entero. */}
              <label
                className={
                  // `h-9 md:h-8` y no `h-8`: es exactamente lo que resuelve `size="sm"` del
                  // Button de al lado. Con `h-8` fijo, los dos controles de esta misma
                  // barra quedaban con 4 px de diferencia de alto en móvil.
                  "inline-flex h-9 md:h-8 cursor-pointer items-center gap-1 rounded-md px-2.5 text-xs hover:bg-accent" +
                  (procesando || firmando ? " pointer-events-none opacity-50" : "")
                }
              >
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={procesando || firmando}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    // Se limpia el input ANTES de procesar: si no, elegir el
                    // MISMO archivo dos veces seguidas no dispara `change` y
                    // parece que el botón dejó de responder.
                    e.currentTarget.value = "";
                    if (f) void adjuntar(f);
                  }}
                />
                {procesando ? <Spinner size="sm" /> : <ImageUp className="h-4 w-4" />}
                {t("signaturePad.attach")}
              </label>
              <Button
                variant="ghost"
                size="sm"
                onClick={limpiar}
                disabled={!hayTrazo || firmando || procesando}
              >
                <Eraser className="h-4 w-4 mr-1" />
                {t("signaturePad.clear")}
              </Button>
            </div>
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

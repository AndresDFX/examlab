/**
 * Tarjeta de una actividad en las listas del ESTUDIANTE (exámenes, talleres, proyectos). Todas
 * tienen los mismos renglones en el mismo orden:
 *
 *   curso · título · estado, corte y peso
 *   dos renglones de descripción
 *   dos renglones de fechas
 *   UNA acción (+ el documento, si la actividad tiene)
 *   Ver más
 *
 * Lo demás —la descripción completa, el grupo, la retroalimentación, borrar la entrega, por qué
 * no se puede hacer algo— va detrás de «Ver más». Antes cada tarjeta crecía con lo que tuviera
 * (el documento, el recuadro del grupo, la retroalimentación) y dos tarjetas vecinas no se
 * parecían: una con el botón a media altura, otra con tres bloques de avisos.
 *
 * Los renglones se RESERVAN aunque estén vacíos (una actividad sin descripción, una
 * recuperación sin corte): un renglón que solo aparece a veces es justo lo que descuadraba la
 * grilla. Y la tarjeta la arma cada lista con estas piezas, no con una tarjeta de props, para
 * que la lógica de estados de cada actividad siga donde está.
 */
import {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Clock, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CortePesoBadges } from "@/components/ui/corte-peso";
import type { CorteYPeso } from "@/modules/grading/corte-y-peso";
import { AvisoActividadHomonima, CursoDeLaActividad } from "@/shared/components/CursoDeLaActividad";
import { MarkdownInline } from "@/shared/components/MarkdownInline";
import { markdownToPlain } from "@/shared/lib/markdown-plain";
import { cn } from "@/shared/lib/utils";

interface EstadoDeTarjeta {
  abierta: boolean;
  alternar: () => void;
  /** La descripción tiene más de lo que muestran sus dos renglones. */
  descripcionRecortada: boolean;
  setDescripcionRecortada: (v: boolean) => void;
  /** El título no entra en su renglón. Sin esto, en un teléfono (sin `title` al pasar el
   *  dedo) un título largo no se podía leer entero en una tarjeta sin «Ver más». */
  tituloRecortado: boolean;
  setTituloRecortado: (v: boolean) => void;
  tituloId: string;
  descripcionId: string;
}

const TarjetaContext = createContext<EstadoDeTarjeta | null>(null);

/** Mide si el contenido de `ref` no entra en su caja, y vuelve a medir cuando la caja cambia
 *  de ancho. jsdom (los tests) no tiene ResizeObserver: ahí mide una vez. */
function useRecorte(
  ref: RefObject<HTMLElement | null>,
  avisar: ((v: boolean) => void) | undefined,
  recortado: (el: HTMLElement) => boolean,
  deps: unknown[],
) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !avisar) return;
    const medir = () => avisar(recortado(el));
    medir();
    if (typeof ResizeObserver === "undefined") return;
    const observador = new ResizeObserver(medir);
    observador.observe(el);
    return () => observador.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avisar, ...deps]);
}

export const TarjetaDeActividad = forwardRef<
  HTMLDivElement,
  { children: ReactNode; className?: string }
>(({ children, className }, ref) => {
  const [abierta, setAbierta] = useState(false);
  const [descripcionRecortada, setDescripcionRecortada] = useState(false);
  const [tituloRecortado, setTituloRecortado] = useState(false);
  const tituloId = useId();
  const descripcionId = useId();
  const estado = useMemo<EstadoDeTarjeta>(
    () => ({
      abierta,
      alternar: () => setAbierta((v) => !v),
      descripcionRecortada,
      setDescripcionRecortada,
      tituloRecortado,
      setTituloRecortado,
      tituloId,
      descripcionId,
    }),
    [abierta, descripcionRecortada, tituloRecortado, tituloId, descripcionId],
  );
  return (
    <TarjetaContext.Provider value={estado}>
      <Card ref={ref} className={cn("flex flex-col", className)}>
        {/* `@container`: el botón del documento muestra su etiqueta según el ancho de la
            TARJETA, no de la pantalla — con dos columnas a 1024 px la tarjeta es tan
            angosta como en un teléfono. */}
        <CardContent className="@container p-5 flex flex-1 flex-col gap-3">{children}</CardContent>
      </Card>
    </TarjetaContext.Provider>
  );
});
TarjetaDeActividad.displayName = "TarjetaDeActividad";

/** `space-y-3` y no una columna flexible: un enlace con forma de botón conserva su ancho. */
export function CuerpoDeTarjeta({ children }: { children: ReactNode }) {
  return <div className="space-y-3">{children}</div>;
}

/**
 * El curso a todo el ancho, el título en una línea (entero en `title`, y al desplegar) y una
 * fila con el estado, el corte y el peso. El estado va en esa fila y no al lado del curso: ahí
 * le quitaba ancho, y en un teléfono el nombre del curso se partía en tres renglones. Como el
 * estado está siempre, la fila mide lo mismo aunque la actividad no tenga corte (una
 * recuperación no vale aparte y no lo lleva).
 */
export function EncabezadoDeTarjeta({
  curso,
  titulo,
  homonimas,
  cortePeso,
  estado,
}: {
  curso: string | null | undefined;
  titulo: string;
  homonimas: readonly string[] | undefined;
  cortePeso: CorteYPeso | null;
  estado: ReactNode;
}) {
  const tarjeta = useContext(TarjetaContext);
  const abierta = tarjeta?.abierta ?? false;
  const ref = useRef<HTMLHeadingElement>(null);
  // Abierta no se mide: el título ya se ve entero y tiene que seguir el botón para cerrarla.
  useRecorte(
    ref,
    abierta ? undefined : tarjeta?.setTituloRecortado,
    (el) => el.scrollWidth > el.clientWidth + 1,
    [titulo, abierta],
  );
  return (
    <div className="min-w-0 space-y-1.5">
      <CursoDeLaActividad curso={curso} />
      <h3
        ref={ref}
        id={tarjeta?.tituloId}
        className={cn("font-semibold", abierta ? "break-words" : "truncate")}
        title={abierta ? undefined : titulo}
      >
        {titulo}
      </h3>
      <AvisoActividadHomonima cursos={homonimas} />
      {/* Con dos columnas, en una línea (trunca el nombre del corte): partirla haría más
          alta esta tarjeta que la de al lado. Con una, mejor partir que recortar. */}
      <div className="flex flex-wrap lg:flex-nowrap items-center gap-1.5 min-w-0">
        {estado}
        <CortePesoBadges valor={cortePeso} />
      </div>
    </div>
  );
}

/**
 * Dos renglones de descripción SIEMPRE, aunque no haya. Recortada va en texto plano (la sintaxis
 * cruda `**así**` no se muestra); al desplegar la tarjeta se ve completa, en el mismo lugar y con
 * sus enlaces.
 */
export function ResumenDeTarjeta({ texto }: { texto: string | null | undefined }) {
  const tarjeta = useContext(TarjetaContext);
  const abierta = tarjeta?.abierta ?? false;
  const ref = useRef<HTMLParagraphElement>(null);
  const fuente = (texto ?? "").trim();
  const plano = useMemo(() => markdownToPlain(fuente), [fuente]);
  // Con formato (un enlace, una lista, párrafos) la versión completa muestra algo que la
  // recortada no, aunque entre en dos renglones. Un doble espacio no es formato.
  const conFormato = fuente !== "" && fuente.replace(/[ \t]+/g, " ") !== plano;
  useRecorte(
    ref,
    abierta ? undefined : tarjeta?.setDescripcionRecortada,
    (el) => conFormato || el.scrollHeight > el.clientHeight + 1,
    [plano, conFormato, abierta],
  );

  if (abierta && fuente) {
    return (
      <div id={tarjeta?.descripcionId} className="text-sm text-muted-foreground">
        <MarkdownInline>{fuente}</MarkdownInline>
      </div>
    );
  }
  return (
    <p
      ref={ref}
      id={tarjeta?.descripcionId}
      className="text-sm text-muted-foreground line-clamp-2 min-h-10"
    >
      {plano}
    </p>
  );
}

/** Las fechas ocupan siempre el alto de dos renglones, por la misma razón. */
export function FechasDeTarjeta({ children }: { children: ReactNode }) {
  return <div className="text-xs text-muted-foreground space-y-0.5 min-h-9">{children}</div>;
}

/** Un renglón de fecha: «Entrega: 30 sep 2026, 23:59». */
export function FechaDeTarjeta({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 tabular-nums">
      <Clock className="h-3 w-3 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

/** El documento o recurso de la actividad, al lado de la acción. Cada lista dice cómo se
 *  llama y con qué ícono, para que la tarjeta diga lo mismo que el detalle de esa actividad. */
export interface EnlaceDeTarjeta {
  href: string | null | undefined;
  etiqueta: string;
  /** Nombre completo: `aria-label` y `title`. Contiene a `etiqueta` (WCAG 2.5.3). */
  descripcion: string;
  icono: LucideIcon;
}

/**
 * UNA acción y, al lado, el documento de la actividad si tiene. La acción es lo que el estudiante
 * vino a hacer (entregar, armar el grupo, ver la nota) o, si no puede hacer nada, un botón
 * deshabilitado que dice por qué: así ninguna tarjeta queda con el pie vacío. El primer hijo se
 * estira; su etiqueta va en un `truncate` para que en una tarjeta angosta se recorte en vez de
 * salirse del botón.
 */
export function AccionesDeTarjeta({
  children,
  enlace,
}: {
  children: ReactNode;
  enlace?: EnlaceDeTarjeta;
}) {
  const Icono = enlace?.icono;
  return (
    <div className="mt-auto flex items-center gap-2 [&>*:first-child]:min-w-0 [&>*:first-child]:flex-1">
      {children}
      {enlace?.href && Icono && (
        /* Contorno con el color de la institución y no un primario: el primario de la
           tarjeta es la acción, y dos botones llenos compiten por la misma mirada. En una
           tarjeta angosta queda solo el ícono, con su nombre en `aria-label`. */
        <Button
          asChild
          variant="outline"
          size="sm"
          className="shrink-0 border-primary/40 text-primary hover:text-primary"
        >
          <a
            href={enlace.href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={enlace.descripcion}
            title={enlace.descripcion}
          >
            <Icono />
            <span className="hidden @xs:inline">{enlace.etiqueta}</span>
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * La acción cuando no hay ninguna que hacer: un botón deshabilitado que dice por qué (aún no
 * abre, ya cerró, falta la nota). Es el patrón que ya usaban los exámenes; el detalle del motivo
 * va en «Ver más».
 */
export function AccionNoDisponible({
  icono,
  children,
}: {
  icono?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Button size="sm" variant="outline" disabled className="w-full min-w-0">
      {icono}
      <span className="min-w-0 truncate">{children}</span>
    </Button>
  );
}

/**
 * Lo secundario de la tarjeta, plegado detrás de «Ver más». Se abre ENTRE la acción y el botón,
 * así «Ver menos» queda donde se terminó de leer. Sin nada que mostrar —ni hijos, ni una
 * descripción o un título que se corten— el botón no aparece, pero con dos columnas su lugar
 * se conserva: la tarjeta mide lo mismo que la de al lado.
 */
export function DetallesDeTarjeta({ children }: { children?: ReactNode }) {
  const { t } = useTranslation();
  const tarjeta = useContext(TarjetaContext);
  const botonId = useId();
  const detallesId = useId();
  // Solo cuentan los elementos: un `""` o un `0` colado por una condición `a && b` dejaría un
  // «Ver más» que no despliega nada (y el `0` se pintaría).
  const hijos = Children.toArray(children).filter(isValidElement);
  const abierta = tarjeta?.abierta ?? false;
  if (
    !tarjeta ||
    (hijos.length === 0 && !tarjeta.descripcionRecortada && !tarjeta.tituloRecortado)
  ) {
    // El alto del botón: `size="sm"` más la regla táctil de styles.css, que lo sube a 44.
    return <div aria-hidden className="hidden lg:block h-8 pointer-coarse:min-h-11" />;
  }
  const controla =
    [
      tarjeta.descripcionRecortada ? tarjeta.descripcionId : null,
      abierta && hijos.length > 0 ? detallesId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  return (
    <div className="space-y-3">
      {abierta && hijos.length > 0 && (
        <div id={detallesId} className="space-y-3 border-t pt-3">
          {hijos}
        </div>
      )}
      {/* El nombre accesible suma el título: con doce tarjetas, doce «Ver más» iguales no
          dicen cuál abre cuál. */}
      <Button
        id={botonId}
        variant="ghost"
        size="sm"
        className="w-full text-muted-foreground"
        aria-expanded={abierta}
        aria-controls={controla}
        aria-labelledby={`${botonId} ${tarjeta.tituloId}`}
        onClick={tarjeta.alternar}
      >
        <ChevronDown className={cn("transition-transform", abierta && "rotate-180")} />
        {abierta ? t("tarjetaActividad.verMenos") : t("tarjetaActividad.verMas")}
      </Button>
    </div>
  );
}

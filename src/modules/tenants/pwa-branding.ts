/**
 * Identidad visual de la app INSTALADA (y del favicon) según la dirección.
 *
 * ── Qué resuelve ──────────────────────────────────────────────────────
 * La misma compilación se publica en varias direcciones: el despliegue general
 * (`app.examlab.workers.dev`, que muestra el selector) y uno por institución
 * (`uniaj.examlab.workers.dev`, ver `subdomain.ts`). Hasta acá TODAS servían el
 * mismo `manifest.json` y los mismos íconos estáticos, así que un estudiante que
 * instalaba la app desde la dirección de su universidad terminaba con el ícono y
 * el nombre de ExamLab en la pantalla de inicio, sin ninguna señal de a qué
 * institución entra.
 *
 * Ahora: el HOST manda. Sin institución en el host → ExamLab, exactamente como
 * antes. Con institución → el ícono de ExamLab con el logo de esa institución
 * como distintivo, y su etiqueta.
 *
 * ── Por qué el ícono es una COMPOSICIÓN y no el logo de la universidad ─
 * La base a sangre completa es el ícono de ExamLab y el logo de la institución
 * va chico, en la esquina inferior derecha. Así la app se sigue reconociendo
 * como la misma en la pantalla de inicio —es la misma plataforma— y el
 * distintivo dice a qué institución entra. Reemplazar el ícono entero por el
 * logo de la universidad (la primera versión de esto) hacía lo contrario:
 * borraba el producto y dejaba tantas apps distintas como instituciones.
 *
 * ── Por qué el HOST y no `useTenant()` ────────────────────────────────
 * `useTenant()` mezcla tres fuentes (override del SuperAdmin, host, y el tenant
 * del perfil) y depende de la sesión. El ícono de la app tiene que estar bien
 * ANTES de iniciar sesión —la instalación se ofrece en la pantalla de login— y
 * no puede cambiar porque un SuperAdmin esté "viendo como" otra institución: lo
 * instalado es de la DIRECCIÓN, no de quien mira. Por eso acá se lee solo el
 * subdominio.
 *
 * ── Por qué se arma en el navegador y no en el servidor ───────────────
 * El despliegue de Cloudflare es de assets, SIN código de servidor
 * (`wrangler.jsonc` lo explica: el Worker con SSR pesaba 5,34 MB y el plan Free
 * corta en 3 MB). No hay dónde generar un `manifest.json` por host. Así que el
 * manifest se arma en runtime y se cambia el `<link rel="manifest">` a un Blob;
 * los íconos se rasterizan con canvas desde el logo de la institución.
 *
 * ── Dos cosas que quedan FUERA a propósito ────────────────────────────
 * 1. El ícono de las **notificaciones push** sigue siendo el de ExamLab
 *    (`public/sw.js` lo fija en `/icons/icon-192.png`). No es un olvido: el
 *    Service Worker no lee `localStorage`, así que el ícono de la institución
 *    tendría que viajar en el payload del push o guardarse donde el SW alcance
 *    —otro mecanismo, no este—. Si algún día molesta, ese es el camino.
 * 2. **No hay script pre-paint** como el del tema y el de las variables de marca
 *    (ver `__root.tsx`): en la primera carga fría de una institución se ve un
 *    instante el favicon de ExamLab. Un favicon que cambia un cuadro después es
 *    mucho menos notorio que un fondo que pasa de claro a oscuro, y evita un
 *    tercer script inline en el `<head>`. De la segunda visita en adelante el
 *    caché lo aplica en el primer efecto.
 *
 * ── Lo que se puede y lo que no se puede verificar desde acá ──────────
 * Que Chromium tome el manifest nuevo SÍ se verifica (CDP `Page.getAppManifest`,
 * ver `verificar-pwa-ios-sin-dispositivo`). Que iOS use el `apple-touch-icon` al
 * crear el ícono desde Compartir → "Añadir a pantalla de inicio" es del sistema
 * operativo y solo se comprueba con un iPhone en la mano.
 */

/** Lado del ícono grande del manifest. */
export const LADO_ICONO_GRANDE = 512;
/** Lado del ícono chico del manifest (y del favicon que se inyecta). */
export const LADO_ICONO_CHICO = 192;
/** Lado del `apple-touch-icon`: el que iOS usa en la pantalla de inicio. */
export const LADO_APPLE_TOUCH = 180;

/** El ícono de ExamLab que hace de base de la composición. */
export const RUTA_BASE_EXAMLAB = "/icons/icon-512.png";

/**
 * Qué parte del lienzo ocupa el distintivo de la institución.
 *
 * Es un DISTINTIVO, no el ícono: la app se sigue reconociendo como ExamLab y el
 * logo de la universidad dice a cuál se entra. Un tercio del lado es el tamaño
 * al que el logo todavía se distingue en la pantalla de inicio (48 px sobre un
 * ícono de 144) sin taparle la mitad al de abajo.
 */
export const FRACCION_DISTINTIVO = 0.34;

/**
 * Cuánto del círculo del distintivo puede ocupar el logo de la institución.
 *
 * El resto es el aro blanco que lo separa del fondo del ícono de ExamLab, que
 * es índigo oscuro: sin ese margen, un logo azul marino sobre transparente
 * desaparece contra la base.
 */
export const FRACCION_LOGO_EN_DISTINTIVO = 0.76;

/**
 * Radio del área que un lanzador de Android garantiza que NO recorta, como
 * fracción del lado. Android puede aplicar círculo, "squircle" o gota, y solo
 * promete el círculo central del 80 % del lado — o sea, radio 0,4.
 */
export const RADIO_SEGURO_MASKABLE = 0.4;

/**
 * Etiqueta corta de la institución para la pantalla de inicio.
 *
 * Es el IDENTIFICADOR de la institución (`slug`), no un acrónimo calculado a
 * partir del nombre largo. La primera versión armaba siglas y a "Universidad
 * Antonio Jose Camacho" la bautizó "UAJC", cuando en la plataforma —y para la
 * gente que la usa— esa institución es **UNIAJ**. Inventar un nombre corto es
 * inventarle el nombre a la institución; el que ya eligió está en el slug.
 *
 * El nombre solo se usa como respaldo si no hay slug utilizable, y ahí sí se
 * recorta a lo que entra (Android e iOS truncan cerca de los 12 caracteres).
 */
export function etiquetaInstitucion(
  slug: string | null | undefined,
  nombre?: string | null,
): string | null {
  const s = (slug ?? "").trim();
  if (s && s.length <= 12) return s.toUpperCase();

  const limpio = (nombre ?? "").replace(/\s+/g, " ").trim();
  if (limpio) return limpio.length <= 12 ? limpio : limpio.slice(0, 12).trim();
  return s ? s.slice(0, 12).toUpperCase() : null;
}

/**
 * Dónde va el círculo del distintivo dentro del lienzo.
 *
 * En un ícono `any` se apoya contra la esquina inferior derecha, con un margen
 * chico. En uno `maskable` NO puede ir en la esquina: la esquina es justo lo que
 * el lanzador recorta, así que el distintivo se corre sobre la diagonal hasta
 * quedar ENTERO dentro del círculo seguro — sigue leyéndose abajo a la derecha,
 * pero sobrevive al recorte.
 */
export function medidasDistintivo(
  lado: number,
  esMaskable: boolean,
): { cx: number; cy: number; r: number } | null {
  if (!(lado > 0)) return null;
  const r = (lado * FRACCION_DISTINTIVO) / 2;

  if (!esMaskable) {
    const margen = lado * 0.045;
    const c = lado - margen - r;
    return { cx: c, cy: c, r };
  }

  // Centro del distintivo sobre la diagonal, a la mayor distancia del centro
  // que deja el círculo completo dentro del área garantizada.
  const distancia = Math.max(0, lado * RADIO_SEGURO_MASKABLE - r);
  const desplazamiento = distancia / Math.SQRT2;
  return { cx: lado / 2 + desplazamiento, cy: lado / 2 + desplazamiento, r };
}

export interface IconoManifest {
  src: string;
  sizes: string;
  type: string;
  purpose: string;
}

export interface ArgsManifest {
  /** Nombre de la institución. Vacío/nulo ⇒ se usa el de ExamLab. */
  nombreInstitucion?: string | null;
  /** Identificador de la institución: es lo que va bajo el ícono. */
  slugInstitucion?: string | null;
  /** Íconos ya rasterizados del logo. Vacío ⇒ se dejan los de ExamLab. */
  iconos?: readonly IconoManifest[] | null;
  /** Color de marca de la institución, para la barra del sistema. */
  colorTema?: string | null;
  /** `location.origin` — el manifest va en un Blob, así que todo va ABSOLUTO. */
  origin: string;
}

/** Los íconos estáticos de ExamLab, como respaldo. */
export function iconosPorDefecto(origin: string): IconoManifest[] {
  return [
    { src: `${origin}/icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: `${origin}/icons/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "maskable" },
    { src: `${origin}/icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
    { src: `${origin}/icons/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
  ];
}

/**
 * El manifest de la institución.
 *
 * `start_url`, `scope` e `id` van ABSOLUTOS a propósito: el manifest se sirve
 * desde una URL `blob:`, y una ruta relativa se resolvería contra ESA url —que
 * no es del sitio— y el navegador descartaría el manifest entero. `id` fija la
 * identidad de la app instalada; como cada institución es un origen distinto,
 * queda naturalmente separada de las demás.
 */
/**
 * Nombre de la app instalada: «ExamLab - UNIAJ», o sea plataforma + el
 * identificador de la institución.
 *
 * Es UNA sola función porque el nombre tiene que salir igual en los tres
 * lugares donde se lee —`name` y `short_name` del manifest, y el título que usa
 * iOS— y la primera versión los tenía separados: `name` decía «ExamLab - UNIAJ»
 * pero lo que la persona veía bajo el ícono era `short_name`, que decía solo
 * «UNIAJ». La app no se reconocía como ExamLab en la pantalla de inicio.
 *
 * Nota de presentación: Android e iOS truncan la etiqueta cerca de los 12
 * caracteres, así que en la pantalla de inicio se leerá recortado. Es una
 * decisión tomada a sabiendas: se prefiere que diga de qué plataforma es, aun
 * cortado, a que diga un identificador que fuera de contexto no significa nada.
 */
export function nombreAppInstitucion(
  slug: string | null | undefined,
  nombre?: string | null,
): string {
  const corto = etiquetaInstitucion(slug, nombre);
  if (!corto) return "ExamLab — Plataforma de Exámenes";
  // Una institución que YA se llama con la marca (la demo) no se antepone otra
  // vez: daría «ExamLab - EXAMLAB-DEMO».
  if (/examlab/i.test(corto)) return corto;
  return `ExamLab - ${corto}`;
}

export function construirManifestDeInstitucion(args: ArgsManifest): Record<string, unknown> {
  const { nombreInstitucion, slugInstitucion, iconos, colorTema, origin } = args;
  const nombre = (nombreInstitucion ?? "").trim();
  const corto =
    nombre || slugInstitucion
      ? (etiquetaInstitucion(slugInstitucion, nombre) ?? "ExamLab")
      : "ExamLab";

  const nombreApp = nombreAppInstitucion(slugInstitucion, nombreInstitucion);

  return {
    id: `${origin}/`,
    name: nombreApp,
    // El MISMO nombre que `name`, no solo el identificador. Lo que la persona
    // ve bajo el ícono sale de acá, y con solo «UNIAJ» la app no se reconocía
    // como ExamLab en la pantalla de inicio ni en el listado de aplicaciones.
    short_name: nombreApp,
    description: nombre
      ? `Plataforma académica de ${nombre}: exámenes, talleres y seguimiento.`
      : "Plataforma académica con IA, proctoring y gestión completa de exámenes online.",
    start_url: `${origin}/`,
    scope: `${origin}/`,
    display: "standalone",
    background_color: "#0f172a",
    theme_color: esColorHex(colorTema) ? (colorTema as string) : "#6366f1",
    orientation: "portrait",
    icons: iconos && iconos.length > 0 ? [...iconos] : iconosPorDefecto(origin),
    categories: ["education", "productivity"],
  };
}

/**
 * ¿Es un color hex utilizable? El `theme_color` va al manifest y a la barra del
 * sistema; un valor raro guardado en la base no debería romper el manifest
 * entero, así que se cae al color de ExamLab.
 */
export function esColorHex(valor: string | null | undefined): boolean {
  return typeof valor === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(valor.trim());
}

/**
 * Dónde dibujar el logo dentro del lienzo cuadrado del ícono: "contenido"
 * (sin deformar, entra completo) y centrado, ocupando como mucho
 * `fraccionSegura` del lado.
 *
 * Devuelve `null` si la imagen no tiene medidas utilizables — dibujar con
 * ancho o alto 0 no falla pero deja el ícono vacío, y es peor que no cambiarlo.
 */
export function medidasIcono(
  anchoImagen: number,
  altoImagen: number,
  lado: number,
  fraccionSegura: number,
): { x: number; y: number; w: number; h: number } | null {
  if (!(anchoImagen > 0) || !(altoImagen > 0) || !(lado > 0)) return null;
  const disponible = lado * fraccionSegura;
  const escala = Math.min(disponible / anchoImagen, disponible / altoImagen);
  const w = anchoImagen * escala;
  const h = altoImagen * escala;
  return { x: (lado - w) / 2, y: (lado - h) / 2, w, h };
}

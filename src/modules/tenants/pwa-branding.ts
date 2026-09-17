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
 * antes. Con institución → su logo y su nombre, en el favicon, en el ícono de la
 * pantalla de inicio y en el nombre de la app instalada.
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

/**
 * Cuánto del lienzo puede ocupar el logo en un ícono `maskable`.
 *
 * Android recorta el ícono con la forma que tenga el lanzador (círculo,
 * "squircle", gota) y solo garantiza el círculo central del 80 %. Se usa 60 % y
 * no 80 % porque el logo de una institución suele ser MUY apaisado (el de UNIAJ
 * mide 2506 bytes de webp bien ancho): al "contenerlo" en un cuadrado, lo que
 * define la escala es el ancho, y con 80 % los extremos quedaban pegados al
 * borde del círculo seguro.
 */
export const FRACCION_SEGURA_MASKABLE = 0.6;
/** Un ícono `any` no se recorta: el logo puede usar casi todo el lienzo. */
export const FRACCION_SEGURA_ANY = 0.82;

/**
 * Nombre corto para la etiqueta de la pantalla de inicio.
 *
 * Android e iOS truncan alrededor de los 12 caracteres, y un nombre truncado a
 * la mitad ("Universidad A…") no identifica nada. Si el nombre es largo se
 * arman SIGLAS con las iniciales de las palabras significativas — que es como
 * la gente llama a su institución de todos modos ("Universidad Antonio Jose
 * Camacho" → "UAJC").
 *
 * Las palabras de una o dos letras se descartan (de, la, y…) pero solo cuando
 * hay suficientes palabras largas: "Prueba de A" no debe quedar en "P".
 */
export function nombreCortoInstitucion(nombre: string | null | undefined): string | null {
  const limpio = (nombre ?? "").replace(/\s+/g, " ").trim();
  if (!limpio) return null;
  if (limpio.length <= 12) return limpio;

  const palabras = limpio.split(" ");
  const significativas = palabras.filter((p) => p.replace(/[^\p{L}\p{N}]/gu, "").length > 2);
  const base = significativas.length >= 2 ? significativas : palabras;
  const siglas = base
    .map((p) => {
      const letras = p.replace(/[^\p{L}\p{N}]/gu, "");
      return letras ? letras[0]!.toUpperCase() : "";
    })
    .join("");

  // Con una sola palabra larga no hay siglas que valgan: se recorta.
  if (siglas.length < 2) return limpio.slice(0, 12).trim();
  return siglas.slice(0, 12);
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
export function construirManifestDeInstitucion(args: ArgsManifest): Record<string, unknown> {
  const { nombreInstitucion, iconos, colorTema, origin } = args;
  const nombre = (nombreInstitucion ?? "").trim();
  // El sufijo dice de qué plataforma es la app; si el nombre de la institución ya
  // lo contiene ("ExamLab Demo"), repetirlo da "ExamLab Demo — ExamLab".
  const yaSeNombra = /examlab/i.test(nombre);
  const nombreApp = nombre
    ? yaSeNombra
      ? nombre
      : `${nombre} — ExamLab`
    : "ExamLab — Plataforma de Exámenes";
  const corto = nombre ? (nombreCortoInstitucion(nombre) ?? "ExamLab") : "ExamLab";

  return {
    id: `${origin}/`,
    name: nombreApp,
    short_name: corto,
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

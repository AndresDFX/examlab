/**
 * A qué frontend puede volver el OAuth del calendario. `calendar` (init) guarda
 * el origen que manda el navegador y `calendar-oauth-callback` redirige ahí con
 * el resultado: sin esta lista sería una redirección abierta.
 *
 * Tiene que estar cada dominio donde se publica la app. Desde el 2026-08-21 eso
 * es Cloudflare Workers, un Worker por institución (`app`, `uniaj`, `fesna`…),
 * y la lista se había quedado con los dominios de Lovable: «Conectar cuenta»
 * respondía `origin_not_allowed` en todas las instituciones, con Google y con
 * Microsoft. El día que haya dominio propio, va acá.
 *
 * Vive en `_shared` porque la usan las dos funciones: el despliegue solo
 * publica la carpeta que cambió, y en `_shared` un cambio las publica a ambas.
 * Módulo puro (sin Deno) para que el test lo importe tal cual.
 */
const ORIGENES_PERMITIDOS = [
  // `examlab` es el subdominio de NUESTRA cuenta de Cloudflare: nadie más puede
  // publicar un Worker bajo `*.examlab.workers.dev`. Una sola etiqueta delante,
  // que es el nombre del Worker.
  /^https:\/\/[a-z0-9-]+\.examlab\.workers\.dev$/i,
  // El sitio viejo de Lovable sigue publicado contra la misma base. Exacto y no
  // `*.lovable.app`: cualquiera crea un proyecto ahí, y eso abría la lista a
  // dominios ajenos.
  /^https:\/\/examlab\.lovable\.app$/i,
  /^http:\/\/localhost(:\d+)?$/i,
];

/** El Worker general (selector de institución): a donde se vuelve cuando el
 *  origen pedido no se puede usar. */
export const ORIGEN_GENERAL = "https://app.examlab.workers.dev";

export function esOrigenPermitido(origen: string): boolean {
  try {
    const u = new URL(origen);
    return ORIGENES_PERMITIDOS.some((re) => re.test(`${u.protocol}//${u.host}`));
  } catch {
    return false;
  }
}

/** A dónde vuelve el callback. Para avisar de un error, el callback lee el
 *  origen del `state` de la URL ANTES de cruzarlo con la base, así que tiene
 *  que pasar por acá: sin esto, `?error=x&state=a:b:<base64 de otro sitio>`
 *  redirigía a cualquier dominio. */
export function origenDeVuelta(candidato: string | null | undefined): string {
  if (candidato && esOrigenPermitido(candidato)) return new URL(candidato).origin;
  return ORIGEN_GENERAL;
}

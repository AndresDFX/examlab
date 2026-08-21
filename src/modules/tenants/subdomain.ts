/**
 * Resolución del tenant por SUBDOMINIO (`uniaj.midominio.co` → slug `uniaj`).
 *
 * Para qué: hoy, al entrar, el usuario tiene que ELEGIR su institución en un
 * selector, y el slug no queda en la URL — así que no se puede compartir un
 * enlace que abra directo en la institución correcta. Con el subdominio, cada
 * institución tiene su dirección y el selector se saltea.
 *
 * ── Por qué subdominio y NO `/t/<slug>/...` ───────────────────────────
 * La ruta en la URL fue el plan original y **ya se intentó**: no funcionó en
 * Lovable porque el `rewrite` de TanStack Router es asimétrico entre servidor y
 * cliente y el SSR emitía 307 (ver el encabezado de `use-tenant.ts` y
 * `TenantUrlGuard.tsx`). El subdominio no tiene ese problema: se lee del
 * hostname en runtime, sin tocar el router ni el SSR.
 *
 * ── La trampa que este módulo existe para evitar ──────────────────────
 * "Tomar la primera etiqueta del hostname" está MAL: en `examlab.lovable.app`
 * devolvería `examlab` como si fuera un slug de institución, y la app intentaría
 * resolver un tenant inexistente en el host que se usa hoy en producción. Por eso
 * hay una lista de hosts de plataforma cuyos subdominios NO son tenants, y por eso
 * `www` tampoco cuenta.
 *
 * Esto es solo una PISTA DE UI para elegir qué institución mostrar. El
 * aislamiento real lo sigue dando la RLS server-side: poner `otra.midominio.co`
 * en la barra de direcciones no da acceso a los datos de otra institución.
 */

import { isValidTenantSlug } from "@/modules/tenants/tenant";

/**
 * Hosts donde la app vive SIN subdominio por institución. Su primera etiqueta es
 * el nombre del proyecto o del entorno, no un slug.
 *
 * Se comparan por SUFIJO, así que cubre `examlab.lovable.app`,
 * `preview--algo.lovable.app` y cualquier `*.lovable.app` futuro.
 */
const PLATFORM_HOST_SUFFIXES = [
  "lovable.app",
  "lovable.dev",
  "lovableproject.com",
  "netlify.app",
  "vercel.app",
  "pages.dev",
];

/**
 * `workers.dev` es la EXCEPCIÓN, y por eso salió de la lista de arriba.
 *
 * En Cloudflare la URL de un Worker es `<worker>.<cuenta>.workers.dev`, o sea que
 * la primera etiqueta la elegimos nosotros al desplegar. Aprovechamos eso:
 * publicamos un Worker POR INSTITUCIÓN, nombrado con su slug, y así
 * `uniaj.examlab.workers.dev` entra directo a UNIAJ sin dominio propio y sin
 * costo. En el resto de los hosts de plataforma la primera etiqueta es el
 * nombre del proyecto y leerla sería el bug que este módulo evita; acá es
 * deliberadamente el slug.
 *
 * El corte por CANTIDAD DE ETIQUETAS es lo que hace segura la excepción:
 *   · `uniaj.examlab.workers.dev`  → 4 · hay Worker, la primera etiqueta es suya
 *   · `examlab.workers.dev`        → 3 · es la raíz del subdominio de la cuenta,
 *                                        no hay Worker y no hay slug que leer
 *
 * El despliegue principal —el que muestra el selector— se llama `app`, que ya
 * está en RESERVED_LABELS: `app.examlab.workers.dev` devuelve null igual que
 * cualquier otro host sin institución.
 *
 * Limitación conocida, es el precio de no tener dominio: una institución nueva
 * NO funciona sola. Hay que desplegarle su Worker (`wrangler deploy --name
 * <slug>`). Con un dominio propio + DNS comodín, en cambio, alcanza con crearla.
 */
const WORKERS_DEV_SUFFIX = "workers.dev";

/** Etiquetas que nunca son una institución, aunque sean un subdominio válido. */
const RESERVED_LABELS = new Set([
  "www",
  "app",
  "api",
  "admin",
  "auth",
  "static",
  "assets",
  "cdn",
  "mail",
  "preview",
  "staging",
  "dev",
  "test",
]);

/** ¿El hostname es una IP? Ahí no hay subdominios que interpretar. */
function isIpAddress(host: string): boolean {
  // IPv4 completa, o IPv6 (que en un hostname llega entre corchetes).
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * Slug de institución que viene en el subdominio, o `null` si no hay uno
 * interpretable. Tolerante: cualquier entrada rara devuelve `null` en vez de
 * lanzar — se llama en el camino de arranque de la app.
 *
 * Devuelve `null` (y por lo tanto se conserva el selector) cuando:
 *   · el host es de plataforma (`examlab.lovable.app`, `*.pages.dev`…);
 *   · es un dominio desnudo (`midominio.co`) o `www`;
 *   · es `localhost` o una IP;
 *   · la etiqueta está reservada o no es un slug válido.
 *
 * En desarrollo acepta `uniaj.localhost`, que Chrome y Firefox resuelven solos.
 */
export function subdomainTenantSlug(hostname: string | null | undefined): string | null {
  if (typeof hostname !== "string") return null;
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host || isIpAddress(host)) return null;

  const labels = host.split(".").filter(Boolean);

  // `uniaj.localhost` en desarrollo: 2 etiquetas y la última es localhost.
  if (labels.length === 2 && labels[1] === "localhost") {
    return candidate(labels[0]);
  }
  if (labels.length < 3) return null; // dominio desnudo o localhost pelado

  // Cloudflare Workers: la primera etiqueta es el nombre del Worker, y lo
  // nombramos con el slug de la institución a propósito (ver WORKERS_DEV_SUFFIX).
  // Va ANTES de la lista de plataforma porque es la excepción a esa regla.
  if (host === WORKERS_DEV_SUFFIX || host.endsWith(`.${WORKERS_DEV_SUFFIX}`)) {
    return labels.length >= 4 ? candidate(labels[0]) : null;
  }

  // Host de plataforma → su primera etiqueta es el proyecto, no una institución.
  if (PLATFORM_HOST_SUFFIXES.some((sfx) => host === sfx || host.endsWith(`.${sfx}`))) {
    return null;
  }

  return candidate(labels[0]);
}

function candidate(label: string): string | null {
  if (!label || RESERVED_LABELS.has(label)) return null;
  return isValidTenantSlug(label) ? label : null;
}

/** ¿Este hostname define la institución? Si sí, el selector no se muestra. */
export function hostDefinesTenant(hostname: string | null | undefined): boolean {
  return subdomainTenantSlug(hostname) !== null;
}

/**
 * Aplica en runtime la identidad visual de la institución que dicta el HOST:
 * favicon, `apple-touch-icon`, nombre y manifest de la app instalada.
 *
 * El porqué de cada decisión está en `pwa-branding.ts`. Acá vive lo que toca el
 * DOM y la red.
 */
import { useEffect } from "react";

import { supabase } from "@/integrations/supabase/client";
import { resolveTenantLogoUrl } from "@/modules/tenants/tenant";
import { subdomainTenantSlug } from "@/modules/tenants/subdomain";
import {
  FRACCION_SEGURA_ANY,
  FRACCION_SEGURA_MASKABLE,
  LADO_APPLE_TOUCH,
  LADO_ICONO_CHICO,
  LADO_ICONO_GRANDE,
  construirManifestDeInstitucion,
  esColorHex,
  medidasIcono,
  type IconoManifest,
} from "@/modules/tenants/pwa-branding";

/** Lo que se guarda en caché por institución. */
interface BrandingCacheado {
  nombre: string;
  colorTema: string | null;
  /** URL del logo con el que se rasterizaron los íconos: si cambia, se rehace. */
  logoUrl: string | null;
  /** PNG en data URL, por lado y propósito. */
  icono192: string | null;
  icono512: string | null;
  icono512Maskable: string | null;
  iconoApple: string | null;
}

/**
 * La versión va en la clave a propósito: lo cacheado son PNG ya rasterizados, y
 * si cambia CÓMO se rasterizan (las fracciones seguras, el fondo, los lados) el
 * guardado no se invalida solo — la comparación de abajo solo mira nombre, logo
 * y color, que no cambiaron. Subir el número deja obsoleto todo lo viejo sin
 * tener que esperar a que la institución cambie su logo.
 */
const CACHE_PREFIJO = "examlab-pwa-branding:v1:";

/** Blob del manifest vigente, para revocarlo al reemplazarlo. */
let urlManifestActual: string | null = null;

function leerCache(slug: string): BrandingCacheado | null {
  try {
    const raw = window.localStorage.getItem(CACHE_PREFIJO + slug);
    if (!raw) return null;
    const v = JSON.parse(raw) as BrandingCacheado;
    return typeof v?.nombre === "string" ? v : null;
  } catch {
    return null;
  }
}

function guardarCache(slug: string, v: BrandingCacheado): void {
  try {
    window.localStorage.setItem(CACHE_PREFIJO + slug, JSON.stringify(v));
  } catch {
    /* sin espacio o storage bloqueado: el branding igual ya se aplicó */
  }
}

/** Institución del host, leída SIN sesión (el login también debe verse bien). */
async function traerInstitucion(
  slug: string,
): Promise<{ nombre: string; logoUrl: string | null; colorTema: string | null } | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any).rpc("list_active_tenants_public");
    if (error || !Array.isArray(data)) return null;
    const fila = (
      data as Array<{
        slug: string;
        name: string;
        logo_url: string | null;
        logo_path: string | null;
        primary_color: string | null;
      }>
    ).find((t) => t.slug === slug);
    if (!fila) return null;
    return {
      nombre: fila.name,
      logoUrl: resolveTenantLogoUrl(fila, supabase),
      colorTema: esColorHex(fila.primary_color) ? fila.primary_color : null,
    };
  } catch {
    return null;
  }
}

/** Carga el logo como imagen lista para dibujar, sin manchar el lienzo. */
function cargarImagen(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // El bucket `tenant-logos` responde `Access-Control-Allow-Origin: *`
    // (verificado). Sin esto el lienzo queda "tainted" y `toDataURL` lanza.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("logo_no_carga"));
    img.src = url;
  });
}

/**
 * Rasteriza el logo a un PNG cuadrado.
 *
 * Fondo BLANCO y no transparente: iOS pinta de negro lo transparente del
 * `apple-touch-icon`, y un maskable transparente queda con el recorte del
 * lanzador a la vista. Blanco funciona para logos pensados para papel, que es
 * lo que sube una institución.
 */
function rasterizar(img: HTMLImageElement, lado: number, fraccionSegura: number): string | null {
  const medidas = medidasIcono(img.naturalWidth, img.naturalHeight, lado, fraccionSegura);
  if (!medidas) return null;
  const lienzo = document.createElement("canvas");
  lienzo.width = lado;
  lienzo.height = lado;
  const g = lienzo.getContext("2d");
  if (!g) return null;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, lado, lado);
  g.drawImage(img, medidas.x, medidas.y, medidas.w, medidas.h);
  try {
    return lienzo.toDataURL("image/png");
  } catch {
    // Lienzo manchado (el logo vino de un origen sin CORS): mejor dejar el
    // ícono de ExamLab que romper la instalación.
    return null;
  }
}

function ponerLink(rel: string, href: string, type?: string): void {
  // `rel="icon"` aparece dos veces en el head (PNG y SVG). Se limpian TODOS y
  // se deja uno solo: si queda el SVG de ExamLab, gana él en varios navegadores
  // y el favicon seguiría siendo el de la plataforma.
  const previos = document.head.querySelectorAll(`link[rel="${rel}"]`);
  previos.forEach((n) => n.parentElement?.removeChild(n));
  const link = document.createElement("link");
  link.rel = rel;
  if (type) link.type = type;
  link.href = href;
  document.head.appendChild(link);
}

function ponerMeta(name: string, content: string): void {
  let meta = document.head.querySelector(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.setAttribute("name", name);
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", content);
}

function aplicar(branding: BrandingCacheado): void {
  const origin = window.location.origin;

  if (branding.icono192) ponerLink("icon", branding.icono192, "image/png");
  if (branding.iconoApple) ponerLink("apple-touch-icon", branding.iconoApple);

  // El nombre bajo el ícono en iOS sale de acá; en Android, del manifest.
  if (branding.nombre) ponerMeta("apple-mobile-web-app-title", branding.nombre);
  if (branding.colorTema) ponerMeta("theme-color", branding.colorTema);

  const iconos: IconoManifest[] = [];
  if (branding.icono192) {
    iconos.push({ src: branding.icono192, sizes: "192x192", type: "image/png", purpose: "any" });
  }
  if (branding.icono512) {
    iconos.push({ src: branding.icono512, sizes: "512x512", type: "image/png", purpose: "any" });
  }
  if (branding.icono512Maskable) {
    iconos.push({
      src: branding.icono512Maskable,
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    });
  }

  const manifest = construirManifestDeInstitucion({
    nombreInstitucion: branding.nombre,
    iconos,
    colorTema: branding.colorTema,
    origin,
  });

  const blob = new Blob([JSON.stringify(manifest)], { type: "application/manifest+json" });
  const url = URL.createObjectURL(blob);
  ponerLink("manifest", url);
  if (urlManifestActual) URL.revokeObjectURL(urlManifestActual);
  urlManifestActual = url;
}

/**
 * Pone el logo y el nombre de la institución del HOST en el favicon y en la app
 * instalada. En el despliegue general (sin institución en el host) no hace nada
 * y todo queda como está: ExamLab.
 */
export function useTenantPwaBranding(): void {
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const slug = subdomainTenantSlug(window.location.hostname);
    if (!slug) return;

    let cancelado = false;

    // Lo cacheado se aplica YA: rasterizar tarda, y en una recarga el ícono
    // correcto tiene que estar antes de que alguien toque "Instalar".
    const cache = leerCache(slug);
    if (cache) {
      try {
        aplicar(cache);
      } catch {
        /* que un ícono no rompa el arranque de la app */
      }
    }

    void (async () => {
      const info = await traerInstitucion(slug);
      if (cancelado || !info) return;

      // Sin cambios respecto de lo cacheado: no se re-rasteriza ni se toca el
      // DOM (cambiar el manifest de nuevo hace que Chrome lo vuelva a leer).
      if (
        cache &&
        cache.nombre === info.nombre &&
        cache.logoUrl === info.logoUrl &&
        cache.colorTema === info.colorTema
      ) {
        return;
      }

      let icono192: string | null = null;
      let icono512: string | null = null;
      let icono512Maskable: string | null = null;
      let iconoApple: string | null = null;

      if (info.logoUrl) {
        try {
          const img = await cargarImagen(info.logoUrl);
          if (cancelado) return;
          icono192 = rasterizar(img, LADO_ICONO_CHICO, FRACCION_SEGURA_ANY);
          icono512 = rasterizar(img, LADO_ICONO_GRANDE, FRACCION_SEGURA_ANY);
          icono512Maskable = rasterizar(img, LADO_ICONO_GRANDE, FRACCION_SEGURA_MASKABLE);
          iconoApple = rasterizar(img, LADO_APPLE_TOUCH, FRACCION_SEGURA_ANY);
        } catch {
          // Institución sin logo utilizable: se queda con el ícono de ExamLab,
          // pero el NOMBRE sí se aplica — distinguir la instalación es útil
          // aunque el dibujo sea el de la plataforma.
        }
      }

      const branding: BrandingCacheado = {
        nombre: info.nombre,
        colorTema: info.colorTema,
        logoUrl: info.logoUrl,
        icono192,
        icono512,
        icono512Maskable,
        iconoApple,
      };
      if (cancelado) return;
      try {
        aplicar(branding);
        guardarCache(slug, branding);
      } catch {
        /* idem: nunca romper por un ícono */
      }
    })();

    return () => {
      cancelado = true;
    };
  }, []);
}

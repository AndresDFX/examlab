/**
 * Marca de la institución para los documentos IMPRESOS de encuestas.
 *
 * ── De dónde sale la marca, y por qué de ahí ───────────────────────────
 * Hay dos fuentes en la base y no son intercambiables:
 *
 *   · `certificate_settings.institution_name` / `institution_logo_url` — lo que
 *     la institución configuró **para sus documentos**. Es lo que ya usan los
 *     certificados y las plantillas de informe.
 *   · `tenants.name` / `logo_url` / `logo_path` — la marca de la **aplicación**
 *     (sidebar, colores del theme).
 *
 * Se prefiere la primera y se cae a la segunda. Así una hoja de resultados sale
 * con el mismo encabezado que un certificado y que un informe del mismo curso:
 * si se leyera solo del tenant, tres documentos de la misma institución podrían
 * mostrar tres nombres distintos, y el que se imprime para una reunión sería el
 * único desalineado.
 *
 * El color SÍ sale del tenant: `certificate_settings` no guarda color, y
 * `primary_color` es el color de marca que la institución ya eligió y ve en toda
 * la app.
 *
 * El logo del tenant puede vivir en Storage (`logo_path`), así que se resuelve
 * con `resolveTenantLogoUrl` en vez de leer `logo_url` a secas — leerlo directo
 * daba `null` en las instituciones que subieron su logo por el panel, y el
 * documento salía sin marca sin que nadie entendiera por qué.
 */
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useTenant } from "@/modules/tenants/use-tenant";
import { resolveTenantLogoUrl } from "@/modules/tenants/tenant";
import type { MarcaImpresion } from "./print-results";

export function usePrintBrand(): MarcaImpresion {
  const { tenant } = useTenant();
  const [doc, setDoc] = useState<{ nombre: string | null; logo: string | null }>({
    nombre: null,
    logo: null,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data } = await supabase
        .from("certificate_settings")
        .select("institution_name, institution_logo_url")
        .maybeSingle();
      if (cancelled) return;
      setDoc({
        nombre: data?.institution_name ?? null,
        logo: data?.institution_logo_url ?? null,
      });
    })();
    return () => {
      cancelled = true;
    };
    // Se re-lee al cambiar de institución (el SuperAdmin con override activo).
  }, [tenant?.id]);

  return {
    institucion: doc.nombre ?? tenant?.name ?? "",
    logoUrl: doc.logo ?? resolveTenantLogoUrl(tenant, supabase),
    colorPrimario: tenant?.primary_color ?? null,
  };
}

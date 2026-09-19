/**
 * El manejador de «Publicar» / «Volver a borrador» de una fila del grid.
 *
 * Vive acá y no copiado en cada pantalla porque lo que NO puede diferir entre
 * talleres, exámenes y proyectos es justo lo delicado: que publicar confirme
 * antes (le llega un aviso al estudiante, y eso no se deshace aunque el estado
 * sí), y que el texto de esa confirmación diga la verdad sobre CUÁNDO le llega.
 *
 * La decisión de qué transición ofrecer y cuándo avisa el trigger vive en
 * `publicacion.ts`, que es puro y está testeado. Acá solo está el efecto.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import { avisoAlPublicar, CATEGORIA_DE_TABLA, type Transicion } from "@/shared/lib/publicacion";

export type TablaPublicable = "workshops" | "exams" | "projects";

export interface FilaPublicable {
  id: string;
  /** Lo que el docente reconoce en la confirmación y en el toast. */
  titulo: string;
  /** `start_date` en talleres y proyectos, `start_time` en exámenes. */
  inicio?: string | null;
}

export function useCambiarPublicacion(
  tabla: TablaPublicable,
  alTerminar: () => void | Promise<void>,
) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [cambiandoId, setCambiandoId] = useState<string | null>(null);

  const cambiar = async (fila: FilaPublicable, transicion: Transicion) => {
    if (cambiandoId) return;
    const publicando = transicion.clave === "publicar";

    // Si la categoría está apagada en el panel de Notificaciones, publicar NO
    // avisa a nadie (mig 20262300000000) y el diálogo tiene que decirlo. Se lee
    // acá y no una vez al montar la pantalla porque un Admin puede cambiarlo
    // mientras el docente tiene la lista abierta, y prometer de más es
    // justamente el error que este diálogo existe para evitar.
    //
    // `email_settings` es legible por cualquier autenticado (policy
    // `email_settings_select`, `USING (true)`) y en esa tabla no hay secretos:
    // las credenciales SMTP viven en `tenant_email_settings`.
    let categoriaActiva = true;
    if (publicando) {
      const { data } = await supabase
        .from("email_settings")
        .select("enabled_kinds")
        .eq("id", 1)
        .maybeSingle();
      const kinds = (data as { enabled_kinds?: Record<string, boolean> } | null)?.enabled_kinds;
      // Clave AUSENTE = encendida, igual que el trigger y que el edge: se exige
      // el literal `false`. Y si la consulta falla, se asume encendida — decir
      // «no se avisa» cuando sí se avisa es el error caro de los dos.
      if (kinds && kinds[CATEGORIA_DE_TABLA[tabla]] === false) categoriaActiva = false;
    }

    const ok = await confirm({
      title: publicando
        ? t("publicacion.confirmPublishTitle", { nombre: fila.titulo })
        : t("publicacion.confirmDraftTitle", { nombre: fila.titulo }),
      description: publicando
        ? {
            ahora: t("publicacion.confirmPublishNow"),
            cuandoSeAcerque: t("publicacion.confirmPublishLater"),
            silenciado: t("publicacion.confirmPublishSilenced"),
          }[avisoAlPublicar(fila.inicio, new Date(), categoriaActiva)]
        : t("publicacion.confirmDraftBody"),
      confirmLabel: publicando ? t("publicacion.publish") : t("publicacion.backToDraft"),
      // `warning` y no `destructive`: no se pierde nada, pero el aviso que sale
      // al publicar no se puede retirar aunque después se vuelva a borrador.
      tone: "warning",
    });
    if (!ok) return;

    setCambiandoId(fila.id);
    try {
      const { error } = await supabase
        .from(tabla)
        .update({ status: transicion.a })
        .eq("id", fila.id);
      if (error) {
        toast.error(friendlyError(error));
        return;
      }
      toast.success(
        publicando
          ? t("publicacion.published", { nombre: fila.titulo })
          : t("publicacion.backToDraftDone", { nombre: fila.titulo }),
      );
      await alTerminar();
    } catch (e) {
      toast.error(friendlyError(e));
    } finally {
      setCambiandoId(null);
    }
  };

  return { cambiar, cambiandoId };
}

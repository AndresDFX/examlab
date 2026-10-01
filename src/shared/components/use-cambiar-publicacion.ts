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
import { createElement, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { unirLista } from "@/shared/lib/unir-lista";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { friendlyError } from "@/shared/lib/db-errors";
import {
  avisoAlPublicar,
  avisosAlPublicarVarias,
  CATEGORIA_DE_TABLA,
  planDePublicacionMasiva,
  type AccionMasiva,
  type Transicion,
} from "@/shared/lib/publicacion";

export type TablaPublicable = "workshops" | "exams" | "projects";

export interface FilaPublicable {
  id: string;
  /** Lo que el docente reconoce en la confirmación y en el toast. */
  titulo: string;
  /** `start_date` en talleres y proyectos, `start_time` en exámenes. */
  inicio?: string | null;
}

/** Una fila seleccionada para la acción masiva. */
export interface FilaMasiva extends FilaPublicable {
  status: string | null | undefined;
  /** Todos sus cursos están en borrador (ver `curso-borrador.ts`). */
  cursoEnBorrador?: boolean;
}

export function useCambiarPublicacion(
  tabla: TablaPublicable,
  alTerminar: () => void | Promise<void>,
) {
  const { t, i18n } = useTranslation();
  const confirm = useConfirm();
  const [cambiandoId, setCambiandoId] = useState<string | null>(null);
  const [cambiandoVarios, setCambiandoVarios] = useState(false);

  // Si la categoría está apagada en el panel de Notificaciones, publicar NO
  // avisa a nadie (mig 20262300000000) y el diálogo tiene que decirlo. Se lee
  // al confirmar y no una vez al montar la pantalla porque un Admin puede
  // cambiarlo mientras el docente tiene la lista abierta, y prometer de más es
  // justamente el error que este diálogo existe para evitar.
  //
  // `email_settings` es legible por cualquier autenticado (policy
  // `email_settings_select`, `USING (true)`) y en esa tabla no hay secretos:
  // las credenciales SMTP viven en `tenant_email_settings`.
  const leerCategoriaActiva = async (): Promise<boolean> => {
    const { data } = await supabase
      .from("email_settings")
      .select("enabled_kinds")
      .eq("id", 1)
      .maybeSingle();
    const kinds = (data as { enabled_kinds?: Record<string, boolean> } | null)?.enabled_kinds;
    // Clave AUSENTE = encendida, igual que el trigger y que el edge: se exige
    // el literal `false`. Y si la consulta falla, se asume encendida — decir
    // «no se avisa» cuando sí se avisa es el error caro de los dos.
    return !(kinds && kinds[CATEGORIA_DE_TABLA[tabla]] === false);
  };

  const cambiar = async (fila: FilaPublicable, transicion: Transicion) => {
    if (cambiandoId || cambiandoVarios) return;
    const publicando = transicion.clave === "publicar";
    const categoriaActiva = publicando ? await leerCategoriaActiva() : true;

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

  /**
   * Publicar o volver a borrador varias filas a la vez. Cambia solo lo que la
   * fila ofrecería por sí sola (`planDePublicacionMasiva`) y dice qué omite.
   * Es UN update: si la base rechaza una (su curso pasó a borrador mientras la
   * lista estaba abierta), no cambia ninguna y se muestra el motivo.
   */
  const cambiarVarios = async (
    filas: readonly FilaMasiva[],
    accion: AccionMasiva,
    nombres: { singular: string; plural: string },
  ): Promise<boolean> => {
    if (cambiandoId || cambiandoVarios) return false;
    const publicando = accion === "publicar";
    const plan = planDePublicacionMasiva(filas, accion);
    const idioma = i18n.language || "es-CO";

    const omitidas: string[] = [];
    if (plan.yaEstaban > 0) {
      omitidas.push(
        t(publicando ? "publicacion.masiva.omitYaPublicadas" : "publicacion.masiva.omitYaBorrador", {
          count: plan.yaEstaban,
        }),
      );
    }
    if (plan.cerradas > 0) omitidas.push(t("publicacion.masiva.omitCerradas", { count: plan.cerradas }));
    if (plan.enCursoBorrador > 0) {
      omitidas.push(t("publicacion.masiva.omitCursoBorrador", { count: plan.enCursoBorrador }));
    }

    if (plan.ids.length === 0) {
      toast.info(t("publicacion.masiva.nada", { motivo: unirLista(omitidas, idioma) }));
      return false;
    }

    const count = plan.ids.length;
    const parrafos: string[] = [];
    if (publicando) {
      const aCambiar = new Set(plan.ids);
      const avisos = avisosAlPublicarVarias(
        filas.filter((f) => aCambiar.has(f.id)).map((f) => f.inicio),
        new Date(),
        await leerCategoriaActiva(),
      );
      if (avisos.silenciado) parrafos.push(t("publicacion.masiva.avisoSilenciado", { count }));
      else if (avisos.cuandoSeAcerque === 0) parrafos.push(t("publicacion.masiva.avisoAhora", { count }));
      else if (avisos.ahora === 0) parrafos.push(t("publicacion.masiva.avisoLuego", { count }));
      // Mixto solo ocurre con dos o más: siempre plural.
      else parrafos.push(t("publicacion.masiva.avisoMixto", { count: avisos.ahora }));
    } else {
      parrafos.push(t("publicacion.masiva.borradorCuerpo", { count }));
    }
    if (omitidas.length > 0) {
      parrafos.push(t("publicacion.masiva.omitidas", { lista: unirLista(omitidas, idioma) }));
    }

    const entidad = count === 1 ? nombres.singular : nombres.plural;
    const ok = await confirm({
      title: t(publicando ? "publicacion.masiva.tituloPublicar" : "publicacion.masiva.tituloBorrador", {
        count,
        entidad,
      }),
      // `span` y no `div`/`p`: la descripción del diálogo ya es un <p>.
      description: createElement(
        "span",
        { className: "block space-y-2" },
        parrafos.map((p, i) => createElement("span", { key: i, className: "block" }, p)),
      ),
      confirmLabel: publicando ? t("publicacion.publish") : t("publicacion.backToDraft"),
      // Mismo tono que la fila: nada se pierde, pero un aviso enviado no vuelve.
      tone: "warning",
    });
    if (!ok) return false;

    setCambiandoVarios(true);
    try {
      const { error } = await supabase
        .from(tabla)
        .update({ status: publicando ? "published" : "draft" })
        .in("id", plan.ids);
      if (error) {
        toast.error(friendlyError(error), { duration: 12000 });
        return false;
      }
      toast.success(
        t(publicando ? "publicacion.masiva.publicadas" : "publicacion.masiva.enBorrador", { count, entidad }),
      );
      await alTerminar();
      return true;
    } catch (e) {
      toast.error(friendlyError(e), { duration: 12000 });
      return false;
    } finally {
      setCambiandoVarios(false);
    }
  };

  return { cambiar, cambiandoId, cambiarVarios, cambiandoVarios };
}

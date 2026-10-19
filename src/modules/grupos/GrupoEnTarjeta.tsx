/**
 * La parte de la tarjeta de un taller o proyecto que habla del grupo del
 * estudiante: con quién está, o el botón para armar uno cuando los grupos los
 * arman los estudiantes. Lo que decide qué mostrar es `grupoEnLaTarjeta`, y
 * dónde, `grupoEnTarjetaMuestraAlgo`.
 *
 * Va en dos lugares de la tarjeta, y por eso tiene dos variantes:
 * - `accion`: el botón «Armar grupo» como LA acción de la tarjeta, solo en
 *   grupal estricto (sin grupo no hay «Iniciar entrega»).
 * - `detalle`: lo que va detrás de «Ver más» — con quién está (y gestionarlo),
 *   o la explicación de por qué armar uno; en mixto, armarlo es optativo y su
 *   botón vive acá.
 *
 * La ventana «Mi grupo» NO la monta esta pieza sino la lista, UNA para todas sus
 * tarjetas (`onAbrir`). Montada acá, al crear el grupo se desmontaba con la
 * ventana abierta: la acción de la tarjeta pasa de «Armar grupo» a «Iniciar
 * entrega» y esta pieza deja de existir.
 */
import { useTranslation } from "react-i18next";
import { UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  grupoEnLaTarjeta,
  grupoEnTarjetaMuestraAlgo,
  type ResumenDeGrupo,
} from "@/modules/grupos/grupos-estudiante";

interface GrupoEnTarjetaProps {
  variante: "accion" | "detalle";
  resumen: ResumenDeGrupo | undefined;
  /** Abre «Mi grupo» de esta actividad. */
  onAbrir: () => void;
}

export function GrupoEnTarjeta({ variante, resumen, onAbrir }: Readonly<GrupoEnTarjetaProps>) {
  const { t } = useTranslation();
  if (!grupoEnTarjetaMuestraAlgo(variante, resumen)) return null;
  const vista = grupoEnLaTarjeta(resumen);

  if (variante === "accion") {
    return (
      <Button size="sm" className="w-full min-w-0" onClick={onAbrir}>
        <UsersRound className="h-4 w-4 mr-1" />
        <span className="min-w-0 truncate">{t("gruposEstudiante.armarGrupo")}</span>
      </Button>
    );
  }

  if (vista.tipo === "con_grupo") {
    return (
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-1.5 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            <UsersRound className="h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">
              {t("gruposEstudiante.tarjetaConGrupo", {
                nombre: vista.nombre,
                count: vista.integrantes,
              })}
            </span>
          </span>
          <Button variant="ghost" size="sm" className="h-8 shrink-0 px-2 text-xs" onClick={onAbrir}>
            {vista.puedeCambiar ? t("gruposEstudiante.gestionar") : t("gruposEstudiante.ver")}
          </Button>
        </div>
        {vista.bajoElMinimo && (
          <p className="text-2xs text-warning-on-subtle">
            {t("gruposEstudiante.bajoElMinimo", { minimo: vista.minimo })}
          </p>
        )}
      </div>
    );
  }

  if (vista.tipo !== "armar") return null;
  return (
    <div
      className={
        vista.estricto
          ? "space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3"
          : "space-y-2 rounded-md border bg-muted/30 p-3"
      }
    >
      <p
        className={
          vista.estricto ? "text-xs text-warning-on-subtle" : "text-xs text-muted-foreground"
        }
      >
        {vista.estricto
          ? t("gruposEstudiante.tarjetaEstricto")
          : t("gruposEstudiante.tarjetaMixto")}
      </p>
      {/* En estricto el botón ya es la acción de la tarjeta; en mixto es
          optativo y va acá. */}
      {!vista.estricto && (
        <Button size="sm" variant="outline" className="w-full" onClick={onAbrir}>
          <UsersRound className="h-4 w-4 mr-1" />
          {t("gruposEstudiante.armarGrupo")}
        </Button>
      )}
    </div>
  );
}

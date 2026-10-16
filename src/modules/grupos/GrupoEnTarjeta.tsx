/**
 * La parte de la tarjeta de un taller o proyecto que habla del grupo del
 * estudiante: con quién está, o el botón para armar uno cuando los grupos los
 * arman los estudiantes. Lo que decide qué mostrar es `grupoEnLaTarjeta`.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  grupoEnLaTarjeta,
  type ResumenDeGrupo,
  type TipoActividadGrupal,
} from "@/modules/grupos/grupos-estudiante";
import { MiGrupoDialog } from "@/modules/grupos/MiGrupoDialog";

interface GrupoEnTarjetaProps {
  tipo: TipoActividadGrupal;
  actividadId: string;
  actividadTitulo: string;
  resumen: ResumenDeGrupo | undefined;
  /** El grupo cambió: la lista vuelve a cargar el grupo y la entrega de la tarjeta. */
  onCambio: () => void;
}

export function GrupoEnTarjeta({
  tipo,
  actividadId,
  actividadTitulo,
  resumen,
  onCambio,
}: Readonly<GrupoEnTarjetaProps>) {
  const { t } = useTranslation();
  const [abierta, setAbierta] = useState(false);
  const vista = grupoEnLaTarjeta(resumen);
  if (vista.tipo === "nada") return null;

  return (
    <>
      {vista.tipo === "con_grupo" ? (
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
            <Button
              variant="ghost"
              size="sm"
              className="h-8 shrink-0 px-2 text-xs"
              onClick={() => setAbierta(true)}
            >
              {vista.puedeCambiar ? t("gruposEstudiante.gestionar") : t("gruposEstudiante.ver")}
            </Button>
          </div>
          {vista.bajoElMinimo && (
            <p className="text-2xs text-warning-on-subtle">
              {t("gruposEstudiante.bajoElMinimo", { minimo: vista.minimo })}
            </p>
          )}
        </div>
      ) : (
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
          {/* En grupal estricto, armar el grupo ES la acción de la tarjeta (sin
              grupo no hay «Iniciar entrega»); en mixto es secundaria. */}
          <Button
            size="sm"
            variant={vista.estricto ? "default" : "outline"}
            className="w-full"
            onClick={() => setAbierta(true)}
          >
            <UsersRound className="h-4 w-4 mr-1" />
            {t("gruposEstudiante.armarGrupo")}
          </Button>
        </div>
      )}
      <MiGrupoDialog
        tipo={tipo}
        actividadId={actividadId}
        actividadTitulo={actividadTitulo}
        open={abierta}
        onOpenChange={setAbierta}
        onCambio={onCambio}
      />
    </>
  );
}

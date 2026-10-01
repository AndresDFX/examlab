import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Spinner } from "@/components/ui/spinner";
import { borradorInicialDeGrupo, resumenDeGrupo } from "./nota-de-grupo";
import type { IntegranteACalificar, NotaGuardada, useCalificarGrupo } from "./use-calificar-grupo";

interface Props {
  grupoId: string;
  nombre: string;
  integrantes: IntegranteACalificar[];
  /** Tope de la escala del curso. */
  escala: number;
  calificar: ReturnType<typeof useCalificarGrupo>["calificar"];
  /** Grupo que se está guardando (de cualquier tarjeta): uno a la vez. */
  guardando: string | null;
  onGuardada: (userId: string, nota: NotaGuardada) => void;
}

/**
 * La nota de un grupo, OPCIONAL, dentro de su tarjeta en la ventana de grupos
 * de una actividad externa: la exposición se califica mientras se arman los
 * grupos, sin abrir «Notas externas». Mientras no se toque, el campo muestra
 * la nota que ya comparten todos sus integrantes; si difieren, queda vacío.
 */
export function NotaDeGrupoInline({
  grupoId,
  nombre,
  integrantes,
  escala,
  calificar,
  guardando,
  onGuardada,
}: Props) {
  const { t } = useTranslation();
  /** `undefined` = sin tocar: se muestra la nota común del grupo. */
  const [borrador, setBorrador] = useState<number | null | undefined>(undefined);
  const valor = borrador === undefined ? borradorInicialDeGrupo(integrantes).grade : borrador;
  const r = resumenDeGrupo(integrantes);

  const guardar = async () => {
    const ok = await calificar({
      grupoId,
      nombre,
      integrantes,
      borrador: { grade: valor, feedback: "" },
      maximo: escala,
      onGuardada,
    });
    if (ok) setBorrador(undefined);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
      <span className="text-2xs font-medium">{t("gruposNota.label")}</span>
      <DecimalInput
        min={0}
        max={escala}
        value={valor}
        onChange={(v) => setBorrador(v)}
        placeholder="—"
        className="h-8 w-20 text-sm"
        aria-label={t("externalGrades.groupGradeAria", { group: nombre })}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs"
        onClick={() => void guardar()}
        disabled={valor == null || guardando != null}
        title={t("externalGrades.gradeGroupTitle", { count: integrantes.length, group: nombre })}
      >
        {guardando === grupoId ? (
          <Spinner size="sm" className="mr-1" />
        ) : (
          <Save className="h-3.5 w-3.5 mr-1" />
        )}
        {t("gruposNota.guardar")}
      </Button>
      <span className="text-2xs text-muted-foreground">
        {t("externalGrades.groupStatus", { graded: r.conNota, count: r.total })}
        {r.distintas && ` · ${t("externalGrades.groupDistinct")}`}
      </span>
    </div>
  );
}

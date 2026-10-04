import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DecimalInput } from "@/components/ui/decimal-input";
import { Spinner } from "@/components/ui/spinner";
import { borradorInicialDeGrupo, resumenDeGrupo } from "./nota-de-grupo";
import type { IntegranteACalificar, NotaGuardada, useCalificarGrupo } from "./use-calificar-grupo";

type Calificar = ReturnType<typeof useCalificarGrupo>["calificar"];

export interface GrupoACalificar {
  grupoId: string;
  nombre: string;
  integrantes: IntegranteACalificar[];
}

/**
 * Los borradores de nota de TODAS las tarjetas de la ventana de grupos, para
 * poder guardarlos de una vez. Viven en la ventana y no en cada tarjeta porque
 * «Guardar todas» tiene que saber qué escribió el docente en cada una; con el
 * estado adentro de la tarjeta había que pulsar «Guardar» grupo por grupo.
 *
 * Cada grupo se guarda con el MISMO `calificar` que usa su botón, así que la
 * pregunta antes de pisar una nota distinta se sigue haciendo, grupo por grupo.
 */
export function useNotasDeGrupos(calificar: Calificar, escala: number) {
  const { t } = useTranslation();
  /** `undefined` (ausente) = sin tocar: la tarjeta muestra la nota común. */
  const [borradores, setBorradores] = useState<Record<string, number | null>>({});
  const [guardandoTodas, setGuardandoTodas] = useState(false);
  /** Cuántas se mandaron a guardar: el botón muestra ese número hasta terminar. */
  const [enCurso, setEnCurso] = useState(0);

  const setBorrador = (grupoId: string, v: number | null | undefined) =>
    setBorradores((prev) => {
      const next = { ...prev };
      if (v === undefined) delete next[grupoId];
      else next[grupoId] = v;
      return next;
    });

  /**
   * Grupos con una nota escrita y sin guardar: distinta de la que ya comparten.
   * Un borrador devuelto a la nota común no cuenta (no hay nada que cambiar),
   * aunque el botón de su tarjeta sí deje volver a guardarlo.
   */
  const pendientes = (grupos: readonly GrupoACalificar[]) =>
    grupos.filter((g) => {
      if (!(g.grupoId in borradores) || g.integrantes.length === 0) return false;
      const v = borradores[g.grupoId];
      return v != null && v !== borradorInicialDeGrupo(g.integrantes).grade;
    });

  const guardarTodas = async (
    grupos: readonly GrupoACalificar[],
    onGuardada: (userId: string, nota: NotaGuardada) => void,
  ) => {
    const lista = pendientes(grupos);
    if (lista.length === 0) return;
    setGuardandoTodas(true);
    setEnCurso(lista.length);
    let guardados = 0;
    try {
      // En serie: cada grupo puede pedir confirmación antes de pisar una nota, y
      // dos diálogos a la vez no se pueden responder.
      for (const g of lista) {
        const ok = await calificar({
          grupoId: g.grupoId,
          nombre: g.nombre,
          integrantes: g.integrantes,
          borrador: { grade: borradores[g.grupoId], feedback: "" },
          maximo: escala,
          onGuardada,
          silencioso: true,
        });
        if (ok) {
          guardados += 1;
          setBorrador(g.grupoId, undefined);
        }
      }
    } finally {
      setGuardandoTodas(false);
    }
    if (guardados === lista.length) {
      toast.success(t("gruposNota.guardadasTodas", { count: guardados }));
    } else {
      // También con 0: si el docente no confirmó ninguno, el botón no puede
      // quedar como si no hubiera hecho nada.
      toast.warning(t("gruposNota.guardadasParcial", { saved: guardados, total: lista.length }));
    }
  };

  return { borradores, setBorrador, pendientes, guardarTodas, guardandoTodas, enCurso };
}

/** «Guardar todas las notas (N)»: solo aparece si hay alguna escrita sin guardar. */
export function GuardarNotasDeGrupos({
  cantidad,
  guardando,
  onGuardar,
}: {
  cantidad: number;
  guardando: boolean;
  onGuardar: () => void;
}) {
  const { t } = useTranslation();
  if (cantidad === 0 && !guardando) return null;
  return (
    <Button size="sm" variant="secondary" onClick={onGuardar} disabled={guardando}>
      {guardando ? <Spinner size="sm" className="mr-1" /> : <Save className="h-4 w-4 mr-1" />}
      {t("gruposNota.guardarTodas", { count: cantidad })}
    </Button>
  );
}

interface Props {
  grupoId: string;
  nombre: string;
  integrantes: IntegranteACalificar[];
  /** Tope de la escala del curso. */
  escala: number;
  calificar: Calificar;
  /** Grupo que se está guardando (de cualquier tarjeta): uno a la vez. */
  guardando: string | null;
  onGuardada: (userId: string, nota: NotaGuardada) => void;
  /** Lo escrito y sin guardar; `undefined` = sin tocar. Lo tiene la ventana. */
  borrador: number | null | undefined;
  onBorrador: (v: number | null | undefined) => void;
  /** Mientras se guardan todas, ninguna tarjeta guarda por su cuenta. */
  bloqueado?: boolean;
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
  borrador,
  onBorrador,
  bloqueado = false,
}: Props) {
  const { t } = useTranslation();
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
    if (ok) onBorrador(undefined);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
      <span className="text-2xs font-medium">{t("gruposNota.label")}</span>
      <DecimalInput
        min={0}
        max={escala}
        value={valor}
        onChange={(v) => onBorrador(v)}
        placeholder="—"
        className="h-8 w-20 text-sm"
        aria-label={t("externalGrades.groupGradeAria", { group: nombre })}
      />
      <Button
        size="sm"
        variant="outline"
        className="h-8 text-xs"
        onClick={() => void guardar()}
        disabled={valor == null || guardando != null || bloqueado}
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

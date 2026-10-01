import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useConfirm } from "@/shared/components/ConfirmDialog";
import { formatNumber } from "@/shared/lib/format";
import {
  conflictosAlCalificarGrupo,
  planDeNotaDeGrupo,
  type FilaDeNotaConGrupo,
} from "./nota-de-grupo";
import { escribirNotaExterna, type TipoDeActividadExterna } from "./notas-externas";

export interface IntegranteACalificar extends FilaDeNotaConGrupo {
  submissionId: string | null;
}

export interface NotaGuardada {
  submissionId: string | null;
  grade: number;
  feedback: string;
}

/**
 * «Calificar al grupo» en una actividad EXTERNA: la misma nota para cada
 * integrante (ver nota-de-grupo.ts). Lo usan «Notas externas» y la ventana de
 * grupos; con dos copias, la pregunta antes de pisar una nota distinta —lo que
 * protege el ajuste individual del que no se presentó— terminaría existiendo
 * en una sola.
 */
export function useCalificarGrupo(tipo: TipoDeActividadExterna, refId: string) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  /** Grupo que se está guardando, para el spinner de su botón. */
  const [guardando, setGuardando] = useState<string | null>(null);

  const calificar = async (args: {
    grupoId: string;
    nombre: string;
    integrantes: readonly IntegranteACalificar[];
    borrador: { grade: number | null; feedback: string };
    /** Tope de la escala del curso. */
    maximo: number;
    /** Por cada integrante guardado: para que la pantalla refleje lo nuevo. */
    onGuardada: (userId: string, nota: NotaGuardada) => void;
  }): Promise<boolean> => {
    const { grupoId, nombre, integrantes, borrador, maximo, onGuardada } = args;
    if (integrantes.length === 0) return false;
    const nota = borrador.grade;
    if (nota == null || Number.isNaN(nota)) {
      toast.error(t("externalGrades.groupNeedsGrade"));
      return false;
    }
    if (nota < 0 || nota > maximo) {
      toast.error(
        t("externalGrades.toastSaveFailed", {
          name: nombre,
          error:
            nota < 0
              ? t("externalGrades.errorNoteNegative")
              : t("externalGrades.errorNoteMax", { max: maximo }),
        }),
      );
      return false;
    }
    const plan = planDeNotaDeGrupo(integrantes, borrador);
    const conflictos = conflictosAlCalificarGrupo(integrantes, nota);
    if (conflictos.length > 0) {
      const ok = await confirm({
        title: t("externalGrades.groupReplaceTitle", { group: nombre }),
        description: t("externalGrades.groupReplaceBody", {
          count: conflictos.length,
          list: conflictos
            .map(
              (c) => `${c.fila.fullName} (${formatNumber(c.nota, { maximumFractionDigits: 2 })})`,
            )
            .join(", "),
          grade: formatNumber(nota, { maximumFractionDigits: 2 }),
        }),
        confirmLabel: t("externalGrades.groupReplaceConfirm"),
        tone: "warning",
      });
      if (!ok) return false;
    }

    setGuardando(grupoId);
    let guardadas = 0;
    let primerError: { name: string; error: string } | null = null;
    try {
      for (const p of plan) {
        const r = await escribirNotaExterna(tipo, refId, {
          userId: p.fila.userId,
          submissionId: p.fila.submissionId,
          grade: p.grade,
          feedback: p.feedback,
        });
        if (!r.ok) {
          if (!primerError) primerError = { name: p.fila.fullName, error: r.error };
          continue;
        }
        guardadas += 1;
        onGuardada(p.fila.userId, {
          submissionId: r.submissionId,
          grade: p.grade,
          feedback: p.feedback,
        });
      }
    } finally {
      setGuardando(null);
    }
    if (primerError) {
      toast.error(
        t("externalGrades.groupSavedPartial", {
          group: nombre,
          saved: guardadas,
          total: plan.length,
          name: primerError.name,
          error: primerError.error,
        }),
        { duration: 12000 },
      );
      return false;
    }
    toast.success(t("externalGrades.groupSaved", { group: nombre, count: guardadas }));
    return true;
  };

  return { calificar, guardando };
}

/**
 * Qué muestra la tarjeta de un examen en la lista del ESTUDIANTE: el intento que manda su estado, la
 * nota y a qué examen lleva «Ver detalle».
 *
 * La lista tomaba la PRIMERA entrega que devolvía la base y mostraba su nota. Con dos intentos eso es
 * uno cualquiera: un estudiante con 2,6 y 4,8 en un examen de modo «más alto» veía 2,6 en la tarjeta
 * y 4,8 en «Ver detalle» (reportado el 2026-10-13). La nota del detalle, la de «Mis notas» y la del
 * libro salen de `notaDeExamenParaEstudiante` —el modo del examen (`retry_mode`) más los supletorios y
 * recuperatorios—, así que la tarjeta usa esa misma función y no puede volver a diferir.
 *
 * El intento que manda el ESTADO de la tarjeta (entregado, en curso, por calificar) es el más
 * reciente: es el que muestra el detalle («el detalle es el último»), y con «la primera fila» un
 * intento nuevo en curso podía quedar escondido detrás del anterior. Sin intentos propios, el de una
 * recuperación vigente (una devuelta a borrador no cuenta para la nota, así que tampoco manda).
 */
import type { AttemptForGrade } from "@/modules/exams/exam-attempts";
import {
  notaDeExamenParaEstudiante,
  recuperacionVigente,
  type FilaDeExamen,
} from "@/modules/grading/nota-con-recuperacion";

export function tarjetaDeExamen<I extends AttemptForGrade & { exam_id: string }>(
  examen: FilaDeExamen,
  examenes: readonly FilaDeExamen[],
  intentos: readonly I[],
): { intento: I | undefined; nota: number | null; examIdRevision: string } {
  const propios = intentos.filter((i) => i.exam_id === examen.id);
  const recuperaciones = new Set(
    examenes.filter((e) => e.parent_exam_id === examen.id && recuperacionVigente(e)).map((e) => e.id),
  );
  const candidatos = propios.length ? propios : intentos.filter((i) => recuperaciones.has(i.exam_id));
  const intento = candidatos.reduce<I | undefined>(
    (ultimo, i) => (!ultimo || new Date(i.created_at).getTime() > new Date(ultimo.created_at).getTime() ? i : ultimo),
    undefined,
  );
  const resuelta = notaDeExamenParaEstudiante(examen, examenes, intentos);
  // «Ver detalle» abre la revisión con ese examen como raíz. Con intentos propios es el mismo examen:
  // su revisión pliega las recuperaciones igual que acá. Sin intentos propios va al examen de donde
  // salió la nota (`examIdFuente`): con dos recuperaciones, la del intento más reciente puede no ser
  // la que cuenta, y su revisión mostraría otro número.
  const examIdRevision = propios.length
    ? examen.id
    : (resuelta.examIdFuente ?? intento?.exam_id ?? examen.id);
  return { intento, nota: resuelta.nota, examIdRevision };
}
